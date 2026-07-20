// Shared "give this bare, callShape: instance-dot catalog instruction call a
// real instance" edit-building logic (e.g. `MC_Power(...)`) -- TIA Portal
// itself offers two different ways to do this, and so do we:
//
//   - "Generate local multi-instance" -- a member declared
//     `<INSTANCE_TYPE>_Instance {InstructionName := '<INSTANCE_TYPE>'} :
//     <INSTANCE_TYPE>;` in the CALLING FUNCTION_BLOCK's own plain STATIC
//     `VAR` section (creating one if none exists yet), call rewritten to
//     `#<name>(...)`. Confirmed against a real TIA-generated .scl file.
//     `LibVersion` is deliberately omitted from the pragma -- confirmed
//     unnecessary, TIA Portal re-imports a multi-instance missing it
//     without complaint. ONLY legal inside a FUNCTION_BLOCK -- a FUNCTION
//     and an ORGANIZATION_BLOCK have no local Static section at all, so
//     neither can own a multi-instance (`buildInstanceDeclarationEdit`
//     refuses for either).
//   - "Generate single-instance DATA_BLOCK" -- a brand-new TOP-LEVEL
//     `DATA_BLOCK "<INSTANCE_TYPE>_DB" ... END_DATA_BLOCK` (see
//     `buildSingleInstanceDbText`'s own comment for the exact shape,
//     confirmed against scripts/fixtures/quick-fix/single-instance-db.scl
//     for this), call rewritten to the quoted external-reference form
//     `"<name>"(...)`. Legal from ANY of the three callable block types
//     (FUNCTION_BLOCK/FUNCTION/ORGANIZATION_BLOCK) -- a top-level DB never
//     depends on the CALLER's own section structure, and unlike the
//     multi-instance action, isn't restricted to a subset of instructions
//     either: offered for ANY `callShape: instance-dot` entry with a
//     confirmed `instanceType`. The generated DB's own
//     `S7_Optimized_Access` pragma is never guessed or looked up per
//     instruction -- it always mirrors the CALLING block's own header
//     pragma, read live off its actual text (`readEnclosingS7OptimizedAccess`).
//
// Reused by two different UI entry points, each handling the call-site
// rewrite its own way:
//   - providers/instanceQuickFixProvider.ts's CodeActionProvider, reacting
//     to the `instruction-needs-instance` diagnostic on an ALREADY-TYPED
//     bare call -- builds one WorkspaceEdit per offered action, each
//     covering both the declaration AND the call-site rewrite.
//   - providers/completion.ts's instruction completion list, as an
//     `additionalTextEdits` side effect of ACCEPTING a bare instance-dot
//     instruction from the list (same "auto-import" mechanism TypeScript's
//     own completion uses) -- the call-site rewrite there is just the
//     completion's own `insertText`, so only the declaration edit is
//     needed from here.
//
// Text-position-based rather than AST-based: parser/s7dclParser.ts's
// ParsedBlockFile never retains a VAR/END_VAR/BEGIN/block-header keyword's
// own line (only each member's), so this scans the document's raw lines
// directly for the enclosing block's header/BEGIN/END_xxx and an existing
// plain VAR section -- the same deliberate tolerance providers/completion.ts's
// own regex-based heuristics already apply elsewhere in this codebase.
import * as vscode from "vscode";
import { BlockIndex } from "../analysis/blockIndex";
import { TypeCacheResult } from "../cache/typeCache";
import { InstructionEntry, RuleSet } from "../rules/types";

const BLOCK_HEADER_RE = /^\s*(FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK)\b/;
const BEGIN_RE = /^\s*BEGIN\b/i;
const PLAIN_VAR_START_RE = /^\s*VAR\s*$/i;
const END_VAR_RE = /^\s*END_VAR\s*$/i;
/** Matches the calling block's OWN `S7_Optimized_Access := 'TRUE'/'FALSE'`
 * header pragma property, wherever it falls between the block keyword line
 * and `BEGIN` (TIA Portal doesn't always put the pragma immediately after
 * the header -- a `TITLE = '...'` line can come first, confirmed against
 * distributed-process-control.scl's own `FUNCTION_BLOCK "GasAlarms"`). Deliberately matches the
 * property directly rather than parsing the enclosing `{ ... }` block's
 * exact boundaries, since a real pragma can be single- or multi-line. */
