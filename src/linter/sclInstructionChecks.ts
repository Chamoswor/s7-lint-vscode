// Instruction-call validation for .scl source files. Unlike a LAD/FBD
// NETWORK/RUNG file, an SCL statement body has no box/pin call graph at
// all -- see parser/s7dclParser.ts's parseSclBody, which flatly collects
// every TOP-LEVEL call it finds (both `Name(...)` free-function calls and
// SCL's `#Instance(...)` bare-instance-call shape) without modeling
// IF/CASE/FOR/WHILE/REPEAT nesting. A call used as another call's OWN pin
// ARGUMENT (e.g. `IN1 := ABS(#x)`, or `ABS(ABS(#x))`) is a SEPARATE
// concern from that statement-level nesting: `collectArgValue` recognizes
// it as a real nested `CallNode` (`PinArg.nestedCalls`) rather than
// flattening it into opaque text, to any depth -- `checkNestedCalls`
// below is what actually walks and validates those, recursively.
//
// Name/pin resolution checks TWO registry maps, in order:
//   1. `ruleSet.sclInstructions` -- FULL standalone entries loaded from
//      `*-SCL.yaml` sibling files (e.g. `04-timers-SCL.yaml`), in SCL's
//      own calling convention throughout (real SCL parameter-name
//      casing, every FBD-implicit pin already listed as an explicit
//      pin). Checked first so a dedicated SCL entry always wins.
//   2. `ruleSet.instructions` -- the shared/FBD-compiled-export registry,
//      used as a fallback for any instruction that doesn't (yet) have a
//      dedicated SCL entry. Its pins keep their FBD casing -- see the
//      uniform adaptations below for how that's still made to work for
//      an SCL call without a dedicated entry.
// See instruction-registry/README.md's "SCL as a third language" section.
//
// A resolved instance whose declared type is a project-authored custom
// FB/FC (not a Siemens system instruction) is looked up against the
// workspace-wide BlockIndex instead of either registry map -- but its
// pins are NOT validated here (that would need the same kind of
// pin-vs-VAR_INPUT/OUTPUT/IN_OUT cross-check documentIndex.ts's
// checkFbInstancePin already does for LAD/FBD, not yet extended to SCL
// bodies). A custom-block instance is simply not flagged as unknown; only
// a call whose type resolves to NEITHER a registry entry NOR a known block
// is a genuine "can't resolve this call at all" diagnostic.
//
// Two uniform adaptations applied to WHICHEVER entry is found (dedicated
// SCL or shared fallback alike), confirmed against a real, compiling
// project .scl corpus (distributed-process-control.scl/SCL_Example.scl):
//   - SCL's own FB/FC call syntax is a named-parameter list where IEC
//     61131-3 permits omitting ANY parameter (unconnected ones simply
//     keep their previous/default value) -- unlike FBD, where a
//     `required: true` pin left unwired is a real compile error. This
//     registry's `required` flags reflect FBD's stricter rule, so an
//     SCL call must not be held to them at all -- confirmed directly by
//     SCL_Example.scl's own `#R_TRIG_Instance();` call (zero arguments,
//     under its "Fields included only required" comment) compiling
//     clean despite CLK being `required: true`. A FUNCTION-shaped
//     instruction's single output is also commonly consumed as an
//     implicit expression result instead (`#result := Lower_Bound(ARR
//     := ..., DIM := ...);`), which the same blanket relaxation covers.
//   - `S7_Templates` is an FBD/LAD-only pragma mechanism for selecting a
//     generic box's concrete type -- SCL has no such pragma at all
//     (confirmed: every real call to a templated instruction like
//     Abs/Limit in the distributed-process-control.scl corpus has none), since SCL resolves
//     a generic instruction's type directly from its actual argument
//     types. `checkTemplate` (inside `checkCall`) would otherwise flag
//     every single one as "missing-template" -- suppressed here.
//
// Two additional SCL-only checks layered on top of `checkCall`'s shared
// four, both consuming registry fields `checkCall` itself ignores
// (system-registry/{memory,result}.yaml):
//   - `checkResultUsage` -- flags `#lhs := Call(...)` where `Call`'s
//     registry `result.kind` is `none` (a stateful instance call like a
//     counter/timer has no return value at all) or non-storable (e.g.
//     `TypeOf`'s type-expression result, legal only in a type-comparison/
//     case-selector context). Relies on `s7dclParser.ts`'s
//     `CallNode.isAssignmentRhs`, so it only fires when the call is the
//     ENTIRE right-hand side of a plain assignment -- a call nested inside
//     a larger expression isn't parsed as its own CallNode at all (see that
//     file's own note on this pre-existing limitation), so this can't yet
//     catch e.g. `#x := 1 + TypeOf(...)`.
//   - `checkSclPinMemoryAreas` -- for a named pin whose ENTIRE value is one
//     bare `#tag` (no member access, no expression), resolves which VAR_*
//     section declares that tag in this block and checks it against the
//     matched registry pin's `allowedDeclarations`/`memoryAreas` (checked
//     in that precedence order, per memory.yaml's own `matching.precedence`).
//     Silently skipped for anything else (a global tag, an absolute
//     address, a compound expression) -- this only walks the block's own
//     VAR sections directly, not the fuller analysis/symbolTable.ts (which
//     also resolves `.member` chains through UDTs/system-structs/cross-file
//     instances) `checkResultTypeMatch` below uses.
//   - `checkResultTypeMatch` -- for `#lhs := Call(...)`, resolves `#lhs`'s
//     declared type via analysis/symbolTable.ts's `resolveOperandRef` and
//     compares it against `Call`'s registry `result`: a fixed `kind: value`
//     `dataTypes` set (expanded through category-index.yaml umbrella labels,
//     reusing rules/literalTypes.ts's `expandPinDataTypes`), or -- for
//     `kind: inferred, rule: same-as-source` -- the SAME check applied to
//     whichever call pin `sourcePins` names, recursively resolved the same
//     way. `common-compatible-type`/`numeric-expression`/
//     `bit-string-expression` (implicit-conversion rules this project
//     doesn't model) and `instruction-specific` (system-registry/
//     result.yaml's own named escape hatch, requiring a per-instruction
//     resolver that doesn't exist) are deliberately left unchecked rather
//     than guessed.
//   - `checkMatchingArrayBounds` -- type-registry/symbolic-runtime-access.yaml's
//     `workflow.matchingArrayBounds` (generically an instruction + its two
//     pins, not hardcoded to one instruction name): flags the two named
//     pins declaring different ARRAY bounds (e.g. ResolveSymbols'
//     nameList/referenceList). The SCL-body counterpart to
//     analysis/documentIndex.ts's equivalent RUNG-only check -- matters
//     more here in practice, since an async/SCL-flavored instruction like
//     ResolveSymbols is far more likely called from a `BEGIN` body than a
//     RUNG (documentIndex.ts's own walker never descends into `BEGIN` at
//     all).
//
// `checkNestedCalls` applies the SAME two result-driven checks
// (`checkResultUsage`/`checkResultTypeMatch` above, as
// `checkNestedResultUsable`/`checkNestedResultAgainstPin`) to a call
// nested inside another call's OWN pin value, in addition to fully
// re-validating the nested call as a call in its own right (recursively,
// to any depth) -- see that function's own comment.
import { BlockIndex } from "../analysis/blockIndex";
import { resolveInstanceTypeToInstructionNames } from "../analysis/documentIndex";
import { resolveOperandRef } from "../analysis/symbolTable";
import { TypeCacheResult } from "../cache/typeCache";
import { CallNode, OperandRef, ParsedBlockFile, PinArg } from "../parser/s7dclParser";
import { typeRefTopLevelName } from "../parser/typeRef";
import { expandPinDataTypes, resolveTypeAlias } from "../rules/literalTypes";
import { InstructionEntry, InstructionPin, RuleSet } from "../rules/types";
import { formatDiagnostic, LintDiagnostic, LintSeverity } from "./diagnostics";
import { checkCall, unknownInstructionFix } from "./instructionChecks";

