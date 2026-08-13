// The four checks resources/instruction-registry/README.md says a lint
// server should run against every instruction call found in a RUNG:
//   1. Is the name known at all?
//   2. Are all `required: true` pins present?
//   3. Are there pins in the call that aren't in the registry?
//   4. If `template.shape != none`, is a matching S7_Templates attribute
//      present in the right shape? (error if confidence: confirmed-compiled,
//      warning otherwise)
// Plus one more, `checkEnEno`, consuming a registry field the README's own
// four checks predate: flags a call's `S7_GenerateENO` pragma when the
// entry's `enEno.eno.present` is CONFIRMED `false` (an instruction that
// structurally has no ENO output at all) -- see that function's own
// comment for why this is the complementary half of what `checkTemplate`
// already covers (a MISSING required pragma), not a duplicate of it.
import { BlockIndex } from "../analysis/blockIndex";
import { CallNode, ParsedBlockFile } from "../parser/s7dclParser";
import { typeRefTopLevelName } from "../parser/typeRef";
import { InstructionEntry, RuleSet } from "../rules/types";
import { formatDiagnostic, LintDiagnostic, LintSeverity, RegistryFix } from "./diagnostics";

export type { LintDiagnostic, LintSeverity } from "./diagnostics";

/** The `unknown-instruction` Quick Fix payload for `call`, or undefined when
 * this call shape can't be scaffolded from the source alone. A plain
 * `Name(...)` call is always self-contained. A LAD/FBD `#inst.Name(...)`
 * call additionally qualifies when its VAR declaration supplied the
 * `instanceType`; the caller passes that resolved type in explicitly. */
export function unknownInstructionFix(call: CallNode, isScl: boolean, instanceType?: string): RegistryFix | undefined {
  if (!call.name || call.externalName !== undefined || (call.instancePrefix && !instanceType)) return undefined;
  const pins: { name: string; dir: "in" | "out" | "inout" }[] = [];
  for (const p of call.pins) {
    if (p.name && !pins.some((existing) => existing.name === p.name)) {
      // SCL's `:=` cannot distinguish input from inout, so retain the old
      // conservative input placeholder there. LAD/FBD's `=>` does prove an
      // output and is valuable information when scaffolding an instance.
      pins.push({ name: p.name, dir: isScl ? "in" : p.dir === "out" ? "out" : "in" });
    }
  }
  return {
    kind: "unknown-instruction",
    instructionName: call.name,
    scl: isScl,
    callShape: call.instancePrefix ? "instance-dot" : "box",
    ...(instanceType ? { instanceType } : {}),
    pins,
  };
}

interface ParsedTemplateValue {
  shape: "single" | "bracketed";
  keys: string[];
  values: string[];
}

/** Interprets an `S7_Templates` pragma VALUE string (already quote-stripped
 * by parsePragmaBlock), e.g. `SrcType := Time` (single) or
 * `[SrcType := LReal, DestType := Real]` (bracketed) -- see
 * docs/fbd-knowhow/00-Overview.md's own worked examples. */
function parseTemplateValue(value: string): ParsedTemplateValue {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    const keys: string[] = [];
    const values: string[] = [];
    for (const seg of inner.split(",")) {
      const [k, v] = seg.split(":=");
      if (k?.trim()) {
        keys.push(k.trim());
        values.push((v ?? "").trim());
      }
    }
    return { shape: "bracketed", keys, values };
  }
  const [k, v] = trimmed.split(":=");
  const key = k?.trim();
  return { shape: "single", keys: key ? [key] : [], values: key ? [(v ?? "").trim()] : [] };
}

/** Validates an `S7_Templates` value against known type names --
 * base-types.yaml, system-types.yaml, or (conversion instructions only)
 * bcd-formats.yaml's BCD16/BCD32, which are explicitly NOT valid VAR/STRUCT
 * Datatypes but ARE valid template values. Returns `undefined` (valid, or
 * "don't know, don't guess") unless the name is confidently unrecognized. */
function checkTemplateValue(typeName: string, ruleSet: RuleSet): string | undefined {
  if (!typeName) return undefined; // empty/malformed -- template-shape-mismatch already covers this
  if (typeName in ruleSet.baseTypes || typeName in ruleSet.systemTypes || typeName in ruleSet.bcdFormats) return undefined;
  return `'${typeName}' isn't a recognized base-types.yaml/system-types.yaml type name or bcd-formats.yaml format`;
}