const S7_OPTIMIZED_ACCESS_RE = /S7_Optimized_Access\s*:=\s*'(TRUE|FALSE)'/i;
/** Every kind of top-level declaration whose OWN name can collide with a
 * generated single-instance DB name -- matches both a quoted name (which
 * may contain spaces, e.g. `"Another test"`) and a bare identifier. `TYPE`
 * is included since a PLC data type (UDT) shares the same global namespace
 * a DATA_BLOCK name lives in. */
const TOP_LEVEL_DECL_RE = /^\s*(?:FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK|DATA_BLOCK|TYPE)\s+(?:"([^"]*)"|([A-Za-z_]\w*))/;

export type EnclosingBlockType = "FUNCTION_BLOCK" | "FUNCTION" | "ORGANIZATION_BLOCK";

export interface InstanceDeclarationPlan {
  instanceName: string;
  edit: vscode.TextEdit;
}

export interface SingleInstanceDeclarationPlan {
  dbName: string;
  edit: vscode.TextEdit;
}

export interface BlockSpan {
  startLine: number;
  endLine: number;
  beginLine: number;
  blockType: EnclosingBlockType;
}

export interface BlockInstanceContext {
  span: BlockSpan;
  existing?: { varStartLine: number; varEndLine: number };
}

/** Looks up `name` the same way linter/sclInstructionChecks.ts's own
 * `findEntry` does (dedicated SCL entry first, shared/FBD-cased fallback
 * second) -- but returns it only when `callShape` is `instance-dot`; a
 * `box`/`coil-ref` instruction is already directly callable and never needs
 * a declared instance at all, so there's nothing for this feature to offer
 * for one. */
/**
 * What a generated instance is an instance OF. Two shapes, because TIA writes
 * them differently:
 *   - a catalog instruction (`TON_TIME`) -- declared UNQUOTED and carrying an
 *     `InstructionName` pragma (on the multi-instance member, and in the
 *     single-instance DB's header);
 *   - a user FUNCTION_BLOCK (`"FB_Pump"`) -- declared QUOTED, with no
 *     `InstructionName` pragma, since it isn't a catalog instruction.
 * Keeping this as its own descriptor lets both builders below serve either
 * case instead of being tied to an `InstructionEntry`.
 */
export interface InstanceTypeRef {
  /** The bare name, never including quotes. */
  name: string;
  /** True for a user FUNCTION_BLOCK (written quoted in a declaration). */
  quoted: boolean;
}

/** The instance type of a catalog `instance-dot` instruction, if confirmed. */
export function instructionInstanceRef(entry: InstructionEntry): InstanceTypeRef | undefined {
  return entry.instanceType ? { name: entry.instanceType, quoted: false } : undefined;
}

/** A user FUNCTION_BLOCK as an instance type. */
export function fbInstanceRef(fbName: string): InstanceTypeRef {
  return { name: fbName, quoted: true };
}

/** How the type is written in a declaration -- quoted for an FB. */
function instanceTypeText(ref: InstanceTypeRef): string {
  return ref.quoted ? `"${ref.name}"` : ref.name;
}

export function findInstanceDotEntry(ruleSet: RuleSet, name: string): InstructionEntry | undefined {
  const scl = ruleSet.sclInstructions[name];
  if (scl && scl.callShape === "instance-dot") return scl;
  const shared = ruleSet.instructions[name];
  if (shared && shared.callShape === "instance-dot") return shared;
  return undefined;
}

/** `document`'s own end-of-line sequence -- every generated edit must use
 * this instead of a hardcoded `"\n"` so a CRLF document doesn't end up with
 * mixed line endings around the inserted text. */
function documentEol(document: vscode.TextDocument): string {
  return document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
}

