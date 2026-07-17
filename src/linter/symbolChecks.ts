// Two checks built on top of analysis/symbolTable.ts's per-block symbol
// resolution -- see that module's own header for the resolution
// algorithm and its deliberate limits.
//
// 1. checkUndeclaredIdentifiers: every `#tag(.member)*` reference found
//    anywhere in a block (a call's own pin values, plus -- for an SCL
//    body -- every other bare reference too, e.g. a plain assignment's
//    RHS or an IF condition) must have a BASE tag declared somewhere in
//    the block's own VAR sections. Only `kind: "undeclared"` is ever
//    flagged; `kind: "unresolved-path"` (a later `.member` segment this
//    pass can't model, e.g. an array index) is silently accepted --
//    "can't fully verify" is not the same as "wrong".
// 2. checkSclConditionTypes: SCL-only. For every `IF`/`WHILE`/`UNTIL`
//    condition the parser recognized as ENTIRELY a single, optionally
//    negated tag reference (parser/s7dclParser.ts's `SclConditionCheck`
//    -- anything more complex was never recorded at all), flags it if
//    the tag resolves to a real, non-Bool type. An undeclared base tag
//    is NOT re-flagged here -- checkUndeclaredIdentifiers already covers
//    it (the same tag reference is also collected as a plain
//    `OperandRef` by the parser), so this only reports the "resolved but
//    wrong type" case to avoid a duplicate diagnostic on one symbol.
// 3. checkIllegalDotAccess: every `#tag(.member)*`/`"External".member`
//    reference whose resolution came back `illegal-dot-access` (see
//    analysis/symbolTable.ts's own doc comment) -- a `.member` step that
//    DOES exist, but isn't legally dot-readable: VAR_TEMP/VAR_CONSTANT
//    members are never externally exposed, and a FUNCTION (no instance
//    data at all) can never be dot-accessed regardless of section. Shares
//    `collectAllOperandRefs` with checkUndeclaredIdentifiers, so this
//    applies identically to BOTH a `.s7dcl` RUNG pin value and an SCL
//    body reference (assignment, condition, call argument, ...).
import { BlockIndex } from "../analysis/blockIndex";
import { ResolvedSymbol, resolveOperandRef } from "../analysis/symbolTable";
import { TypeCacheResult } from "../cache/typeCache";
import { OperandRef, ParsedBlockFile } from "../parser/s7dclParser";
import { typeRefTopLevelName } from "../parser/typeRef";
import { RuleSet } from "../rules/types";
import { formatDiagnostic, LintDiagnostic } from "./diagnostics";

/** `#tag.member` for a local reference, `"Name".member` for an external
 * one (see `OperandRef.external`) -- matches how each shape actually
 * appears in real source, for readable diagnostic messages. */
function operandRefText(ref: OperandRef): string {
  const [first, ...rest] = ref.segments;
  const base = ref.external ? `"${first}"` : `#${first}`;
  return [base, ...rest].join(".");
}

function collectAllOperandRefs(block: ParsedBlockFile): OperandRef[] {
  const refs: OperandRef[] = [...block.sclOperandRefs];
  for (const call of block.sclCalls) {
    for (const pin of call.pins) refs.push(...pin.operandRefs);
  }
  for (const network of block.networks) {
    for (const rung of network.rungs) {
      for (const call of rung.calls) {
        for (const pin of call.pins) refs.push(...pin.operandRefs);
      }
    }
  }
  return refs;
}

export function checkUndeclaredIdentifiers(
  block: ParsedBlockFile,
  blockIndex: BlockIndex,
  typeCache: TypeCacheResult,
  ruleSet: RuleSet
): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  for (const ref of collectAllOperandRefs(block)) {
    const resolved: ResolvedSymbol = resolveOperandRef(ref.segments, block, blockIndex, typeCache, ruleSet, ref.external);
    if (resolved.kind === "undeclared") {
      if (ref.external) {
        diags.push(formatDiagnostic(ruleSet, "external-symbol-not-found", ref.line, ref.col, { name: ref.segments[0] }));
      } else {
        diags.push(formatDiagnostic(ruleSet, "undeclared-identifier", ref.line, ref.col, { ref: operandRefText(ref) }));
      }
    }
  }
  return diags;
}

/** See file header's item 3. */
export function checkIllegalDotAccess(
  block: ParsedBlockFile,
  blockIndex: BlockIndex,
  typeCache: TypeCacheResult,
  ruleSet: RuleSet
): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  for (const ref of collectAllOperandRefs(block)) {
    const resolved: ResolvedSymbol = resolveOperandRef(ref.segments, block, blockIndex, typeCache, ruleSet, ref.external);
    if (resolved.kind === "illegal-external-block-type") {
      diags.push(
        formatDiagnostic(ruleSet, "dot-access-needs-instance", ref.line, ref.col, {
          blockName: resolved.blockName,
          blockType: resolved.blockType.replace(/_/g, " ").toLowerCase(),
        })
      );
      continue;
    }
    if (resolved.kind !== "illegal-dot-access") continue;
    if (resolved.blockType === "FUNCTION") {
      diags.push(
        formatDiagnostic(ruleSet, "dot-access-no-instance", ref.line, ref.col, { blockName: resolved.blockName, memberName: resolved.memberName })
      );
    } else {
      diags.push(
        formatDiagnostic(ruleSet, "dot-access-illegal-section", ref.line, ref.col, {
          blockName: resolved.blockName,
          memberName: resolved.memberName,
          section: resolved.section,
        })
      );
    }
  }
  return diags;
}

export function checkSclConditionTypes(
  block: ParsedBlockFile,
  blockIndex: BlockIndex,
  typeCache: TypeCacheResult,
  ruleSet: RuleSet
): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  for (const check of block.sclConditionChecks) {
    if (check.kind === "bare-identifier") {
      // Real TIA SCL syntax requires `#` for a local reference or quotes
      // for a global one (e.g. `"PMP_RUN_FB"`) -- a bare, unquoted word
      // is invalid operand syntax regardless of whether anything by that
      // name is declared anywhere, so this is always an error, no
      // symbol-table lookup needed.
      const shown = (check.negated ? "NOT " : "") + check.name;
      diags.push(
        formatDiagnostic(ruleSet, "condition-not-a-tag", check.line, check.col, { keyword: check.keyword, shown, name: check.name })
      );
      continue;
    }
    const resolved: ResolvedSymbol = resolveOperandRef(check.ref.segments, block, blockIndex, typeCache, ruleSet, check.ref.external);
    if (resolved.kind !== "resolved") continue; // "undeclared"/"illegal-dot-access" already reported elsewhere; "unresolved-path" -- can't verify, don't guess
    const topLevelName = typeRefTopLevelName(resolved.typeRef);
    if (topLevelName === "Bool") continue;
    const shown = (check.negated ? "NOT " : "") + operandRefText(check.ref);
    diags.push(
      formatDiagnostic(ruleSet, "condition-not-bool", check.line, check.col, {
        keyword: check.keyword,
        shown,
        typeName: topLevelName ?? "?",
      })
    );
  }
  return diags;
}