function checkTemplate(call: CallNode, entry: InstructionEntry, ruleSet: RuleSet): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  const tmpl = entry.template;
  if (!tmpl || tmpl.shape === "none") return diags;

  // README's `confidence` rule: don't hard-error a missing/wrong template
  // on a shape-only entry -- its own pin shape was only proven with blank,
  // unconnected pins, so whether it even NEEDS a template is a best guess.
  const severity: LintSeverity = entry.confidence === "confirmed-compiled" ? "error" : "warning";

  const s7Templates = call.pragma?.S7_Templates;
  if (s7Templates === undefined) {
    diags.push(
      formatDiagnostic(ruleSet, "missing-template", call.line, call.col, { callName: call.name, shape: tmpl.shape, keys: tmpl.keys.join(", ") }, { severity })
    );
    return diags;
  }

  const parsed = parseTemplateValue(s7Templates);
  const expectedShape = tmpl.shape === "eno-pair" ? "single" : tmpl.shape;
  if (parsed.shape !== expectedShape) {
    diags.push(
      formatDiagnostic(
        ruleSet,
        "template-shape-mismatch",
        call.line,
        call.col,
        { callName: call.name, actualShape: parsed.shape, expectedShape, raw: s7Templates },
        { severity }
      )
    );
  } else if (JSON.stringify(parsed.keys) !== JSON.stringify(tmpl.keys)) {
    diags.push(
      formatDiagnostic(
        ruleSet,
        "template-key-mismatch",
        call.line,
        call.col,
        { callName: call.name, actualKeys: parsed.keys.join(", "), expectedKeys: tmpl.keys.join(", "), raw: s7Templates },
        { severity }
      )
    );
  } else {
    // Shape and keys match -- also check each key's VALUE is a real type
    // name (base-types.yaml/system-types.yaml) or, for conversion-family
    // templates, a bcd-formats.yaml format name. Warning-level regardless
    // of `confidence`: this is new, unverified-in-the-wild territory, not
    // the README's own confirmed shape/key rule.
    for (let i = 0; i < parsed.keys.length; i++) {
      const problem = checkTemplateValue(parsed.values[i], ruleSet);
      if (problem) {
        diags.push(
          formatDiagnostic(ruleSet, "template-value-unrecognized", call.line, call.col, {
            key: parsed.keys[i],
            callName: call.name,
            value: parsed.values[i],
            problem,
          })
        );
      }
    }
  }

  for (const [extraKey, extraVal] of Object.entries(tmpl.extra ?? {})) {
    const actual = call.pragma?.[extraKey];
    if (actual === undefined) {
      diags.push(
        formatDiagnostic(ruleSet, "missing-template-extra", call.line, call.col, { callName: call.name, extraKey, extraVal }, { severity })
      );
    } else if (actual !== extraVal) {
      diags.push(
        formatDiagnostic(ruleSet, "template-extra-mismatch", call.line, call.col, { extraKey, actual, extraVal, callName: call.name }, { severity })
      );
    }
  }

  return diags;
}

/**
 * True if `pinName` is the universal enable input / enable output rather than
 * one of the instruction's own parameters.
 *
 * `EN`/`ENO` belong to the CALL, not to the instruction: they are available on
 * essentially every box call and are modelled by the entry's `enEno` field, so
 * no entry lists them among its `pins` -- which made every `EN := ...` a
 * reported `unknown-pin`. Only rejected when the entry has explicitly recorded
 * that side as absent (`present: false`); a missing `enEno`, or a missing
 * side within it, means "not transcribed either way" and is never guessed
 * against, the same discipline `checkEnEno` below already applies.
 */
function isEnEnoParameter(pinName: string | null, entry: InstructionEntry): boolean {
  const upper = pinName?.toUpperCase();
  if (upper === "EN") return entry.enEno?.en?.present !== false;
  if (upper === "ENO") return entry.enEno?.eno?.present !== false;
  return false;
}

/** Cross-checks a call's own pragma against its registry entry's `enEno.
 * eno.present` -- the one EN/ENO fact that's actually independent of
 * `template`/`S7_Templates` (a MISSING required `S7_GenerateENO` pragma is
 * already caught by `checkTemplate`'s own `template.extra` handling; this
 * catches the opposite, rarer mistake: a pragma requesting ENO generation
 * on an instruction that structurally has no ENO output at all). Only
 * fires when `eno.present` is EXPLICITLY `false` -- an entry with no
 * `enEno` field, or `eno.present: true`/absent, is "not yet confirmed
 * either way" and never guessed against, same discipline as every other
 * `enEno`-adjacent field in this registry. */