/** The `[startLine, endLine]` (0-based, the two keyword lines themselves),
 * `beginLine`, and `blockType` of the FUNCTION_BLOCK/FUNCTION/
 * ORGANIZATION_BLOCK declaration enclosing `fromLine` -- found by scanning
 * backward for the nearest preceding block header, then forward for ITS
 * matching `END_<type>` and `BEGIN`. Blocks never nest in this grammar, so
 * the nearest preceding header is always the right one for a call inside
 * its own body. `undefined` if the text around `fromLine` doesn't look
 * like a well-formed block (never guessed). */
function findBlockSpan(document: vscode.TextDocument, fromLine: number): BlockSpan | undefined {
  let startLine = -1;
  let blockType: EnclosingBlockType | undefined;
  for (let line = fromLine; line >= 0; line--) {
    const m = BLOCK_HEADER_RE.exec(document.lineAt(line).text);
    if (m) {
      startLine = line;
      blockType = m[1] as EnclosingBlockType;
      break;
    }
  }
  if (startLine === -1 || !blockType) return undefined;

  const endRe = new RegExp(`^\\s*END_${blockType}\\b`);
  let endLine = -1;
  for (let line = startLine + 1; line < document.lineCount; line++) {
    if (endRe.test(document.lineAt(line).text)) {
      endLine = line;
      break;
    }
  }
  if (endLine === -1) return undefined;

  let beginLine = -1;
  for (let line = startLine + 1; line < endLine; line++) {
    if (BEGIN_RE.test(document.lineAt(line).text)) {
      beginLine = line;
      break;
    }
  }
  if (beginLine === -1) return undefined;

  return { startLine, endLine, beginLine, blockType };
}

/** The enclosing block's OWN `S7_Optimized_Access` value (`'TRUE'`/
 * `'FALSE'`), read directly from its header text between the block keyword
 * line and `BEGIN` -- `undefined` when the header carries no such property
 * at all (a bare `{}` pragma, or no pragma line at all). A generated
 * single-instance DB always mirrors THIS value rather than an instruction-
 * specific one: confirmed against real TIA Portal output, the instance DB
 * always matches whichever access mode the calling block itself already
 * uses. */
function readEnclosingS7OptimizedAccess(document: vscode.TextDocument, span: BlockSpan): "TRUE" | "FALSE" | undefined {
  for (let line = span.startLine + 1; line < span.beginLine; line++) {
    const m = S7_OPTIMIZED_ACCESS_RE.exec(document.lineAt(line).text);
    if (m) return m[1].toUpperCase() as "TRUE" | "FALSE";
  }
  return undefined;
}

/** The `[varStartLine, varEndLine]` of the block's own plain (STATIC) `VAR`
 * section -- distinct from `VAR_INPUT`/`VAR_OUTPUT`/`VAR_IN_OUT`/
 * `VAR_TEMP`/`VAR_CONSTANT`, none of which this regex matches (each has
 * more text after `VAR` on the same line). `undefined` when the block
 * declares no plain `VAR` section yet -- the caller creates one from
 * scratch in that case. */
function findExistingPlainVarSection(document: vscode.TextDocument, startLine: number, beginLine: number): { varStartLine: number; varEndLine: number } | undefined {
  for (let line = startLine + 1; line < beginLine; line++) {
    if (!PLAIN_VAR_START_RE.test(document.lineAt(line).text)) continue;
    for (let end = line + 1; end < beginLine; end++) {
      if (END_VAR_RE.test(document.lineAt(end).text)) return { varStartLine: line, varEndLine: end };
    }
  }
  return undefined;
}

/** `base`, or `base_1`/`base_2`/... the first suffix not already used as a
 * whole word anywhere in the block's own text span -- avoids colliding with
 * an existing member (of ANY section, not just the plain VAR one) or, in
 * the unlikely case of a repeat quick-fix/completion in the same block,
 * with a previously-generated instance name. Local to the enclosing FB, so
 * (unlike `uniqueGlobalName` below) this only ever looks at that one
 * block's own text span. */
function uniqueInstanceName(document: vscode.TextDocument, startLine: number, endLine: number, base: string): string {
  const lastLine = document.lineAt(endLine).text;
  const span = document.getText(new vscode.Range(startLine, 0, endLine, lastLine.length));
  let candidate = base;
  let n = 1;
  while (new RegExp(`\\b${candidate}\\b`, "i").test(span)) {
    candidate = `${base}_${n}`;
    n++;
  }
  return candidate;
}