const SCL_LANGUAGE = "SCL";

/** Maps a `.s7dcl`/`.scl` VAR_* section keyword to system-registry/
 * memory.yaml's `declarationMapping` keys -- `VAR` (plain, unqualified) is
 * deliberately left unmapped for a FUNCTION (its own local data has no
 * `Static` concept the way a FUNCTION_BLOCK's does) rather than guessed. */
const VAR_SECTION_TO_DECLARATION: Record<string, string | undefined> = {
  VAR_INPUT: "Input",
  VAR_OUTPUT: "Output",
  VAR_IN_OUT: "InOut",
  VAR_TEMP: "Temp",
  VAR_CONSTANT: "Constant",
};

/** Resolves which VAR_* declaration section (in system-registry/memory.yaml
 * `declarationMapping` terms) declares `tagName` in this block, or
 * `undefined` if it isn't a local declaration this parser can see (a global
 * PLC tag, an absolute address, or genuinely not declared here -- none of
 * those are an error this check can make, so it's simply skipped). */
function resolveDeclaredSection(block: ParsedBlockFile, tagName: string): string | undefined {
  for (const section of block.varSections) {
    if (!section.members.some((m) => m.name === tagName)) continue;
    if (section.kind === "VAR") return block.blockType === "FUNCTION_BLOCK" ? "Static" : undefined;
    return VAR_SECTION_TO_DECLARATION[section.kind];
  }
  return undefined;
}

/** Pin memory-area/declaration check (system-registry/memory.yaml) for ONE
 * call pin -- only attempted when the pin's entire value is a single bare
 * `#tag` reference (no member access, no expression) so the declared
 * section can be safely attributed to the whole pin; anything more complex
 * (`#a.b`, `#a + #b`, a literal, an absolute address) is silently skipped
 * rather than guessed, same discipline the rest of this registry follows. */
function checkPinMemoryArea(pin: PinArg, regPin: InstructionPin, block: ParsedBlockFile, ruleSet: RuleSet, callName: string, confidence: InstructionEntry["confidence"]): LintDiagnostic[] {
  if (pin.operandRefs.length !== 1) return [];
  const ref = pin.operandRefs[0];
  if (ref.segments.length !== 1) return [];
  if (pin.valueText.trim() !== `#${ref.segments[0]}`) return [];

  const section = resolveDeclaredSection(block, ref.segments[0]);
  if (!section) return [];

  const severity: LintSeverity = confidence === "confirmed-compiled" ? "error" : "warning";
  const pinRef = regPin.name ? `parameter '${regPin.name}'` : "its operand";

  if (regPin.allowedDeclarations && regPin.allowedDeclarations.length > 0) {
    if (regPin.allowedDeclarations.includes(section)) return [];
    return [
      formatDiagnostic(
        ruleSet,
        "pin-declaration-not-allowed",
        pin.line,
        pin.col,
        { callName, pinRef, allowed: regPin.allowedDeclarations.join("/"), segment: ref.segments[0], section },
        { severity }
      ),
    ];
  }

  if (regPin.memoryAreas && regPin.memoryAreas.length > 0 && !regPin.memoryAreas.includes("*")) {
    const area = ruleSet.systemRegistry.memory.declarationMapping[section]?.tiaDocOperandArea;
    if (area && !regPin.memoryAreas.includes(area)) {
      return [
        formatDiagnostic(
          ruleSet,
          "pin-memory-area-mismatch",
          pin.line,
          pin.col,
          { callName, pinRef, memoryAreas: regPin.memoryAreas.join(", "), segment: ref.segments[0], section, area },
          { severity }
        ),
      ];
    }
  }
  return [];
}