function checkEnEno(call: CallNode, entry: InstructionEntry, ruleSet: RuleSet): LintDiagnostic[] {
  const eno = entry.enEno?.eno;
  if (!eno || eno.present !== false) return [];
  const requested = call.pragma?.S7_GenerateENO;
  if (requested === undefined) return [];
  return [formatDiagnostic(ruleSet, "eno-generation-not-supported", call.line, call.col, { callName: call.name, requested })];
}

/** Exported so linter/sclInstructionChecks.ts can reuse the same pin/
 * template validation for an SCL call once it has resolved the call's
 * effective registry name (a free-function name, or the declared type of a
 * bare `#Instance(...)` call) -- see that module for why SCL needs its own
 * name-resolution step in front of this. */
export function checkCall(call: CallNode, ruleSet: RuleSet, networkLanguage: string | undefined, instanceType?: string): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  // linter/sclInstructionChecks.ts passes its own SCL_LANGUAGE = "SCL"
  // sentinel as `networkLanguage` for every SCL call (this same param is
  // otherwise a NETWORK's real S7_Language pragma value, "FBD"/"LAD") --
  // checked directly here rather than importing that constant, to avoid
  // pulling a new dependency from this lower-level module up into the
  // SCL-specific one. SCL has no "pin" concept, so its diagnostics use a
  // dedicated `scl` variant wherever the LAD/FBD wording says "pin".
  const isScl = networkLanguage === "SCL";
  const entry = ruleSet.instructions[call.name];
  if (!entry) {
    diags.push({
      ...formatDiagnostic(ruleSet, "unknown-instruction", call.line, call.col, { callName: call.name }, { variant: "catalog" }),
      registryFix: unknownInstructionFix(call, isScl, instanceType),
    });
    return diags;
  }

  // entry.language unset means "confirmed/assumed multi-language" (the
  // README's default) -- only flag when BOTH sides are known and disagree,
  // never guess when the network's own S7_Language pragma is missing.
  if (entry.language && entry.language.length > 0 && networkLanguage && !entry.language.some((l) => l.toLowerCase() === networkLanguage.toLowerCase())) {
    diags.push(
      formatDiagnostic(ruleSet, "instruction-wrong-language", call.line, call.col, {
        callName: call.name,
        languages: entry.language.join("/"),
        networkLanguage,
      })
    );
  }

  const namedRegPins = entry.pins.filter((p) => p.name !== null);
  const positionalRegPins = entry.pins.filter((p) => p.name === null);
  const namedCallPins = call.pins.filter((p) => p.name !== null);
  const positionalCallPins = call.pins.filter((p) => p.name === null);

  for (const cp of namedCallPins) {
    if (isEnEnoParameter(cp.name, entry)) continue;
    const exact = namedRegPins.find((rp) => rp.name === cp.name);
    if (exact) continue;
    const caseInsensitive = namedRegPins.find((rp) => rp.name!.toLowerCase() === cp.name!.toLowerCase());
    if (caseInsensitive) {
      diags.push(
        formatDiagnostic(
          ruleSet,
          "pin-case-mismatch",
          cp.line,
          cp.col,
          { pinName: cp.name!, registryName: caseInsensitive.name!, callName: call.name },
          { variant: isScl ? "scl" : "catalog" }
        )
      );
    } else {
      diags.push(formatDiagnostic(ruleSet, "unknown-pin", cp.line, cp.col, { pinName: cp.name!, callName: call.name }, { variant: isScl ? "scl" : "catalog" }));
    }
  }

  for (const rp of namedRegPins) {
    if (!rp.required) continue;
    const found = namedCallPins.some((cp) => cp.name === rp.name || cp.name?.toLowerCase() === rp.name!.toLowerCase());
    // SCL permits filling ANY formal parameter positionally, strictly in its
    // declared order, regardless of whether this registry happens to record
    // a display `name` for it (that name only mirrors Siemens' own docs,
    // it isn't proof the parameter can't be passed positionally) -- e.g.
    // RUNTIME's sole pin is registered as named "MEM", yet its own registry
    // `notes` documents calling it purely positionally: `RUNTIME(#RuntimeMemory)`.
    // Only real, unnamed call arguments count as positional fill, matched
    // by count against this pin's own index among ALL of entry.pins (named
    // and positional together, in declared order) -- a LAD/FBD call has no
    // such allowance, so this is gated to SCL only.
    const positionallyFilled = isScl && positionalCallPins.length > entry.pins.indexOf(rp);
    if (!found && !positionallyFilled) {
      diags.push({
        ...formatDiagnostic(ruleSet, "missing-required-pin", call.line, call.col, { pinName: rp.name!, callName: call.name }, { variant: isScl ? "scl" : "named" }),
        // A `required: true` that was never actually required is a common
        // transcription slip (e.g. PUT's ADDR_2..4/SD_2..4 -- Siemens
        // documents only the _1 pair as mandatory), so this one carries a
        // "mark it optional" Quick Fix -- see `RegistryFix`.
        registryFix: { kind: "pin-required", instructionName: call.name, pinName: rp.name!, scl: isScl },
      });
    }
  }

  const requiredPositionalCount = positionalRegPins.filter((p) => p.required).length;
  if (positionalCallPins.length < requiredPositionalCount) {
    diags.push(
      formatDiagnostic(
        ruleSet,
        "missing-required-pin",
        call.line,
        call.col,
        { callName: call.name, expected: requiredPositionalCount, found: positionalCallPins.length },
        { variant: "positional" }
      )
    );
  }

  diags.push(...checkTemplate(call, entry, ruleSet));
  diags.push(...checkEnEno(call, entry, ruleSet));
  return diags;
}