/** Every top-level declaration name in `document` (FUNCTION_BLOCK/FUNCTION/
 * ORGANIZATION_BLOCK/DATA_BLOCK/TYPE) -- used to catch a same-file
 * collision that a possibly-stale workspace BlockIndex/TypeCacheResult
 * hasn't observed yet (e.g. a block the user just typed and hasn't saved),
 * the same tolerance the rest of this codebase already extends to a
 * mid-edit document. */
function documentTopLevelNames(document: vscode.TextDocument): string[] {
  const names: string[] = [];
  for (let i = 0; i < document.lineCount; i++) {
    const m = TOP_LEVEL_DECL_RE.exec(document.lineAt(i).text);
    if (m) names.push(m[1] ?? m[2]);
  }
  return names;
}

/** True if `name` is already taken by ANY globally addressable block
 * symbol -- a workspace DATA_BLOCK/FUNCTION_BLOCK/FUNCTION/
 * ORGANIZATION_BLOCK (`blockIndex`, already case-insensitive), a PLC data
 * type/UDT (`typeCache`), or a same-file top-level declaration the caches
 * above haven't indexed yet (`documentTopLevelNames`). Case-insensitive
 * throughout, matching real SCL symbol resolution. */
function isNameTaken(name: string, document: vscode.TextDocument, blockIndex: BlockIndex, typeCache: TypeCacheResult): boolean {
  if (blockIndex.get(name)) return true;
  const lower = name.toLowerCase();
  for (const key of typeCache.types.keys()) {
    if (key.toLowerCase() === lower) return true;
  }
  for (const docName of documentTopLevelNames(document)) {
    if (docName.toLowerCase() === lower) return true;
  }
  return false;
}

/** `base`, or `base_1`/`base_2`/... the first suffix not already taken --
 * see `isNameTaken`. Project-/source-global, unlike `uniqueInstanceName`
 * (which only ever checks one FB's own local text span). */
function uniqueGlobalName(document: vscode.TextDocument, blockIndex: BlockIndex, typeCache: TypeCacheResult, base: string): string {
  let candidate = base;
  let n = 1;
  while (isNameTaken(candidate, document, blockIndex, typeCache)) {
    candidate = `${base}_${n}`;
    n++;
  }
  return candidate;
}

/** Locates the enclosing block's span and its existing plain VAR section
 * (if any) ONCE -- shared across every instance-dot entry in one
 * completion request, so `providers/completion.ts` doesn't re-scan the
 * whole document once per candidate instruction, and shared between the
 * multi-instance and single-instance actions for the SAME call (see
 * providers/instanceQuickFixProvider.ts). `undefined` when the block can't
 * be confidently located (see `findBlockSpan`). */
export function resolveBlockInstanceContext(document: vscode.TextDocument, atLine: number): BlockInstanceContext | undefined {
  const span = findBlockSpan(document, atLine);
  if (!span) return undefined;
  const existing = findExistingPlainVarSection(document, span.startLine, span.beginLine);
  return { span, existing };
}

/** Builds the single edit that declares a fresh local multi-instance for
 * `entry`, given an already-resolved `ctx` (see `resolveBlockInstanceContext`).
 * `undefined` when this action isn't legal here at all: the enclosing block
 * isn't a FUNCTION_BLOCK (a FUNCTION/ORGANIZATION_BLOCK has no Static
 * section a multi-instance could live in -- never generated for either,
 * regardless of whether a plain VAR section happens to already exist), or
 * `entry` has no confirmed `instanceType` to declare the member AS. */