/** Matches every call pin to its corresponding registry pin -- named pins
 * by name (case-insensitive fallback, same tolerance `checkCall` itself
 * uses); positional pins by index, same as `checkCall`'s own
 * `positionalCallPins`/`positionalRegPins` split. Shared by
 * `checkSclPinMemoryAreas` and `checkNestedCalls` (the latter needs the
 * registry pin a nested call's OWN containing pin matches, to compare
 * expected `dataTypes` against). The positional path matters in practice:
 * `TypeOf`/`TypeOfElements`/`IS_ARRAY` -- the confirmed, motivating
 * examples for `memoryAreas`/`allowedDeclarations` in
 * 02-comparators-SCL.yaml -- all take a single unnamed (`name: null`)
 * operand pin. */
function mapCallPinsToRegistryPins(call: CallNode, entry: InstructionEntry): Map<PinArg, InstructionPin> {
  const map = new Map<PinArg, InstructionPin>();

  const positionalRegPins = entry.pins.filter((p) => p.name === null);
  const positionalCallPins = call.pins.filter((p) => p.name === null);
  for (let i = 0; i < Math.min(positionalRegPins.length, positionalCallPins.length); i++) {
    map.set(positionalCallPins[i], positionalRegPins[i]);
  }

  for (const cp of call.pins) {
    if (cp.name === null) continue;
    const regPin = entry.pins.find((p) => p.name === cp.name) ?? entry.pins.find((p) => p.name?.toLowerCase() === cp.name!.toLowerCase());
    if (regPin) map.set(cp, regPin);
  }
  return map;
}

/** Runs `checkPinMemoryArea` over every pin in a resolved SCL call, using
 * `mapCallPinsToRegistryPins` to match each one to its registry pin. */
function checkSclPinMemoryAreas(call: CallNode, entry: InstructionEntry, displayName: string, block: ParsedBlockFile, ruleSet: RuleSet): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  for (const [cp, regPin] of mapCallPinsToRegistryPins(call, entry)) {
    diags.push(...checkPinMemoryArea(cp, regPin, block, ruleSet, displayName, entry.confidence));
  }
  return diags;
}

type ResultUsageProblem =
  | { code: "result-assigned-from-no-result" }
  | { code: "result-not-storable"; kind: string; contexts: string[] };

/** Core "can this call's result be used as an ordinary value at all" check
 * -- factored out so both `checkResultUsage` (a `:=` assignment target)
 * and `checkNestedResultUsable` (a nested call used as another call's pin
 * ARGUMENT) apply the identical rule: system-registry/result.yaml's own
 * `usageContexts.value-expression` description explicitly covers BOTH
 * "assignment sources" and "compatible function arguments" as the SAME
 * usage context, so there's no reason for the two call sites to diverge.
 * Returns `null` when there's nothing wrong (including "not yet
 * catalogued" -- an entry with no `result` field at all -- per
 * system-registry/result.yaml's own `omittedMeans` discipline; never
 * guessed). */
function findResultUsageProblem(entry: InstructionEntry, ruleSet: RuleSet): ResultUsageProblem | null {
  const result = entry.result;
  if (!result) return null;
  if (result.kind === "none") return { code: "result-assigned-from-no-result" };

  const kindSpec = ruleSet.systemRegistry.result.resultKinds[result.kind];
  const storable = result.usage?.storable ?? kindSpec?.defaults?.usage?.storable ?? true;
  if (storable) return null;
  const contexts = result.usage?.allowedContexts ?? kindSpec?.defaults?.usage?.allowedContexts ?? [];
  return { code: "result-not-storable", kind: result.kind, contexts };
}

/** Flags assigning FROM a call whose registry entry's `result` says the
 * call either has no return value at all (`kind: none` -- a stateful
 * instance call like a counter/timer, whose effects are its OUT pins/
 * instance state) or one that isn't storable (e.g. `TypeOf`'s
 * type-expression result, legal only in a type-comparison/case-selector
 * context, not a plain `:=`). Only runs on `call.isAssignmentRhs` calls --
 * see `s7dclParser.ts`'s `CallNode.isAssignmentRhs`. */
function checkResultUsage(call: CallNode, entry: InstructionEntry, displayName: string, ruleSet: RuleSet): LintDiagnostic[] {
  if (!call.isAssignmentRhs) return [];
  const problem = findResultUsageProblem(entry, ruleSet);
  if (!problem) return [];
  const diag =
    problem.code === "result-assigned-from-no-result"
      ? formatDiagnostic(ruleSet, problem.code, call.line, call.col, { name: displayName }, { variant: "assignment" })
      : formatDiagnostic(
          ruleSet,
          problem.code,
          call.line,
          call.col,
          { name: displayName, kind: problem.kind, contexts: problem.contexts.length > 0 ? problem.contexts.join("/") : "a restricted" },
          { variant: "assignment" }
        );
  return [diag];
}