/**
 * `blockIndex` resolves a call whose target is a QUOTED workspace block
 * (`"Some_FB_DB"(...)`, `"Some_FC"(...)`) rather than a catalog instruction.
 * The parser records that shape with `externalName` set and `name` left
 * EMPTY (there is no instruction name to record), so without this the
 * registry was searched for the empty string and every such call -- the
 * normal way LAD/FBD invokes a project's own blocks -- was reported as
 * `Unknown instruction ''`.
 *
 * Optional so the existing callers that have no index still type-check;
 * passing one only ever removes false positives.
 */
export function checkInstructions(block: ParsedBlockFile, ruleSet: RuleSet, blockIndex?: BlockIndex): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  const instanceTypes = new Map<string, string>();
  for (const section of block.varSections) {
    for (const member of section.members) {
      const typeName = typeRefTopLevelName(member.typeRef);
      if (typeName) instanceTypes.set(member.name.toLowerCase(), typeName);
    }
  }
  for (const network of block.networks) {
    const networkLanguage = network.pragma?.S7_Language;
    for (const rung of network.rungs) {
      for (const call of rung.calls) {
        if (call.externalName !== undefined) {
          diags.push(...checkExternalCall(call, ruleSet, blockIndex));
          continue;
        }
        const instanceType = call.instancePrefix ? instanceTypes.get(call.instancePrefix.toLowerCase()) : undefined;
        diags.push(...checkCall(call, ruleSet, networkLanguage, instanceType));
      }
    }
  }
  return diags;
}

/**
 * A `"Name"(...)` call target, resolved against the workspace rather than the
 * instruction registry -- the same precedence linter/sclInstructionChecks.ts's
 * `resolveCallEntry` applies to the identical shape in SCL.
 *
 * A resolved block produces NO diagnostic here: its pins are validated
 * against the callee's own interface by analysis/documentIndex.ts's
 * `checkFbInstancePin`, which this module has no access to (a registry entry's
 * `required`/`dataTypes` metadata, which every check below needs, simply
 * doesn't exist for a project block). With no index to consult at all, stay
 * silent rather than guess -- an unresolvable name is `external-symbol-not-found`'s
 * job when it appears as an operand, and reporting it as an unknown
 * INSTRUCTION would name the wrong registry to go fix.
 */
function checkExternalCall(call: CallNode, ruleSet: RuleSet, blockIndex: BlockIndex | undefined): LintDiagnostic[] {
  const name = call.externalName ?? "";
  if (!blockIndex || blockIndex.get(name)) return [];
  return [formatDiagnostic(ruleSet, "unknown-instruction", call.line, call.col, { shown: `'${name}'` }, { variant: "scl" })];
}