export function buildInstanceDeclarationEdit(document: vscode.TextDocument, ctx: BlockInstanceContext, ref: InstanceTypeRef): InstanceDeclarationPlan | undefined {
  if (ctx.span.blockType !== "FUNCTION_BLOCK") return undefined;

  const eol = documentEol(document);
  const instanceName = uniqueInstanceName(document, ctx.span.startLine, ctx.span.endLine, `${ref.name}_Instance`);
  // Only a catalog instruction carries the InstructionName pragma; an FB
  // multi-instance is a plain `name : "FB_X";` member.
  const pragma = ref.quoted ? "" : ` {InstructionName := '${ref.name}'}`;
  const memberLine = `\t${instanceName}${pragma} : ${instanceTypeText(ref)};`;

  const edit = ctx.existing
    ? vscode.TextEdit.insert(new vscode.Position(ctx.existing.varEndLine, 0), memberLine + eol)
    : vscode.TextEdit.insert(new vscode.Position(ctx.span.beginLine, 0), `VAR${eol}${memberLine}${eol}END_VAR${eol}${eol}`);

  return { instanceName, edit };
}

/** `findBlockSpan` + `buildInstanceDeclarationEdit` in one call -- for a
 * single-shot caller (the Quick Fix provider, which only ever handles one
 * diagnostic/entry at a time) that has no reason to keep the intermediate
 * `BlockInstanceContext` around itself. */
export function computeInstanceDeclarationEdit(document: vscode.TextDocument, atLine: number, ref: InstanceTypeRef): InstanceDeclarationPlan | undefined {
  const ctx = resolveBlockInstanceContext(document, atLine);
  if (!ctx) return undefined;
  return buildInstanceDeclarationEdit(document, ctx, ref);
}

/** One `{ Key := 'value'; ... }` pragma block in TIA Portal's own
 * pretty-printed style, confirmed against the single-instance DB fixture:
 * shares its line with the opening `{`, every following property starts a
 * new line with exactly one leading space (vertically aligning its own
 * name under the first property's), each non-last property ends in `;`,
 * and the LAST property ends in a single space then the closing `}` --
 * never a trailing `;` before it. A single-property pragma therefore
 * collapses onto one line (`{Key := 'value' }`) -- not separately
 * fixture-confirmed, but the only self-consistent reading of that same
 * rule with just one property. */
function formatPragmaBlock(props: [string, string][], eol: string): string {
  return props.map(([key, value], i) => `${i === 0 ? "{" : " "}${key} := '${value}'${i === props.length - 1 ? " }" : ";"}`).join(eol);
}

/** The exact single-instance DATA_BLOCK shape TIA Portal generates for a
 * bare catalog `instance-dot` instruction call, confirmed against
 * scripts/fixtures/quick-fix/single-instance-db.scl:
 *
 *   DATA_BLOCK "MC_POWER_DB"
 *   {InstructionName := 'MC_POWER';
 *    S7_Optimized_Access := 'TRUE' }
 *   MC_POWER
 *
 *   BEGIN
 *
 *   END_DATA_BLOCK
 *
 * `S7_Optimized_Access` is included ONLY when `s7OptimizedAccess` is
 * `'TRUE'`/`'FALSE'` -- mirrored from the CALLING block's own header
 * pragma (see `readEnclosingS7OptimizedAccess`), `undefined` (that block's
 * header carries no such property) omits it entirely rather than
 * defaulting to either value. The bare `<INSTANCE_TYPE>` line (no `:`, no
 * quotes, no `;`) is the DB's own type association -- NOT a member
 * declaration, this whole DB has no VAR section of its own at all,
 * matching a system-instruction instance DB's real shape (as opposed to a
 * custom FB's instance DB, which instead quotes its FB type name -- out of
 * scope here, see this module's file header). Ends with a blank line (an
 * empty string joined by `eol`) so a following top-level declaration this
 * is inserted before keeps its own separating blank line, exactly as
 * the fixture shows between `END_DATA_BLOCK` and the next `FUNCTION`. */
function buildSingleInstanceDbText(dbName: string, ref: InstanceTypeRef, s7OptimizedAccess: "TRUE" | "FALSE" | undefined, eol: string): string {
  // InstructionName identifies a CATALOG instruction; an FB instance DB has no
  // such pragma and names its FUNCTION_BLOCK quoted instead.
  const props: [string, string][] = ref.quoted ? [] : [["InstructionName", ref.name]];
  if (s7OptimizedAccess) props.push(["S7_Optimized_Access", s7OptimizedAccess]);
  const pragma = props.length > 0 ? formatPragmaBlock(props, eol) : undefined;
  const lines = [`DATA_BLOCK "${dbName}"`];
  if (pragma) lines.push(pragma);
  lines.push(instanceTypeText(ref), "", "BEGIN", "", "END_DATA_BLOCK", "", "");
  return lines.join(eol);
}