/** Same check as `checkResultUsage`, applied to a call nested inside
 * another call's OWN pin value instead of a `:=` assignment target (e.g.
 * `IN1 := SomeCounterInstance(...)` -- has no result at all; `IN1 :=
 * TypeOf(#x)` -- a non-storable type-expression result) -- see
 * `findResultUsageProblem`'s own comment for why the same rule applies to
 * both contexts. Always runs (no `isAssignmentRhs`-style gate): being a
 * pin argument is inherently the same "value-expression" usage a plain
 * assignment target is. */
function checkNestedResultUsable(nested: CallNode, nestedEntry: InstructionEntry, nestedDisplayName: string, ruleSet: RuleSet): LintDiagnostic[] {
  const problem = findResultUsageProblem(nestedEntry, ruleSet);
  if (!problem) return [];
  const diag =
    problem.code === "result-assigned-from-no-result"
      ? formatDiagnostic(ruleSet, problem.code, nested.line, nested.col, { name: nestedDisplayName }, { variant: "nested" })
      : formatDiagnostic(
          ruleSet,
          problem.code,
          nested.line,
          nested.col,
          { name: nestedDisplayName, kind: problem.kind, contexts: problem.contexts.length > 0 ? problem.contexts.join("/") : "a restricted" },
          { variant: "nested" }
        );
  return [diag];
}

/** Resolves `segments` to its declared type's TOP-LEVEL name, through
 * analysis/symbolTable.ts's full `.member` chain resolution (UDTs,
 * system-structs, cross-file block instances, instruction pins) -- not
 * just this block's own VAR sections -- then normalizes it through
 * base-types.yaml's `aliases` (e.g. `TOD` -> `Time_Of_Day`) so it compares
 * cleanly against a registry `dataTypes` list, which always uses the
 * canonical spelling. Returns `null` for anything this can't confidently
 * resolve to a single name (undeclared, an unresolved path step, an
 * array/inline-struct type with no single top-level name) -- never guessed. */
function resolveTagTypeName(ref: OperandRef, block: ParsedBlockFile, blockIndex: BlockIndex, typeCache: TypeCacheResult, ruleSet: RuleSet): string | null {
  const resolved = resolveOperandRef(ref.segments, block, blockIndex, typeCache, ruleSet, ref.external);
  if (resolved.kind !== "resolved") return null;
  const name = typeRefTopLevelName(resolved.typeRef);
  return name ? resolveTypeAlias(name, ruleSet) : null;
}

/** Finds which CALL pin corresponds to registry pin index `idx` --
 * system-registry/result.yaml's `sourcePins` are zero-based indexes into
 * the instruction's OWN `pins` array (chosen over names specifically
 * because a valid entry may have unnamed pins). Matched by name
 * (case-insensitive fallback, same tolerance `checkCall` itself uses) when
 * the registry pin has one; by position among the call's OWN positional
 * pins when it doesn't. */
function findCallPinForRegistryIndex(call: CallNode, entry: InstructionEntry, idx: number): PinArg | undefined {
  const regPin = entry.pins[idx];
  if (!regPin) return undefined;
  if (regPin.name !== null) {
    return call.pins.find((p) => p.name === regPin.name) ?? call.pins.find((p) => p.name?.toLowerCase() === regPin.name!.toLowerCase());
  }
  const positionalIndex = entry.pins.slice(0, idx).filter((p) => p.name === null).length;
  return call.pins.filter((p) => p.name === null)[positionalIndex];
}

/** The one bare local or quoted external operand this pin's ENTIRE value consists
 * of, or `undefined` for anything else (a literal, an expression, several
 * refs) -- same conservative "attribute the whole pin" rule
 * `checkPinMemoryArea` uses, so a source pin like `#a + #b` is silently
 * skipped rather than misattributed to either operand. */
function soleOperandRef(pin: PinArg): OperandRef | undefined {
  if (pin.operandRefs.length !== 1) return undefined;
  const ref = pin.operandRefs[0];
  const expected = ref.external
    ? `"${ref.segments[0]}"${ref.segments.slice(1).map((segment) => `.${segment}`).join("")}`
    : `${ref.bare ? "" : "#"}${ref.segments.join(".")}`;
  // `collectArgValue` inserts display spaces BETWEEN tokens, including
  // around `.`, but whitespace INSIDE a quoted PLC-tag name is significant.
  const actual = pin.valueText.trim().replace(/\s*\.\s*/g, ".");
  return actual === expected ? ref : undefined;
}

/** For `#lhs := Call(...)`, checks the receiving variable's declared type
 * against `Call`'s registry `result` -- see file header for exactly which
 * `result.kind`/`rule` combinations this covers and which are left
 * unchecked on purpose. `result.kind: none`/`type-expression` are skipped
 * here entirely (already flagged by `checkResultUsage` -- reporting a type
 * mismatch on top would be redundant, since there's no valid type to
 * compare against in the first place). */
