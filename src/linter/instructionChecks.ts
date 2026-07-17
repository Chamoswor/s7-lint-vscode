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
import { CallNode, ParsedBlockFile } from "../parser/s7dclParser";
import { InstructionEntry, RuleSet } from "../rules/types";
import { formatDiagnostic, LintDiagnostic, LintSeverity } from "./diagnostics";

export type { LintDiagnostic, LintSeverity } from "./diagnostics";

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
export function checkCall(call: CallNode, ruleSet: RuleSet, networkLanguage: string | undefined): LintDiagnostic[] {
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
    diags.push(formatDiagnostic(ruleSet, "unknown-instruction", call.line, call.col, { callName: call.name }, { variant: "catalog" }));
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
      diags.push(
        formatDiagnostic(ruleSet, "missing-required-pin", call.line, call.col, { pinName: rp.name!, callName: call.name }, { variant: isScl ? "scl" : "named" })
      );
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

export function checkInstructions(block: ParsedBlockFile, ruleSet: RuleSet): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  for (const network of block.networks) {
    const networkLanguage = network.pragma?.S7_Language;
    for (const rung of network.rungs) {
      for (const call of rung.calls) {
        diags.push(...checkCall(call, ruleSet, networkLanguage));
      }
    }
  }
  return diags;
}