/** Builds the single edit that declares a fresh top-level single-instance
 * DATA_BLOCK for `entry`, inserted immediately before the enclosing block
 * (`ctx.span.startLine`) -- always a syntactically valid top-level
 * boundary, and never inside another block, since it sits between two
 * top-level declarations (or at the very top of the file). Legal from any
 * of the three callable block types, unlike the multi-instance action --
 * a top-level DB doesn't depend on the CALLER's own section structure at
 * all. Legal for ANY `callShape: instance-dot` entry with a confirmed
 * `instanceType` -- unlike the multi-instance action, single-instance DB
 * generation isn't restricted to a subset of instructions, so there's
 * nothing further to gate on here. The generated DB's `S7_Optimized_Access`
 * itself is read live off the CALLING block's own header, not looked up on
 * `entry` at all. */
export function buildSingleInstanceDbEdit(
  document: vscode.TextDocument,
  ctx: BlockInstanceContext,
  ref: InstanceTypeRef,
  blockIndex: BlockIndex,
  typeCache: TypeCacheResult
): SingleInstanceDeclarationPlan | undefined {
  const eol = documentEol(document);
  const dbName = uniqueGlobalName(document, blockIndex, typeCache, `${ref.name}_DB`);
  const s7OptimizedAccess = readEnclosingS7OptimizedAccess(document, ctx.span);
  const dbText = buildSingleInstanceDbText(dbName, ref, s7OptimizedAccess, eol);
  const edit = vscode.TextEdit.insert(new vscode.Position(ctx.span.startLine, 0), dbText);

  return { dbName, edit };
}

/** `resolveBlockInstanceContext` + `buildSingleInstanceDbEdit` in one call
 * -- see `computeInstanceDeclarationEdit`'s own comment for why a
 * single-shot caller wants this instead. */
export function computeSingleInstanceDbEdit(
  document: vscode.TextDocument,
  atLine: number,
  ref: InstanceTypeRef,
  blockIndex: BlockIndex,
  typeCache: TypeCacheResult
): SingleInstanceDeclarationPlan | undefined {
  const ctx = resolveBlockInstanceContext(document, atLine);
  if (!ctx) return undefined;
  return buildSingleInstanceDbEdit(document, ctx, ref, blockIndex, typeCache);
}

/** The identifier `document`'s text starts with at `position` -- used to
 * find the exact range of a bare call's NAME (e.g. `MC_Power` in
 * `MC_Power(Enable := TRUE)`), since a LintDiagnostic's own
 * `vscode.Diagnostic.range` (see extension.ts's `toVscodeDiagnostic`)
 * deliberately spans to the END OF THE LINE (no end-column is tracked for
 * any diagnostic), not just the offending identifier. `undefined` at a
 * position not immediately followed by an identifier character (shouldn't
 * happen for a real `instruction-needs-instance` diagnostic's own start
 * position, but never guessed). */
/** The QUOTED external reference `document`'s text starts with at `position`
 * (e.g. `"FB_Pump"` in `"FB_Pump".member`), including both quotes -- the
 * `dot-access-needs-instance` diagnostic points at the opening quote, and its
 * fix must replace the whole quoted token (with `#instance` or a new DB's
 * quoted name). `undefined` when the position isn't at one. */
export function quotedNameRangeAt(document: vscode.TextDocument, position: vscode.Position): { range: vscode.Range; name: string } | undefined {
  const rest = document.lineAt(position.line).text.slice(position.character);
  const m = /^"([A-Za-z_][A-Za-z0-9_]*)"/.exec(rest);
  if (!m) return undefined;
  return {
    range: new vscode.Range(position, position.translate(0, m[0].length)),
    name: m[1],
  };
}

export function identifierRangeAt(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
  const rest = document.lineAt(position.line).text.slice(position.character);
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
  if (!m) return undefined;
  return new vscode.Range(position, position.translate(0, m[0].length));
}