function checkResultTypeMatch(
  call: CallNode,
  entry: InstructionEntry,
  displayName: string,
  block: ParsedBlockFile,
  blockIndex: BlockIndex,
  typeCache: TypeCacheResult,
  ruleSet: RuleSet
): LintDiagnostic[] {
  if (!call.isAssignmentRhs || !call.assignmentTarget || !entry.result) return [];
  const result = entry.result;
  if (result.kind === "none" || result.kind === "type-expression") return [];

  const lhsRef = call.assignmentTarget;
  const lhsTypeName = resolveTagTypeName(lhsRef, block, blockIndex, typeCache, ruleSet);
  if (!lhsTypeName) return []; // can't resolve the receiving variable's type -- don't guess

  const severity: LintSeverity = entry.confidence === "confirmed-compiled" ? "error" : "warning";

  if (result.kind === "value") {
    const { skip, types } = expandPinDataTypes(result.dataTypes ?? [], ruleSet);
    if (skip || types.has(lhsTypeName)) return [];
    return [
      formatDiagnostic(
        ruleSet,
        "result-type-mismatch",
        call.line,
        call.col,
        { name: displayName, types: (result.dataTypes ?? []).join(", "), lhs: lhsRef.segments.join("."), lhsType: lhsTypeName },
        { severity, variant: "value-assignment" }
      ),
    ];
  }

  if (result.kind === "inferred" && result.rule === "same-as-source" && result.sourcePins?.length === 1) {
    const sourcePin = findCallPinForRegistryIndex(call, entry, result.sourcePins[0]);
    const sourceRef = sourcePin && soleOperandRef(sourcePin);
    if (!sourceRef) return []; // source operand isn't a clean bare tag -- don't guess
    const sourceTypeName = resolveTagTypeName(sourceRef, block, blockIndex, typeCache, ruleSet);
    if (!sourceTypeName || sourceTypeName === lhsTypeName) return [];
    return [
      formatDiagnostic(
        ruleSet,
        "result-type-mismatch",
        call.line,
        call.col,
        { name: displayName, source: sourceRef.segments.join("."), sourceType: sourceTypeName, lhs: lhsRef.segments.join("."), lhsType: lhsTypeName },
        { severity, variant: "same-source-assignment" }
      ),
    ];
  }

  return [];
}

/** Same comparison `checkResultTypeMatch` does for a `#lhs := Call(...)`
 * assignment target, applied instead to a call NESTED inside another
 * call's own pin value (e.g. `IN1 := ABS(#x)`) -- checks the nested call's
 * OWN `result` against the CONTAINING pin's expected `dataTypes` (a SET,
 * unlike a resolved variable's single type name, so "matches" here means
 * "the two dataTypes sets overlap" rather than exact equality -- a pin
 * declaring `dataTypes: [Int, Real]` legitimately accepts either). Only
 * runs when `containingPin.isSoleNestedCall` -- a call that's merely ONE
 * TERM in a larger expression (`#a + ABS(#b)`) would need real operator
 * type-inference to know the WHOLE expression's result type, so it's left
 * unchecked, same "don't guess" discipline as everywhere else here.
 * `result.kind: none`/`type-expression` are skipped (already flagged by
 * `checkNestedResultUsable`). */
function checkNestedResultAgainstPin(
  nested: CallNode,
  nestedEntry: InstructionEntry,
  nestedDisplayName: string,
  containingPin: PinArg,
  regPin: InstructionPin,
  block: ParsedBlockFile,
  blockIndex: BlockIndex,
  typeCache: TypeCacheResult,
  ruleSet: RuleSet
): LintDiagnostic[] {
  if (!containingPin.isSoleNestedCall || !nestedEntry.result) return [];
  const result = nestedEntry.result;
  if (result.kind === "none" || result.kind === "type-expression") return [];
  if (!regPin.dataTypes || regPin.dataTypes.length === 0) return []; // nothing transcribed to check against -- don't guess

  const { skip: pinSkip, types: pinTypes } = expandPinDataTypes(regPin.dataTypes, ruleSet);
  if (pinSkip) return [];

  const severity: LintSeverity = nestedEntry.confidence === "confirmed-compiled" ? "error" : "warning";
  const pinRef = regPin.name ? `parameter '${regPin.name}'` : "this parameter";

  if (result.kind === "value") {
    const resultDataTypes = result.dataTypes ?? [];
    const { skip: resultSkip, types: resultTypes } = expandPinDataTypes(resultDataTypes, ruleSet);
    if (resultSkip || [...resultTypes].some((t) => pinTypes.has(t))) return [];
    return [
      formatDiagnostic(
        ruleSet,
        "result-type-mismatch",
        nested.line,
        nested.col,
        { name: nestedDisplayName, types: resultDataTypes.join(", "), pinRef, pinTypes: regPin.dataTypes.join(", ") },
        { severity, variant: "value-pin" }
      ),
    ];
  }

  if (result.kind === "inferred" && result.rule === "same-as-source" && result.sourcePins?.length === 1) {
    const sourcePin = findCallPinForRegistryIndex(nested, nestedEntry, result.sourcePins[0]);
    const sourceRef = sourcePin && soleOperandRef(sourcePin);
    if (!sourceRef) return []; // source operand isn't a clean bare tag -- don't guess
    const sourceTypeName = resolveTagTypeName(sourceRef, block, blockIndex, typeCache, ruleSet);
    if (!sourceTypeName || pinTypes.has(sourceTypeName)) return [];
    return [
      formatDiagnostic(
        ruleSet,
        "result-type-mismatch",
        nested.line,
        nested.col,
        { name: nestedDisplayName, source: sourceRef.segments.join("."), sourceType: sourceTypeName, pinRef, pinTypes: regPin.dataTypes.join(", ") },
        { severity, variant: "same-source-pin" }
      ),
    ];
  }

  return [];
}

/** Resolves a pin's ENTIRE value (must be a single bare `#tag(.member)*`
 * chain, per `soleOperandRef`) to its declared ARRAY bounds via
 * analysis/symbolTable.ts's full chain resolution -- `undefined` for
 * anything not confidently resolvable to a FIXED-bounds array (undeclared,
 * an unresolved path step, a non-array type, or `ARRAY[*]`'s own empty
 * bounds list, which has nothing concrete to compare). */
function resolvePinArrayBounds(pin: PinArg, block: ParsedBlockFile, blockIndex: BlockIndex, typeCache: TypeCacheResult, ruleSet: RuleSet): [number, number][] | undefined {
  const ref = soleOperandRef(pin);
  if (!ref) return undefined;
  const resolved = resolveOperandRef(ref.segments, block, blockIndex, typeCache, ruleSet, ref.external);
  if (resolved.kind !== "resolved" || resolved.typeRef.kind !== "array" || resolved.typeRef.bounds.length === 0) return undefined;
  return resolved.typeRef.bounds;
}

/** system-registry/type-registry's symbolic-runtime-access.yaml
 * `workflow.matchingArrayBounds` -- generically named (an instruction +
 * its two pins), not hardcoded to `ResolveSymbols`/`nameList`/
 * `referenceList` specifically, so a second instruction with this same
 * constraint could be added to that YAML without a code change here.
 * `analysis/documentIndex.ts` already runs the equivalent check for a
 * LAD/FBD RUNG-based call; this is the SCL-body counterpart (that
 * matters more in practice for an async, SCL-flavored instruction like
 * ResolveSymbols) -- reuses this file's own full symbol-chain resolution
 * (`resolveOperandRef`) rather than documentIndex.ts's simpler
 * this-block-only `localDecls` lookup. */
function checkMatchingArrayBounds(call: CallNode, displayName: string, block: ParsedBlockFile, blockIndex: BlockIndex, typeCache: TypeCacheResult, ruleSet: RuleSet): LintDiagnostic[] {
  const constraint = ruleSet.symbolicRuntimeAccess.workflow.matchingArrayBounds;
  if (displayName !== constraint.instruction) return [];

  const [firstPinName, secondPinName] = constraint.pins;
  const firstPin = call.pins.find((p) => p.name === firstPinName);
  const secondPin = call.pins.find((p) => p.name === secondPinName);
  if (!firstPin || !secondPin) return []; // one/both not wired on this call -- nothing to compare

  const firstBounds = resolvePinArrayBounds(firstPin, block, blockIndex, typeCache, ruleSet);
  const secondBounds = resolvePinArrayBounds(secondPin, block, blockIndex, typeCache, ruleSet);
  if (!firstBounds || !secondBounds || JSON.stringify(firstBounds) === JSON.stringify(secondBounds)) return [];

  return [
    formatDiagnostic(ruleSet, "resolve-symbols-bounds-mismatch", firstPin.line, firstPin.col, {
      instruction: displayName,
      pin1: firstPinName,
      pin2: secondPinName,
      bounds1: firstBounds.map(([l, h]) => `${l}..${h}`).join(", "),
      bounds2: secondBounds.map(([l, h]) => `${l}..${h}`).join(", "),
      notesSuffix: constraint.notes ? `; ${constraint.notes}` : "",
    }),
  ];
}

function buildInstanceTypeMap(block: ParsedBlockFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const section of block.varSections) {
    for (const member of section.members) {
      const typeName = typeRefTopLevelName(member.typeRef);
      if (typeName) map.set(member.name, typeName);
    }
  }
  return map;
}

interface FoundEntry {
  registryKey: string;
  entry: InstructionEntry;
  /** Which registry map `entry` came from -- `adaptEntryForScl` needs this
   * to decide whether `required` should be relaxed (see its own comment). */
  source: "scl" | "shared";
}

/** EXACT name lookup only -- against `sclInstructions` first, then
 * `instructions` as a fallback (see file header). No case-insensitive
 * fallback: SCL's real calling convention is now captured as data (a
 * dedicated `*-SCL.yaml` entry, keyed and pinned exactly as real SCL
 * source spells it, e.g. `LOWER_BOUND`/`ARR`/`DIM` -- confirmed against
 * the real distributed-process-control.scl/SCL_Example.scl corpus), not papered over by
 * fuzzy matching in code. An instruction with no dedicated SCL entry
 * falls back to the shared/FBD-cased entry AS-IS -- correct for the
 * handful already documented with Siemens' own uppercase official
 * parameter names (e.g. `MoveBlockI`'s `IN`/`COUNT`/`OUT`,
 * `ENDIS_PW`'s `REQ`/`F_PWD`/...), a real "unknown instruction"/
 * "unknown pin" for anything genuinely not yet catalogued for SCL. */
function findEntry(ruleSet: RuleSet, name: string): FoundEntry | undefined {
  if (name in ruleSet.sclInstructions) return { registryKey: name, entry: ruleSet.sclInstructions[name], source: "scl" };
  if (name in ruleSet.instructions) return { registryKey: name, entry: ruleSet.instructions[name], source: "shared" };
  return undefined;
}

/** Presents a registry entry the way an SCL call sees it -- see file
 * header's "uniform adaptations". `template` is always suppressed (SCL has
 * no `S7_Templates`-equivalent pragma at all, dedicated or shared entry
 * alike). `required` is trickier: it's only relaxed to `false` when `source`
 * is `"shared"` -- a `ruleSet.instructions` entry borrowed as-is from the
 * FBD registry, whose `required` flags reflect FBD's stricter compile rule
 * (confirmed not to apply to SCL by `SCL_Example.scl`'s own zero-argument
 * `#R_TRIG_Instance();` call). A `"scl"`-sourced entry (a dedicated
 * `*-SCL.yaml` file) already encodes real SCL-accurate `required` flags in
 * its own data -- e.g. `11-conversion-SCL.yaml`'s `LREAL_TO_REAL` correctly
 * requires its sole input -- so blanket-relaxing it too would silently
 * un-flag a genuinely missing argument. */
function adaptEntryForScl(entry: InstructionEntry, source: FoundEntry["source"]): InstructionEntry {
  return {
    ...entry,
    pins: source === "shared" ? entry.pins.map((p) => ({ ...p, required: false })) : entry.pins,
    template: { shape: "none", keys: [], extra: {} },
  };
}

type SclCallResolution =
  | { kind: "resolved"; found: FoundEntry }
  | { kind: "custom-block" } // a project-authored FB/FC instance, not a Siemens system instruction -- see file header
  | { kind: "error"; diag: LintDiagnostic };

/** Resolves `call` to its registry entry -- shared by `checkSclCall` (for
 * the call itself) and `checkNestedCalls` (for a call nested inside
 * another call's pin value), so both apply IDENTICAL name resolution
 * (bare-instance-call -> declared type -> registry key, falling back to
 * the workspace BlockIndex for a project-authored custom block) rather
 * than duplicating it. */
function resolveCallEntry(call: CallNode, ruleSet: RuleSet, blockIndex: BlockIndex, instanceTypes: Map<string, string>): SclCallResolution {
  if (call.externalName !== undefined) {
    // Siemens' own external-symbol convention: `"Name"(...)` calls a
    // workspace FUNCTION directly by its quoted name, or an FB's own
    // external instance DB (see parser/s7dclParser.ts's own `CallNode.
    // externalName`). Resolved straight against BlockIndex, never the
    // instruction registry -- a catalog Siemens instruction is never
    // referenced via a quoted string. Pin validation for a resolved
    // custom block isn't implemented yet (see file header's own note on
    // the bare-instance-call `"custom-block"` case below) -- same
    // "recognized and name-resolved, not yet pin-checked" treatment.
    const target = blockIndex.get(call.externalName);
    if (!target) {
      return {
        kind: "error",
        diag: formatDiagnostic(ruleSet, "external-symbol-not-found", call.line, call.col, { name: call.externalName }),
      };
    }
    // A FUNCTION_BLOCK/ORGANIZATION_BLOCK resolved here IS the block's own
    // TYPE declaration, not a verifiable instance -- mirrors
    // analysis/symbolTable.ts's `illegal-external-block-type` for the
    // dot-access shape (confirmed against TIA Portal itself refusing to
    // dot a bare FB type). Calling one directly by its bare type name is
    // never valid either -- only a genuine instance (a local STATIC var,
    // or the FB's own external instance DB, which is a DISTINCT name from
    // the FB type and always exported AS a DATA_BLOCK) is callable. A
    // FUNCTION needs no instance at all, and a DATA_BLOCK target is left
    // unflagged (it may genuinely be a real external instance DB -- this
    // registry can't tell that apart from a plain global DB, so it
    // doesn't guess).
    if (target.blockType === "FUNCTION_BLOCK" || target.blockType === "ORGANIZATION_BLOCK") {
      return {
        kind: "error",
        diag: formatDiagnostic(ruleSet, "call-needs-instance", call.line, call.col, {
          name: call.externalName,
          blockType: target.blockType.replace(/_/g, " ").toLowerCase(),
        }),
      };
    }
    return { kind: "custom-block" };
  }

  const isBareInstanceCall = call.name === "" && !!call.instancePrefix;
  let lookupName = call.name;

  if (isBareInstanceCall) {
    const declaredType = instanceTypes.get(call.instancePrefix!);
    if (!declaredType) {
      return {
        kind: "error",
        diag: formatDiagnostic(ruleSet, "scl-instance-not-declared", call.line, call.col, { instancePrefix: call.instancePrefix! }),
      };
    }
    // The declared type is the registry's `instanceType` value (e.g.
    // `TON_TIME`), NOT the callable instruction name (`TON`) -- the
    // registry is keyed by the latter. A dedicated SCL entry is checked
    // FIRST (same "scl wins" precedence findEntry uses below) since its
    // OWN registry key can differ in casing from the shared/FBD one for
    // the exact same instruction (e.g. `MC_Power` in a *-SCL.yaml file vs.
    // `MC_POWER` in the shared LAD/FBD registry, both declaring
    // `instanceType: MC_POWER`) -- resolveInstanceTypeToInstructionNames
    // only ever scans `ruleSet.instructions`, so without this an SCL
    // instance call would resolve to the FBD-cased entry instead (wrongly
    // inheriting ITS `language: [LAD, FBD]` restriction). Falls back to
    // that shared reverse index (see its own comment for the CTU/CTD/CTUD
    // family caveat) when no dedicated SCL entry declares this
    // instanceType. No match at all (empty list) means the declared type
    // isn't a known SYSTEM instance type -- fall through to the raw type
    // name so the block-index check below can still recognize a custom
    // FB/FC whose own type name IS its block name.
    const sclMatch = Object.entries(ruleSet.sclInstructions).find(
      ([, entry]) => entry.instanceType === declaredType && entry.callShape === "instance-dot"
    );
    if (sclMatch) {
      lookupName = sclMatch[0];
    } else {
      const candidates = resolveInstanceTypeToInstructionNames(ruleSet, declaredType);
      lookupName = candidates.length > 0 ? candidates[0] : declaredType;
    }
  }

  const found = findEntry(ruleSet, lookupName);
  if (!found) {
    // Not a known Siemens instruction -- a project-authored custom FB/FC
    // instance calls the exact same way in SCL (`#instanceName(...)`), so
    // check the workspace block index before giving up. Pin validation for
    // a resolved custom block isn't implemented yet (see file header) --
    // just don't flag it as unresolvable.
    if (blockIndex.get(lookupName)) return { kind: "custom-block" };

    const shown = isBareInstanceCall ? `#${call.instancePrefix} (declared as '${lookupName}')` : `'${lookupName}'`;
    return {
      kind: "error",
      diag: {
        ...formatDiagnostic(ruleSet, "unknown-instruction", call.line, call.col, { shown }, { variant: "scl" }),
        // `unknownInstructionFix` returns undefined for the bare-instance
        // shape, so this correctly offers a scaffold only for a plain
        // `Name(...)` SCL call.
        registryFix: unknownInstructionFix(call, true),
      },
    };
  }

  // The SAME "needs a real instance" rule `call-needs-instance` already
  // applies to a workspace FUNCTION_BLOCK (see the `externalName` branch
  // above) applies here too: a catalog instruction whose OWN registry
  // entry is callShape: instance-dot (MC_Power, TON, R_TRIG, ...) stores
  // persistent state across calls, exactly like a FUNCTION_BLOCK's own
  // instance data -- it can't be called directly by its bare name either,
  // only THROUGH a declared instance (`#instanceName(...)`, already
  // handled above via `isBareInstanceCall`, or an external instance DB via
  // `call.externalName`, handled in the branch at the top of this
  // function). Only reachable here for a genuinely bare `Name(...)` call
  // (`!isBareInstanceCall`) -- an instance call already resolved
  // `lookupName` THROUGH the instance's own declared type above, so it's
  // never itself the thing being flagged.
  if (!isBareInstanceCall && found.entry.callShape === "instance-dot") {
    return {
      kind: "error",
      diag: formatDiagnostic(ruleSet, "instruction-needs-instance", call.line, call.col, {
        name: lookupName,
        instanceType: found.entry.instanceType ?? lookupName,
      }),
    };
  }

  return { kind: "resolved", found };
}

function checkSclCall(call: CallNode, ruleSet: RuleSet, blockIndex: BlockIndex, instanceTypes: Map<string, string>, block: ParsedBlockFile, typeCache: TypeCacheResult): LintDiagnostic[] {
  const resolution = resolveCallEntry(call, ruleSet, blockIndex, instanceTypes);
  if (resolution.kind === "error") return [resolution.diag];
  if (resolution.kind === "custom-block") return [];

  const { found } = resolution;
  const adaptedEntry = adaptEntryForScl(found.entry, found.source);
  const sclRuleSet: RuleSet = { ...ruleSet, instructions: { ...ruleSet.instructions, [found.registryKey]: adaptedEntry } };
  return [
    ...checkCall({ ...call, name: found.registryKey }, sclRuleSet, SCL_LANGUAGE),
    ...checkResultUsage(call, found.entry, found.registryKey, ruleSet),
    ...checkSclPinMemoryAreas(call, adaptedEntry, found.registryKey, block, ruleSet),
    ...checkResultTypeMatch(call, found.entry, found.registryKey, block, blockIndex, typeCache, ruleSet),
    ...checkMatchingArrayBounds(call, found.registryKey, block, blockIndex, typeCache, ruleSet),
    ...checkNestedCalls(call, adaptedEntry, block, blockIndex, instanceTypes, typeCache, ruleSet),
  ];
}

/** Validates every call nested inside one of `call`'s OWN pin values (e.g.
 * `IN1 := ABS(#x)`, or `#a + ABS(#b)`) -- recursively, so a call nested
 * several levels deep (`ABS(ABS(#x))`) is still fully reached, since
 * `checkSclCall` (called on each nested call here) calls this same
 * function again for THAT call's own pins. Each nested call gets:
 *   - The full same treatment as a top-level call (`checkSclCall` itself
 *     -- unknown-instruction, missing/unknown pins, memory-area checks,
 *     its OWN nested calls, etc.)
 *   - `checkNestedResultUsable` -- can this call's result be used as an
 *     argument at all (not `kind: none`, not non-storable)?
 *   - `checkNestedResultAgainstPin` -- when the containing pin's ENTIRE
 *     value is this one call (`pin.isSoleNestedCall`), does its result
 *     type match what that pin expects? */
function checkNestedCalls(
  call: CallNode,
  entry: InstructionEntry,
  block: ParsedBlockFile,
  blockIndex: BlockIndex,
  instanceTypes: Map<string, string>,
  typeCache: TypeCacheResult,
  ruleSet: RuleSet
): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  const pinMap = mapCallPinsToRegistryPins(call, entry);

  for (const pin of call.pins) {
    for (const nested of pin.nestedCalls) {
      diags.push(...checkSclCall(nested, ruleSet, blockIndex, instanceTypes, block, typeCache));

      const nestedResolution = resolveCallEntry(nested, ruleSet, blockIndex, instanceTypes);
      if (nestedResolution.kind !== "resolved") continue; // already reported by checkSclCall above
      const { found: nestedFound } = nestedResolution;

      diags.push(...checkNestedResultUsable(nested, nestedFound.entry, nestedFound.registryKey, ruleSet));

      const regPin = pinMap.get(pin);
      if (regPin) {
        diags.push(...checkNestedResultAgainstPin(nested, nestedFound.entry, nestedFound.registryKey, pin, regPin, block, blockIndex, typeCache, ruleSet));
      }
    }
  }
  return diags;
}

export function checkSclInstructions(block: ParsedBlockFile, ruleSet: RuleSet, blockIndex: BlockIndex, typeCache: TypeCacheResult): LintDiagnostic[] {
  const instanceTypes = buildInstanceTypeMap(block);
  const diags: LintDiagnostic[] = [];
  for (const call of block.sclCalls) {
    diags.push(...checkSclCall(call, ruleSet, blockIndex, instanceTypes, block, typeCache));
  }
  return diags;
}
