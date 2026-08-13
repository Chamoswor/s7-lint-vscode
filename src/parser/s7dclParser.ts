// Parses .s7dcl LAD/FBD block exports: the outer grammar documented in
// docs/fbd-knowhow/00-Overview.md (pragma blocks,
// FUNCTION_BLOCK/FUNCTION/ORGANIZATION_BLOCK/DATA_BLOCK, VAR_* sections,
// NETWORK/RUNG/END_RUNG) down to individual instruction calls (box,
// instance-dot, and coil-ref -- the latter two are syntactically
// identical to a box call; instruction-registry's `callShape` field is
// what actually distinguishes them, not this parser).
//
// This is a tolerant, best-effort parser: unrecognized tokens at any
// level are skipped rather than raising a hard parse error, so a lint
// pass degrades gracefully on grammar this parser doesn't yet model
// (e.g. `wire#` branch labels after RUNG, GRAPH-only constructs) instead
// of losing every diagnostic in the file.
import { Lexer, Token, TokenCursor } from "./lexer";
import { isLiteralOrWireTail, literalRunLength, tokensAdjacent } from "./literalRun";
import { Pragma, parsePragmaBlock } from "./pragma";
import { MemberRef, parseTypeRefFromCursor } from "./typeRef";

export type PinDir = "in" | "out" | null;

/** A `#tag(.member)*` reference found somewhere in code (a call's pin
 * value, or a bare SCL statement/condition/assignment) -- `segments` is
 * the tag name plus every `.member` after it, none of them `#`/`.`-
 * prefixed. Feeds `analysis/symbolTable.ts`'s declared-type resolution;
 * see `linter/symbolChecks.ts` for the "is this even declared" and
 * "does this resolve to Bool" checks built on top of it. An indexed
 * access (`#arr[0]`) or a quoted member name ends the chain early --
 * only the segments actually captured are returned, still useful for
 * checking the BASE tag's own declaration. */
export interface OperandRef {
  segments: string[];
  line: number;
  col: number;
  /** True when `segments[0]` came from a bare double-quoted `"Name"`
   * reference (Siemens' own external-symbol convention -- a global
   * DATA_BLOCK, a plain FUNCTION, or an FB's own external instance DB)
   * rather than a local `#tag` -- see `looksLikeExternalRefStart`.
   * `segments[0]` is then a WORKSPACE BLOCK name to resolve directly via
   * BlockIndex (`analysis/symbolTable.ts`'s `resolveOperandRef` `isExternal`
   * parameter), not a local VAR declaration. Omitted (falsy) for the
   * ordinary local `#tag(.member)*` shape. */
  external?: boolean;
  /** True when this LOCAL reference was written without its `#` -- the
   * spelling TIA's importer resolves against the block's own declarations
   * (see `LocalTagNames`). Resolution is identical either way; this exists
   * only so a diagnostic quotes the reference back the way it was actually
   * written. */
  bare?: boolean;
}

/** An SCL `IF`/`WHILE`/`UNTIL` condition that is ENTIRELY a single,
 * optionally-`NOT`-prefixed operand -- e.g. `IF #done THEN`, `WHILE NOT
 * #stop DO`. Only ever recorded when the condition is exactly this
 * simple (see `peekSimpleCondition`); anything with a comparison,
 * `AND`/`OR`, a function call, etc. is silently skipped -- there's no
 * general expression-type-inference here, see linter/symbolChecks.ts's
 * `checkSclConditionTypes`.
 *
 * Two shapes: `kind: "tag"` is a real tag reference -- `#tag(.member)*`, or
 * the equivalent `#`-less spelling of a tag this block itself declares
 * (`LocalTagNames`) -- checked against the symbol table for its resolved
 * type. `kind: "bare-identifier"` is a plain word with neither a `#` prefix
 * (a local reference), nor quotes (a global tag reference, e.g.
 * `"PMP_RUN_FB"` -- confirmed real TIA SCL syntax), nor a matching local
 * declaration -- this project has no global PLC tag table to resolve a
 * quoted reference against, so a QUOTED condition is simply never recorded
 * at all (nothing to check), but a word no scope can resolve is invalid
 * operand syntax -- always an error, no type resolution needed. Boolean
 * literals (`TRUE`/`FALSE`) and reserved keywords are excluded from this,
 * and a bare word immediately followed by `(` (a function call) is left
 * unrecorded entirely (too complex to verify). */
export type SclConditionCheck =
  | { keyword: "IF" | "WHILE" | "UNTIL"; kind: "tag"; negated: boolean; ref: OperandRef; line: number; col: number }
  | { keyword: "IF" | "WHILE" | "UNTIL"; kind: "bare-identifier"; negated: boolean; name: string; line: number; col: number };

export interface PinArg {
  name: string | null;
  dir: PinDir;
  valueText: string;
  /** Every `#tag(.member)*` reference found within this pin's own value
   * expression (there can be more than one, e.g. `in1 := #a + #b`). */
  operandRefs: OperandRef[];
  /** Every instruction/instance call found ANYWHERE within this pin's own
   * value expression -- e.g. `IN1 := ABS(#x)` (one), or `#a + ABS(#b)`
   * (one, alongside the `#a` operand ref above), or nested arbitrarily
   * deep (`ABS(ABS(#x))` -- the inner `ABS` shows up as a nested call on
   * the OUTER `ABS`'s own single pin, whose OWN `nestedCalls` in turn
   * holds nothing further only because there's nothing deeper here).
   * Empty for a plain operand/literal value. See `collectArgValue`. */
  nestedCalls: CallNode[];
  /** True when this pin's ENTIRE value is exactly ONE nested call and
   * nothing else (no operator, no second term) -- lets a lint check
   * compare that call's OWN result type against this pin's OWN expected
   * `dataTypes`, the same way an assignment's `#lhs := Call(...)` already
   * compares against the LHS variable's declared type. `false` for a call
   * that's merely ONE TERM in a larger expression (e.g. `#a + ABS(#b)`) --
   * the nested call itself is still fully checked either way (see
   * `nestedCalls` above), just not tied to this pin's own expected type in
   * that case, since inferring the WHOLE expression's result type needs
   * real operator type-inference this parser doesn't do. */
  isSoleNestedCall: boolean;
  line: number;
  col: number;
}

export interface CallNode {
  name: string;
  /** Instance tag name for `#Instance.Name(...)` calls; null for a flat `Name(...)` call. */
  instancePrefix: string | null;
  pins: PinArg[];
  pragma?: Pragma;
  line: number;
  col: number;
  /** True when this call is the entire right-hand side of a plain SCL
   * `<lhs> := Call(...)` assignment (the token immediately before the call
   * was `:=`) -- lets a lint check flag assigning FROM a call whose
   * registry entry has no result (`result.kind: none`) or a non-storable
   * one (e.g. `TypeOf`'s type-expression result). Always `undefined` for a
   * RUNG-based LAD/FBD call (`parseRung` never sets this -- a box call's
   * OWN pins use `:=`/`=>`, but the call itself is never the RHS of an
   * outer assignment in that grammar). Only set by `parseSclBody`. */
  isAssignmentRhs?: boolean;
  /** The LHS operand chain when `isAssignmentRhs` is true -- the same
   * `OperandRef` also appended to `ParsedBlockFile.sclOperandRefs`, kept
   * here too so a lint check can resolve what's actually receiving this
   * call's result without re-deriving it. Only set when the LHS is a real
   * `#tag(.member)*` chain (always true for legal SCL assignment syntax);
   * absent whenever `isAssignmentRhs` is undefined/false. */
  assignmentTarget?: OperandRef;
  /** Set instead of `name`/`instancePrefix` when the call target is a bare
   * double-quoted `"Name"(...)` -- Siemens' own external-symbol convention
   * for calling a workspace FUNCTION directly, or an FB's own external
   * instance DB, by its quoted name (see `looksLikeExternalRefStart`).
   * `name`/`instancePrefix` are both left empty/null in this shape --
   * resolution goes straight to `analysis/blockIndex.ts`'s BlockIndex by
   * this name, not the instruction registry (see
   * `linter/sclInstructionChecks.ts`'s `resolveCallEntry`). */
  externalName?: string;
}

export interface WireLabel {
  /** The name AFTER `wire#` (e.g. "powerrail", "w1") -- the logical wire
   * identity shared between a RUNG's own header, an inline branch-tap
   * declaration inside another RUNG's body, and a trailing `END_RUNG`
   * label -- see linter/ladWiringChecks.ts. */
  name: string;
  line: number;
  col: number;
}

export interface RungNode {
  calls: CallNode[];
  /** This RUNG's own `RUNG wire#X` header, if it has one (vs. `RUNG TRUE`,
   * `RUNG #tag`, or a bare `RUNG` -- none of those are wire-rooted, so
   * they're left undefined here rather than guessed at). */
  wireHeader?: WireLabel;
  /** Every inline `wire#X` branch-tap declared somewhere in this RUNG's
   * own body (e.g. the `wire#w1` between two calls in a real export) --
   * each one makes wire X reachable from wherever THIS rung is reachable. */
  bodyWireLabels: WireLabel[];
  /** This RUNG's trailing `END_RUNG wire#X` label, if it has one -- the
   * rung's own OUTPUT feeding forward into wire X. */
  endWireLabel?: WireLabel;
}

export interface NetworkNode {
  pragma?: Pragma;
  rungs: RungNode[];
}

export interface VarSection {
  kind: string; // VAR | VAR_INPUT | VAR_OUTPUT | VAR_IN_OUT | VAR_TEMP | VAR_CONSTANT
  members: MemberRef[];
}

export interface ParsedBlockFile {
  blockType: "FUNCTION_BLOCK" | "FUNCTION" | "ORGANIZATION_BLOCK" | "DATA_BLOCK";
  name: string;
  /** For a DATA_BLOCK: the type this DB is an INSTANCE of, written as a bare
   * line in the header between the pragma and `BEGIN`. Two shapes, told apart
   * by `quoted`:
   *   - unquoted -- an instruction/system instance type, e.g.
   *     `DATA_BLOCK "R_TRIG_DB" {InstructionName := 'R_TRIG'} R_TRIG` (the
   *     exact shape providers/instanceQuickFix.ts generates, confirmed by
   *     scripts/fixtures/quick-fix/single-instance-db.scl);
   *   - quoted -- a user FUNCTION_BLOCK single-instance DB (or a
   *     PLC-data-type-based DB), e.g. `DATA_BLOCK "Pump_DB" ... "FB_Pump"`,
   *     since user block/UDT names are always quoted in this grammar.
   * Undefined for a global DB (one with its own VAR section or outer STRUCT)
   * and for
   * every non-DATA_BLOCK. */
  instanceOf?: { name: string; quoted: boolean };
  /** A DATA_BLOCK header pragma's `InstructionName` value, when present --
   * the authoritative instruction identity for an instruction instance DB
   * (TIA writes it alongside the unquoted `instanceOf` line). */
  instructionName?: string;
  /** Explicit S7_Optimized_Access block/file pragma. Undefined when the
   * source does not state an access mode. */
  optimizedAccess?: boolean;
  varSections: VarSection[];
  networks: NetworkNode[];
  /** Instruction/instance calls found in a `BEGIN ... END_xxx` SCL statement
   * body (flat -- IF/CASE/FOR/WHILE/REPEAT/REGION nesting isn't modeled,
   * same "just find the calls" tolerance `parseRung` already applies to a
   * LAD/FBD RUNG's body). Empty for a NETWORK/RUNG-based LAD/FBD file. */
  sclCalls: CallNode[];
  /** Every `#tag(.member)*` reference found in the SCL body OUTSIDE of a
   * call's own pin values (e.g. a bare assignment's RHS, an `IF`
   * condition) -- a call's own pin-value refs live on that pin's own
   * `operandRefs` instead, see `PinArg`. Empty for a NETWORK/RUNG-based
   * LAD/FBD file (there's no statement body to walk). */
  sclOperandRefs: OperandRef[];
  /** Every simple, fully-checkable `IF`/`WHILE`/`UNTIL` condition found in
   * the SCL body -- see `SclConditionCheck`. Empty for a LAD/FBD file. */
  sclConditionChecks: SclConditionCheck[];
  /** Every plain `#lhs := <expr>;` SCL assignment whose RHS was fully
   * parsed into a real expression tree -- see `SclAssignmentExpr`. Empty
   * for a LAD/FBD file (no statement body to walk), and for an SCL body
   * with no assignments recognizable by this still-limited grammar. */
  sclAssignments: SclAssignmentExpr[];
  /** Every plain `#lhs := <expr>` SCL assignment whose RHS parsed as a
   * clean, complete expression (see `SclAssignmentExpr`'s own comment) but
   * whose very next token wasn't the required terminating `;` -- see
   * `parseSclBody`'s own comment on this exact signal. Superseded as the
   * user-facing diagnostic source by linter/synStructureChecks.ts's own,
   * independent `syn-missing-semicolon` check (a general structural pass,
   * not limited to this narrow "did the expression grammar happen to
   * finish cleanly" shape), so nothing currently reads this field -- kept
   * for parity with `parseSclBody`'s own return shape rather than
   * discarded, in case a future caller wants THIS narrower signal
   * specifically. */
  sclMissingSemicolons: { line: number; col: number }[];
}

const BLOCK_KEYWORDS = ["FUNCTION_BLOCK", "FUNCTION", "ORGANIZATION_BLOCK", "DATA_BLOCK"] as const;

/** Standalone header markers that are NOT a DATA_BLOCK's instance-of type --
 * everything else bare in a DB header is that type (see
 * `ParsedBlockFile.instanceOf`). Entries written as `KEY : value` / `KEY =
 * value` (VERSION/TITLE/AUTHOR/...) are excluded by shape instead, so this
 * only needs the keywords that appear alone on a line. */
const DB_HEADER_KEYWORDS = new Set(["NON_RETAIN", "RETAIN", "READ_ONLY", "UNLINKED", "BEGIN"]);
const VAR_KEYWORDS = ["VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT", "VAR_TEMP", "VAR_CONSTANT", "VAR"];

/** SCL's own reserved statement/operator keywords -- a real instruction
 * name can never collide with one of these (reserved words aren't legal
 * identifiers in SCL either), but several of them are routinely followed
 * immediately by `(` in real code (`IF (...) THEN`, `... AND (...)`,
 * `ELSIF (...)`) -- exactly the same token shape `tryParseCall`'s bare
 * `Name(...)` box-call branch matches. Without this exclusion, an SCL
 * statement body (parseSclBody) would misparse e.g. `AND (#a > #b)` as a
 * call to a (nonexistent) instruction literally named "AND". Only
 * consulted when `allowBareInstanceCall` is set (i.e. inside an SCL body)
 * -- a LAD/FBD RUNG never contains these keywords as text at all. */
export const SCL_RESERVED_KEYWORDS = new Set([
  "IF", "THEN", "ELSE", "ELSIF", "END_IF",
  "CASE", "OF", "END_CASE",
  "FOR", "TO", "BY", "DO", "END_FOR",
  "WHILE", "END_WHILE",
  "REPEAT", "UNTIL", "END_REPEAT",
  "CONTINUE", "EXIT", "GOTO", "RETURN",
  "REGION", "END_REGION",
  "AND", "OR", "XOR", "NOT", "MOD",
]);

/**
 * True if `stringToken` is the NAME half of a quoted LOCAL tag (`#"Tag"`),
 * i.e. the token before it is a lone, adjacent `#`.
 *
 * The token-walking loops below advance one token at a time and record a
 * reference by PEEKING (`peekOperandRefChain` consumes nothing), so the
 * quoted name is looked at again on the next iteration -- where, followed by
 * a `.`, it matches the `"Block".member` EXTERNAL-reference shape exactly.
 * Without this guard every `#"Tag".member` was recorded twice: once
 * correctly as a local tag, and once as a reference to a workspace block
 * that does not exist, which then failed `external-symbol-not-found`.
 */
function isQuotedLocalTagName(prevToken: Token | null, stringToken: Token): boolean {
  return (
    !!prevToken &&
    prevToken.kind === "ident" &&
    prevToken.text === "#" &&
    stringToken.kind === "string" &&
    tokensAdjacent(prevToken, stringToken)
  );
}

/**
 * True if `stringToken` is a quoted MEMBER inside a dot-chain (`....."Name"`)
 * rather than the head of a new `"Block".member` external reference -- told
 * apart by the `.` immediately before it.
 *
 * Same re-examination problem `isQuotedLocalTagName` guards: the chain was
 * already recorded whole by a peek, but the walking loop still steps over its
 * inner tokens one by one, and a quoted member followed by a further `.`
 * matches the external-reference shape exactly. Without this, every quoted
 * member mid-chain was ALSO recorded as a reference to a workspace block
 * named after that member.
 */
function isQuotedChainMember(prevToken: Token | null, stringToken: Token): boolean {
  return !!prevToken && prevToken.kind === "punct" && prevToken.text === "." && stringToken.kind === "string";
}

function skipToSemicolon(cur: TokenCursor): void {
  let depth = 0;
  while (!cur.atEnd()) {
    const t = cur.peek();
    if (t.kind === "punct" && (t.text === "(" || t.text === "[")) depth++;
    if (t.kind === "punct" && (t.text === ")" || t.text === "]")) depth--;
    if (t.kind === "punct" && t.text === "{") {
      parsePragmaBlock(cur);
      continue;
    }
    if (t.kind === "punct" && t.text === ";" && depth <= 0) {
      cur.next();
      return;
    }
    cur.next();
  }
}

function parseVarMember(cur: TokenCursor): MemberRef {
  // Pragma precedes the name in a .s7dcl EXPORT's VAR sections -- see
  // udt-dependency-cache.md's "UDT reference syntax inside a .s7dcl BLOCK
  // file" section. An authored .scl source file's VAR sections instead
  // follow the SAME convention parseMemberFromCursor already uses for
  // STRUCT bodies -- pragma AFTER the name, before `:` (confirmed against
  // real project .scl files, e.g. `R_TRIG_Instance {InstructionName :=
  // 'R_TRIG'; ...} : R_TRIG;`) -- so both positions are checked here.
  if (cur.isPunct("{")) parsePragmaBlock(cur);
  const nameTok = cur.next();
  if (cur.isPunct("{")) parsePragmaBlock(cur);
  cur.tryPunct(":");
  const typeRef = parseTypeRefFromCursor(cur);
  skipToSemicolon(cur); // consumes an optional `:= default` and the terminating `;`
  // A reserved-word member name must be quoted in source (e.g. `"Name" :
  // String;`, since `Name` collides with a keyword) -- store the
  // UNQUOTED value so a `#Name` reference elsewhere resolves against the
  // same key, matching the convention parseBlockDeclaration's own
  // block-name handling already uses.
  const name = nameTok.kind === "string" ? (nameTok.value ?? nameTok.text) : nameTok.text;
  return { name, typeRef, line: nameTok.line };
}

/** True at a `#tag` (a combined `#`+ident token) OR a `#"Quoted Tag"`
 * reference (a reserved-word/space-containing name needs quoting, so the
 * lexer produces a bare "#" ident token immediately followed by a
 * separate STRING token, e.g. `#"Local_CurrentOperatingMode"`) -- both
 * are real operand references, just two different token shapes for the
 * same syntax. Used instead of a plain `text.startsWith("#")` check so
 * the quoted form isn't silently treated as an empty-name reference. */
function looksLikeOperandRefStartAt(cur: TokenCursor, offset: number, localTags?: LocalTagNames): boolean {
  const t0 = cur.peek(offset);
  if (t0.kind !== "ident") return false;
  if (!t0.text.startsWith("#")) {
    // The `#`-less spelling of a local reference (`LocalTagNames`). NOT
    // when followed by `(` -- that's a call, `tryParseCall`'s business, and
    // treating it as an operand here would swallow the callee name.
    if (!localTagName(t0.text, localTags)) return false;
    const next = cur.peek(offset + 1);
    return !(next.kind === "punct" && next.text === "(");
  }
  if (t0.text.length > 1) return true;
  return cur.peek(offset + 1).kind === "string";
}

function looksLikeOperandRefStart(cur: TokenCursor, localTags?: LocalTagNames): boolean {
  return looksLikeOperandRefStartAt(cur, 0, localTags);
}

/** True at a bare double-quoted `"Name"` token used as a dot-chain BASE --
 * i.e. immediately followed by `.member`. Siemens quotes an external
 * workspace-block reference (a global DATA_BLOCK, a plain FUNCTION, or an
 * FB's own external instance DB) with double quotes; a SINGLE-quoted
 * `'text'` is always ordinary STRING value data, never a symbolic
 * reference, so quote CHARACTER alone already disambiguates those two
 * (the lexer doesn't tag which one was used at the token-`kind` level --
 * see lexer.ts's own string-tokenizing code -- so this checks the raw
 * `.text`'s first character directly, same as `parser/typeRef.ts`'s own
 * quoted-type-reference handling). But a double-quoted token WITHOUT a
 * following dot is left alone here -- TIA/SCL also allows a double-quoted
 * WSTRING literal (`"Some wide text"`), and requiring a following `.` is
 * what tells the two apart: a real external reference's whole POINT is to
 * be dotted into, an actual WSTRING value never is. (A double-quoted call
 * TARGET, `"Name"(...)`, is a separate shape handled by `tryParseCall`
 * directly, unambiguous there since a WSTRING literal is never immediately
 * followed by `(` either.) */
function looksLikeExternalRefStartAt(cur: TokenCursor, offset: number): boolean {
  const t0 = cur.peek(offset);
  if (t0.kind !== "string" || !t0.text.startsWith('"')) return false;
  const t1 = cur.peek(offset + 1);
  return t1.kind === "punct" && t1.text === ".";
}

function looksLikeExternalRefStart(cur: TokenCursor): boolean {
  return looksLikeExternalRefStartAt(cur, 0);
}

/** Builds a `#tag(.member)*` chain's `OperandRef` by PEEKING ONLY (the
 * cursor isn't advanced) -- the caller's own normal per-token loop still
 * consumes the base tag and every `.`/member token exactly as before;
 * this just additionally records the chain shape alongside that
 * unchanged consumption. Only call when `looksLikeOperandRefStart` is
 * true. Stops at the first token that isn't `.ident` (an index `[`, a
 * quoted member, an operator, ...) -- everything up to that point is
 * still a real, useful chain to check. */
/** Same contract as `peekOperandRefChain`, but starting `startOffset`
 * tokens ahead of the cursor's current position instead of always at it --
 * lets `peekExprAt`'s expression parser (which advances a LOCAL offset,
 * never the real cursor) reuse the exact same chain-building logic. Also
 * returns how many tokens the chain consumed, so the caller can advance
 * its own offset past it. */
/**
 * The member name `tok` contributes to a `.member` chain, or `null` if it
 * can't be one. A member is normally a plain ident, but Siemens QUOTES any
 * name that isn't a legal bare identifier -- one starting with a digit, or
 * colliding with a reserved word -- and both spellings address the same
 * member, so the quoted form is decoded to the SAME segment text the
 * declaration side stores (see `parseVarMember`). Recognising only the ident
 * spelling truncated the chain at the quote, which then left the quoted token
 * to be re-read as an unrelated statement.
 */
function memberSegmentName(tok: Token): string | null {
  if (tok.kind === "ident") return tok.text;
  if (tok.kind === "string" && tok.text.startsWith('"')) return tok.value ?? "";
  return null;
}

function peekOperandRefChainAt(cur: TokenCursor, startOffset: number, localTags?: LocalTagNames): { ref: OperandRef; length: number } {
  const hashTok = cur.peek(startOffset);
  let offset: number;
  let firstSegment: string;
  // The bare, `#`-less spelling of a local reference -- reported with the
  // tag's DECLARED spelling so resolution and rename grouping don't depend
  // on how the reference happened to be cased (see `LocalTagNames`).
  const bareTag = localTagName(hashTok.text, localTags);
  if (bareTag) {
    firstSegment = bareTag;
    offset = startOffset + 1;
  } else if (hashTok.text === "#") {
    // `#"Quoted Tag"` -- the quoted form, see `looksLikeOperandRefStart`.
    firstSegment = cur.peek(startOffset + 1).value ?? "";
    offset = startOffset + 2;
  } else {
    firstSegment = hashTok.text.slice(1);
    offset = startOffset + 1;
  }
  const segments = [firstSegment];
  for (;;) {
    const dot = cur.peek(offset);
    const member = cur.peek(offset + 1);
    if (dot.kind !== "punct" || dot.text !== ".") break;
    const memberName = memberSegmentName(member);
    if (memberName === null) break;
    segments.push(memberName);
    offset += 2;
  }
  return { ref: { segments, line: hashTok.line, col: hashTok.col, ...(bareTag ? { bare: true } : {}) }, length: offset - startOffset };
}

function peekOperandRefChain(cur: TokenCursor, localTags?: LocalTagNames): OperandRef {
  return peekOperandRefChainAt(cur, 0, localTags).ref;
}

/** Builds a `"ExternalName"(.member)*` chain's `OperandRef` by PEEKING
 * ONLY -- same peek-only contract as `peekOperandRefChain`, only ever
 * called when `looksLikeExternalRefStart` is true (so a following `.` is
 * already confirmed). `segments[0]` is the quoted name's DECODED value,
 * marked `external: true` so `analysis/symbolTable.ts`'s
 * `resolveOperandRef` resolves it against the workspace BlockIndex instead
 * of this block's own local VAR declarations. */
function peekExternalRefChainAt(cur: TokenCursor, startOffset: number): { ref: OperandRef; length: number } {
  const nameTok = cur.peek(startOffset);
  const segments = [nameTok.value ?? ""];
  let offset = startOffset + 1;
  for (;;) {
    const dot = cur.peek(offset);
    const member = cur.peek(offset + 1);
    if (dot.kind !== "punct" || dot.text !== ".") break;
    const memberName = memberSegmentName(member);
    if (memberName === null) break;
    segments.push(memberName);
    offset += 2;
  }
  return { ref: { segments, line: nameTok.line, col: nameTok.col, external: true }, length: offset - startOffset };
}

function peekExternalRefChain(cur: TokenCursor): OperandRef {
  return peekExternalRefChainAt(cur, 0).ref;
}

interface ArgValueResult {
  text: string;
  /** True when this argument's ENTIRE value is exactly one nested call
   * (`nestedCallsOut` got exactly one push here and nothing else -- no
   * operator, no second term -- contributed a token). See `PinArg.
   * isSoleNestedCall`. */
  isSoleCall: boolean;
}

function collectArgValue(
  cur: TokenCursor,
  operandRefsOut: OperandRef[],
  nestedCallsOut: CallNode[],
  allowBareInstanceCall: boolean,
  localTags?: LocalTagNames
): ArgValueResult {
  let depth = 0;
  const parts: string[] = [];
  let prevToken: Token | null = null;
  let extraTokens = 0; // tokens contributed OUTSIDE of any nested call -- see isSoleCall below
  while (!cur.atEnd()) {
    const t = cur.peek();
    if (t.kind === "punct" && t.text === ")") {
      if (depth === 0) break;
      depth--;
      prevToken = cur.next();
      parts.push(prevToken.text);
      extraTokens++;
      continue;
    }
    if (t.kind === "punct" && t.text === "," && depth === 0) break;

    // A nested instruction/instance call (e.g. `ABS(#x)` as another call's
    // own pin value) -- tried BEFORE the generic `(`/operand-ref/token
    // paths below so it's recognized as a real call instead of flattened
    // into opaque text. `tryParseCall` only ever matches a genuine call
    // shape (`Ident(`, `#Instance.Name(`, or -- when `allowBareInstanceCall`
    // -- bare `#Instance(`), so this can't misfire on a plain operand or
    // literal; it fully consumes its own matching parens internally, so
    // the `depth` counter here is untouched by it either way.
    const nested = tryParseCall(cur, allowBareInstanceCall, localTags);
    if (nested) {
      nestedCallsOut.push(nested);
      parts.push(`<${nested.name || "#" + nested.instancePrefix}(...)>`);
      prevToken = null;
      continue;
    }

    if (t.kind === "punct" && t.text === "(") {
      depth++;
      prevToken = cur.next();
      parts.push(prevToken.text);
      extraTokens++;
      continue;
    }
    if (looksLikeOperandRefStart(cur, localTags) && !isLiteralOrWireTail(prevToken, t)) {
      operandRefsOut.push(peekOperandRefChain(cur, localTags));
    } else if (looksLikeExternalRefStart(cur) && !isQuotedLocalTagName(prevToken, t) && !isQuotedChainMember(prevToken, t)) {
      operandRefsOut.push(peekExternalRefChain(cur));
    }
    prevToken = cur.next();
    parts.push(prevToken.text);
    extraTokens++;
  }
  return { text: parts.join(" ").trim(), isSoleCall: nestedCallsOut.length === 1 && extraTokens === 0 };
}

function parseCallArgs(cur: TokenCursor, allowBareInstanceCall: boolean, localTags?: LocalTagNames): PinArg[] {
  cur.tryPunct("(");
  const pins: PinArg[] = [];
  while (!cur.isPunct(")") && !cur.atEnd()) {
    const startTok = cur.peek();
    // Siemens quotes a formal parameter whose name isn't a legal bare
    // identifier -- one starting with a digit, or colliding with a reserved
    // word. That is the same name, just a different spelling, so the pin is
    // recorded under its UNQUOTED form (matching how `parseVarMember` stores
    // the declaration it has to match against). Recognising only the `ident`
    // spelling parsed the whole `name := value` as one positional argument.
    const isQuotedName = startTok.kind === "string" && startTok.text.startsWith('"');
    const isNamed =
      (startTok.kind === "ident" || isQuotedName) && (cur.peek(1).text === ":=" || cur.peek(1).text === "=>") && cur.peek(1).kind === "op";
    const operandRefs: OperandRef[] = [];
    const nestedCalls: CallNode[] = [];
    if (isNamed) {
      const nameTok = cur.next();
      const opTok = cur.next();
      const { text: valueText, isSoleCall } = collectArgValue(cur, operandRefs, nestedCalls, allowBareInstanceCall, localTags);
      pins.push({
        name: isQuotedName ? nameTok.value ?? "" : nameTok.text,
        dir: opTok.text === ":=" ? "in" : "out",
        valueText,
        operandRefs,
        nestedCalls,
        isSoleNestedCall: isSoleCall,
        line: nameTok.line,
        col: nameTok.col,
      });
    } else {
      const { text: valueText, isSoleCall } = collectArgValue(cur, operandRefs, nestedCalls, allowBareInstanceCall, localTags);
      pins.push({ name: null, dir: null, valueText, operandRefs, nestedCalls, isSoleNestedCall: isSoleCall, line: startTok.line, col: startTok.col });
    }
    if (cur.isPunct(",")) {
      cur.next();
      continue;
    }
  }
  cur.tryPunct(")");
  return pins;
}

/**
 * The block's own declared tag names, lower-cased -> their DECLARED
 * spelling. Threaded into `parseSclBody` so the SCL-body grammar can accept
 * TIA Portal's "bare local reference" spelling.
 *
 * TIA's external-source importer resolves an unprefixed, unquoted word in a
 * statement body against the block's own VAR sections and writes the `#`
 * back itself -- `IF Active THEN` / `SecondTick(IN := ..., PT := ...)` are
 * both accepted and compile to exactly what `#Active`/`#SecondTick(...)`
 * compile to (confirmed against a real, importing project source). Only a
 * word that ISN'T declared here is genuinely invalid operand syntax, which
 * is why this map -- rather than a blanket "accept any bare word" -- is what
 * gates the relaxation.
 */
export type LocalTagNames = Map<string, string>;

export function collectLocalTagNames(varSections: VarSection[]): LocalTagNames {
  const names: LocalTagNames = new Map();
  for (const section of varSections) {
    for (const member of section.members) names.set(member.name.toLowerCase(), member.name);
  }
  return names;
}

/** The declared spelling of `text` if it names one of this block's own
 * tags, else undefined. Reserved words never resolve (a tag can't be named
 * `IF`), so a keyword is never mistaken for a bare tag reference. */
function localTagName(text: string, localTags: LocalTagNames | undefined): string | undefined {
  if (!localTags || text.startsWith("#")) return undefined;
  if (SCL_RESERVED_KEYWORDS.has(text.toUpperCase())) return undefined;
  return localTags.get(text.toLowerCase());
}

function tryParseCall(cur: TokenCursor, allowBareInstanceCall = false, localTags?: LocalTagNames): CallNode | null {
  const t0 = cur.peek();
  if (t0.kind === "string" && t0.text.startsWith('"') && cur.peek(1).kind === "punct" && cur.peek(1).text === "(") {
    // Siemens' own external-symbol convention: a bare double-quoted call
    // target calls a workspace FUNCTION directly by its quoted name, or an
    // FB's own external instance DB, unambiguous here since a WSTRING
    // literal is never immediately followed by `(` either (see
    // `looksLikeExternalRefStart`'s own comment on the same
    // double-quote-vs-WSTRING disambiguation). Resolution goes straight to
    // BlockIndex by this name, not the instruction registry -- see
    // linter/sclInstructionChecks.ts's `resolveCallEntry`.
    const nameTok = cur.next(); // "Name"
    const pins = parseCallArgs(cur, allowBareInstanceCall, localTags);
    return { name: "", instancePrefix: null, externalName: nameTok.value ?? "", pins, line: nameTok.line, col: nameTok.col };
  }
  if (t0.kind === "ident" && t0.text.startsWith("#")) {
    // `#Instance.Name(...)` instance-dot call. A bare `#tag` NOT followed
    // by `.Ident(` is a plain operand reference, not a call -- leave it
    // for the caller to skip.
    const t1 = cur.peek(1);
    const t2 = cur.peek(2);
    const t3 = cur.peek(3);
    if (t1.kind === "punct" && t1.text === "." && t2.kind === "ident" && t3.kind === "punct" && t3.text === "(") {
      const instTok = cur.next(); // #Instance
      cur.next(); // .
      const nameTok = cur.next(); // Name
      const pins = parseCallArgs(cur, allowBareInstanceCall, localTags);
      return { name: nameTok.text, instancePrefix: instTok.text.slice(1), pins, line: instTok.line, col: instTok.col };
    }
    // SCL's `#Instance(...)` call shape -- unlike FBD/LAD, SCL calls a
    // declared FB instance directly with no `.BaseName` suffix; the
    // instance's OWN VAR declaration supplies which instruction it calls.
    // This parser has no visibility into the block's VAR sections here, so
    // `name` is left empty (a sentinel) for the caller to resolve -- see
    // linter/sclInstructionChecks.ts. Only enabled for an SCL statement
    // body (parseSclBody) -- parseRung leaves this false so LAD/FBD RUNG
    // parsing is unaffected.
    if (allowBareInstanceCall && t1.kind === "punct" && t1.text === "(") {
      const instTok = cur.next(); // #Instance
      const pins = parseCallArgs(cur, allowBareInstanceCall, localTags);
      return { name: "", instancePrefix: instTok.text.slice(1), pins, line: instTok.line, col: instTok.col };
    }
    return null;
  }
  if (
    t0.kind === "ident" &&
    cur.peek(1).kind === "punct" &&
    cur.peek(1).text === "(" &&
    !(allowBareInstanceCall && SCL_RESERVED_KEYWORDS.has(t0.text.toUpperCase()))
  ) {
    // A bare `Name(...)` whose name is one of THIS block's own declared
    // tags is the `#`-less spelling of SCL's `#Instance(...)` call shape
    // (see `LocalTagNames`) -- reported identically, so the instance's own
    // declared type still supplies which instruction/FB is being called.
    // Local declarations shadow the instruction catalog here, matching TIA's
    // own scope resolution.
    const declaredTag = allowBareInstanceCall ? localTagName(t0.text, localTags) : undefined;
    const nameTok = cur.next();
    const pins = parseCallArgs(cur, allowBareInstanceCall, localTags);
    if (declaredTag) return { name: "", instancePrefix: declaredTag, pins, line: nameTok.line, col: nameTok.col };
    return { name: nameTok.text, instancePrefix: null, pins, line: nameTok.line, col: nameTok.col };
  }
  return null;
}

/** Consumes a `wire#X` pair (the "wire" identifier immediately -- no gap
 * -- adjacent to a `#X` identifier, matching analysis/documentIndex.ts's
 * own `consumeBaseTagOrWire` adjacency check) and returns its logical
 * name, or `null` (consuming nothing) if the cursor isn't positioned at
 * one. Shared by a RUNG's own header, an inline body branch-tap, and a
 * trailing `END_RUNG` label -- all three are the exact same token shape. */
function tryConsumeWireLabel(cur: TokenCursor): WireLabel | null {
  const t0 = cur.peek();
  const t1 = cur.peek(1);
  if (t0.kind !== "ident" || t0.text.toLowerCase() !== "wire") return null;
  if (t1.kind !== "ident" || !t1.text.startsWith("#")) return null;
  if (t1.line !== t0.line || t1.offset !== t0.offset + t0.text.length) return null;
  cur.next(); // "wire"
  const labelTok = cur.next(); // "#X"
  return { name: labelTok.text.slice(1), line: t0.line, col: t0.col };
}

function parseRung(cur: TokenCursor): RungNode {
  cur.tryIdent("RUNG");
  const wireHeader = tryConsumeWireLabel(cur) ?? undefined;
  const calls: CallNode[] = [];
  const bodyWireLabels: WireLabel[] = [];
  let pendingPragma: Pragma | undefined;
  while (!cur.isIdent("END_RUNG") && !cur.atEnd()) {
    if (cur.isPunct("{")) {
      pendingPragma = parsePragmaBlock(cur) ?? undefined;
      continue;
    }
    const call = tryParseCall(cur);
    if (call) {
      call.pragma = pendingPragma;
      pendingPragma = undefined;
      calls.push(call);
      continue;
    }
    const bodyLabel = tryConsumeWireLabel(cur);
    if (bodyLabel) {
      bodyWireLabels.push(bodyLabel);
      continue;
    }
    cur.next(); // skip anything this parser doesn't model
  }
  cur.tryIdent("END_RUNG");
  const endWireLabel = tryConsumeWireLabel(cur) ?? undefined;
  return { calls, wireHeader, bodyWireLabels, endWireLabel };
}

/** Parses an SCL `BEGIN ... <endKeyword>` statement body, flatly collecting
 * every instruction/instance call found anywhere inside it -- IF/CASE/FOR/
 * WHILE/REPEAT/REGION nesting isn't modeled as a tree (same tolerance
 * `parseRung` already applies to a RUNG's body), since only the calls
 * themselves matter for instruction-registry validation. Stops the moment
 * `endKeyword` (the enclosing block's own END_xxx, e.g. END_FUNCTION_BLOCK)
 * is reached, so a nested statement's own END_IF/END_CASE/END_FOR/END_WHILE
 * keyword never gets mistaken for the block's end. */
/** Words that are legal as an entire, standalone condition without being
 * a tag reference at all -- boolean literals. Excluded from the
 * "bare-identifier" (invalid operand syntax) case below, alongside
 * `SCL_RESERVED_KEYWORDS` (a reserved word can't be a tag name either,
 * but isn't an error to see here -- it just means this isn't a
 * recognizable simple condition at all, e.g. `IF NOT THEN` never
 * legitimately parses this far anyway). */
const BOOLEAN_LITERALS = new Set(["TRUE", "FALSE"]);

type SimpleConditionMatch =
  | { kind: "tag"; negated: boolean; ref: OperandRef }
  | { kind: "bare-identifier"; negated: boolean; name: string; line: number; col: number };

/** Peeks (never consumes) starting `startOffset` tokens ahead of the
 * cursor's current position for an SCL `IF`/`WHILE`/`UNTIL` condition
 * that is ENTIRELY a single, optionally-`NOT`-prefixed operand with
 * nothing else (no comparison, no `AND`/`OR`, no function call) --
 * either a real `#tag(.member)*`/`#"Quoted"` reference (`kind: "tag"`),
 * or a bare word that ISN'T a valid operand at all (`kind:
 * "bare-identifier"` -- real TIA SCL syntax requires `#` for a local
 * reference or quotes for a global one, e.g. `"PMP_RUN_FB"`; a bare
 * word is neither). A QUOTED global-tag condition (`IF "SomeTag" THEN`)
 * is deliberately left unrecorded -- this project has no global PLC tag
 * table to resolve it against, so there's nothing to check either way.
 * A bare word that DOES name one of this block's own declared tags
 * (`localTags`) is the `#`-less spelling TIA's importer accepts -- see
 * `LocalTagNames` -- so it reports as `kind: "tag"`, `.member` chain and
 * all, exactly as if the `#` had been typed. Returns `null` for anything
 * more complex, a boolean literal (`TRUE`/`FALSE`), a reserved keyword, or
 * a bare word immediately followed by `(` (a function call -- too complex
 * to verify here). */
function peekSimpleCondition(
  cur: TokenCursor,
  startOffset: number,
  isTerminator: (t: Token) => boolean,
  localTags?: LocalTagNames
): SimpleConditionMatch | null {
  let offset = startOffset;
  let negated = false;
  if (cur.peek(offset).kind === "ident" && cur.peek(offset).text.toUpperCase() === "NOT") {
    negated = true;
    offset += 1;
  }
  const base = cur.peek(offset);

  /** Consumes `.member` segments from `offset` onward, appending to
   * `segments` -- identical for the `#tag` and bare-tag spellings. */
  const takeMemberChain = (segments: string[]): string[] => {
    for (;;) {
      const dot = cur.peek(offset);
      const member = cur.peek(offset + 1);
      if (dot.kind === "punct" && dot.text === "." && member.kind === "ident") {
        segments.push(member.text);
        offset += 2;
        continue;
      }
      break;
    }
    return segments;
  };

  if (base.kind === "ident" && base.text.startsWith("#")) {
    let segments: string[];
    if (base.text === "#") {
      if (cur.peek(offset + 1).kind !== "string") return null;
      segments = [cur.peek(offset + 1).value ?? ""];
      offset += 2;
    } else {
      segments = [base.text.slice(1)];
      offset += 1;
    }
    takeMemberChain(segments);
    if (!isTerminator(cur.peek(offset))) return null;
    return { kind: "tag", negated, ref: { segments, line: base.line, col: base.col } };
  }

  if (base.kind === "ident") {
    const upper = base.text.toUpperCase();
    if (BOOLEAN_LITERALS.has(upper) || SCL_RESERVED_KEYWORDS.has(upper)) return null;
    const next = cur.peek(offset + 1);
    if (next.kind === "punct" && next.text === "(") return null; // a function call -- too complex to verify
    const declaredTag = localTagName(base.text, localTags);
    if (declaredTag) {
      offset += 1; // past the base tag itself, so takeMemberChain starts at the first `.`
      const segments = takeMemberChain([declaredTag]);
      if (!isTerminator(cur.peek(offset))) return null;
      return { kind: "tag", negated, ref: { segments, line: base.line, col: base.col, bare: true } };
    }
    if (!isTerminator(next)) return null;
    return { kind: "bare-identifier", negated, name: base.text, line: base.line, col: base.col };
  }

  return null;
}

// --- SCL assignment-expression parsing (linter/exprTypeChecks.ts) --------
//
// Everything above this point deliberately has NO general expression
// grammar -- `collectArgValue`/`peekSimpleCondition` only ever recognize a
// SINGLE bare operand/literal/nested-call, never a real operator tree (see
// PinArg's own comment: "real operator type-inference this parser doesn't
// do"). The functions below are the first one: a small precedence-climbing
// parser over `+ - * / MOD`, `AND OR XOR`, the six comparison operators,
// and unary `NOT`/`-`, built PEEK-ONLY (never calling `cur.next()`) so it
// can run inside `parseSclBody`'s own per-token loop without disturbing it
// -- same "peek-only helper alongside the main consuming loop" convention
// `peekOperandRefChain`/`peekSimpleCondition` already established, just
// generalized to a real operator tree instead of one fixed shape.
//
// Scope: ONLY a plain SCL assignment's RHS (`#lhs := <expr>;`) is parsed
// this way (see `parseSclBody`'s own hook for where). A "call" leaf here
// is limited to the bare `Ident(args...)` shape (the shape every explicit
// conversion function like INT_TO_REAL always has) -- an instance-dot
// call's `result.kind` is always `none` per system-registry/result.yaml
// anyway, so it could never legally appear as an operand in an arithmetic
// expression, and isn't worth the parser complexity of also recognizing
// `#Instance.Name(...)`/`#Instance(...)` shapes here.
// `endLine`/`endCol` mark the position immediately AFTER this node's own
// last token (1-based, same convention as `line`/`col`) -- e.g. for
// `binary`, the end of `right`, NOT of the operator `line`/`col` marks the
// start of. Lets a caller (see linter/exprTypeChecks.ts's
// `expr-implicit-numeric-conversion` Quick Fix) build an exact
// `vscode.Range` for a sub-expression without re-deriving it from raw
// text -- every node already computes this from `nextOffset`/the last
// token it actually consumed, so it's always precise even across a
// multi-line expression.
export type SclExprNode =
  | { kind: "operand"; ref: OperandRef; line: number; col: number; endLine: number; endCol: number }
  | { kind: "literal"; raw: string; line: number; col: number; endLine: number; endCol: number }
  | { kind: "call"; name: string; args: SclExprNode[]; line: number; col: number; endLine: number; endCol: number }
  | { kind: "unary"; op: string; operand: SclExprNode; line: number; col: number; endLine: number; endCol: number }
  | { kind: "binary"; op: string; left: SclExprNode; right: SclExprNode; line: number; col: number; endLine: number; endCol: number };

/** One `#lhs := <expr>;` SCL assignment statement, RHS parsed into a real
 * expression tree -- see `linter/exprTypeChecks.ts`. Only recorded when
 * `peekExprAt` confidently consumes the ENTIRE RHS up to the terminating
 * `;` (see `parseSclBody`'s own hook) -- a partial/unparseable RHS (a
 * shape this small grammar doesn't cover) is simply never recorded, rather
 * than guessed at from a truncated tree. */
export interface SclAssignmentExpr {
  target: OperandRef;
  expr: SclExprNode;
  line: number;
  col: number;
}

/** Every token length (peek-offset-relative) this run of adjacent tokens
 * forming ONE literal spans, starting at `offset` -- 0 if `offset` isn't
 * the start of a recognizable literal at all. The P#-pointer dotted-address
 * tail `literalRunLength` can also consume is deliberately left OFF here --
 * a pointer literal is never a legal arithmetic/logical/comparison operand,
 * so this feature has no use for recognizing one. */
function peekLiteralRunLength(cur: TokenCursor, offset: number): number {
  return literalRunLength(cur, offset, { keywordLiterals: true });
}

/** SCL binary operator precedence (higher binds tighter), IEC 61131-3
 * order: OR < XOR < AND < equality < relational < additive <
 * multiplicative. Keyed by the SAME normalized operator text
 * `peekBinaryOperatorAt` returns (keyword operators upper-cased). */
const BINARY_PRECEDENCE: Record<string, number> = {
  OR: 1,
  XOR: 2,
  AND: 3,
  "=": 4,
  "<>": 4,
  "<": 5,
  ">": 5,
  "<=": 5,
  ">=": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  MOD: 7,
};

/** The binary operator token at `offset`, normalized (keyword operators
 * upper-cased) -- `null` if `offset` isn't one. Never matches `:=`
 * (assignment, not a value-producing operator) or `=>`/`^` (pin-wiring/
 * dereference syntax, not expression operators either). */
function peekBinaryOperatorAt(cur: TokenCursor, offset: number): string | null {
  const t = cur.peek(offset);
  if (t.kind === "punct" && (t.text === "+" || t.text === "-" || t.text === "*" || t.text === "/" || t.text === "=" || t.text === "<" || t.text === ">")) {
    return t.text;
  }
  if (t.kind === "op" && (t.text === "<>" || t.text === "<=" || t.text === ">=")) return t.text;
  if (t.kind === "ident") {
    const upper = t.text.toUpperCase();
    if (upper === "AND" || upper === "OR" || upper === "XOR" || upper === "MOD") return upper;
  }
  return null;
}

interface PeekExprResult {
  node: SclExprNode;
  nextOffset: number;
}

/** A single primary term: a parenthesized sub-expression, a literal run, a
 * bare `Ident(args...)` call (see this section's own header for why only
 * this one call shape is recognized here), or an operand reference
 * (local `#tag(.member)*` or external `"Name".member*`). `null` for
 * anything else -- the caller (`peekUnaryAt`/`peekExprAt`) aborts the
 * WHOLE expression parse rather than guess at a shape this small grammar
 * doesn't cover (see `SclAssignmentExpr`'s own comment). */
/** The position immediately AFTER the token at peek-offset `lastOffset`
 * (1-based `col`, same convention `Token.col` itself uses) -- `lastOffset`
 * is the ABSOLUTE offset of the LAST token a node actually consumed (i.e.
 * `nextOffset - 1`), used to fill in every `SclExprNode`'s own `endLine`/
 * `endCol`. See `SclExprNode`'s own header comment. */
function endPosAt(cur: TokenCursor, lastOffset: number): { endLine: number; endCol: number } {
  const t = cur.peek(lastOffset);
  return { endLine: t.line, endCol: t.col + t.text.length };
}

function peekPrimaryAt(cur: TokenCursor, offset: number, localTags?: LocalTagNames): PeekExprResult | null {
  const t0 = cur.peek(offset);

  if (t0.kind === "punct" && t0.text === "(") {
    const inner = peekExprAt(cur, offset + 1, 0, localTags);
    if (!inner) return null;
    const close = cur.peek(inner.nextOffset);
    if (!(close.kind === "punct" && close.text === ")")) return null;
    return { node: inner.node, nextOffset: inner.nextOffset + 1 };
  }

  const litLen = peekLiteralRunLength(cur, offset);
  if (litLen > 0) {
    let raw = "";
    for (let i = 0; i < litLen; i++) raw += cur.peek(offset + i).text;
    return {
      node: { kind: "literal", raw, line: t0.line, col: t0.col, ...endPosAt(cur, offset + litLen - 1) },
      nextOffset: offset + litLen,
    };
  }

  if (
    t0.kind === "ident" &&
    !t0.text.startsWith("#") &&
    !SCL_RESERVED_KEYWORDS.has(t0.text.toUpperCase()) &&
    cur.peek(offset + 1).kind === "punct" &&
    cur.peek(offset + 1).text === "("
  ) {
    let o = offset + 2;
    const args: SclExprNode[] = [];
    if (!(cur.peek(o).kind === "punct" && cur.peek(o).text === ")")) {
      for (;;) {
        const arg = peekExprAt(cur, o, 0, localTags);
        if (!arg) return null;
        args.push(arg.node);
        o = arg.nextOffset;
        if (cur.peek(o).kind === "punct" && cur.peek(o).text === ",") {
          o++;
          continue;
        }
        break;
      }
    }
    if (!(cur.peek(o).kind === "punct" && cur.peek(o).text === ")")) return null;
    o++;
    return { node: { kind: "call", name: t0.text, args, line: t0.line, col: t0.col, ...endPosAt(cur, o - 1) }, nextOffset: o };
  }

  if (looksLikeOperandRefStartAt(cur, offset, localTags)) {
    const { ref, length } = peekOperandRefChainAt(cur, offset, localTags);
    return {
      node: { kind: "operand", ref, line: t0.line, col: t0.col, ...endPosAt(cur, offset + length - 1) },
      nextOffset: offset + length,
    };
  }
  if (looksLikeExternalRefStartAt(cur, offset)) {
    const { ref, length } = peekExternalRefChainAt(cur, offset);
    return {
      node: { kind: "operand", ref, line: t0.line, col: t0.col, ...endPosAt(cur, offset + length - 1) },
      nextOffset: offset + length,
    };
  }

  return null;
}

/** Unary `NOT`/`-`, right-recursive (`NOT NOT #a`, `- - #a` both legal,
 * however unlikely in practice) -- falls through to `peekPrimaryAt` when
 * neither prefix is present. */
function peekUnaryAt(cur: TokenCursor, offset: number, localTags?: LocalTagNames): PeekExprResult | null {
  const t0 = cur.peek(offset);
  if (t0.kind === "ident" && t0.text.toUpperCase() === "NOT") {
    const inner = peekUnaryAt(cur, offset + 1, localTags);
    if (!inner) return null;
    return {
      node: { kind: "unary", op: "NOT", operand: inner.node, line: t0.line, col: t0.col, endLine: inner.node.endLine, endCol: inner.node.endCol },
      nextOffset: inner.nextOffset,
    };
  }
  if (t0.kind === "punct" && t0.text === "-") {
    const inner = peekUnaryAt(cur, offset + 1, localTags);
    if (!inner) return null;
    return {
      node: { kind: "unary", op: "-", operand: inner.node, line: t0.line, col: t0.col, endLine: inner.node.endLine, endCol: inner.node.endCol },
      nextOffset: inner.nextOffset,
    };
  }
  return peekPrimaryAt(cur, offset, localTags);
}

/** Precedence-climbing binary expression parser, starting `offset` tokens
 * ahead of the cursor's current position -- see this section's own header.
 * `minPrec` is the standard precedence-climbing threshold (always call
 * with `0` from the top; the recursive call for a right operand raises it
 * to bind tighter, keeping left-associativity for equal-precedence
 * operators). `null` propagates from `peekUnaryAt`/a missing right operand
 * -- an unparseable expression aborts the WHOLE parse rather than return a
 * partial tree. */
function peekExprAt(cur: TokenCursor, offset: number, minPrec: number, localTags?: LocalTagNames): PeekExprResult | null {
  let left = peekUnaryAt(cur, offset, localTags);
  if (!left) return null;
  for (;;) {
    const opText = peekBinaryOperatorAt(cur, left.nextOffset);
    if (!opText) break;
    const prec = BINARY_PRECEDENCE[opText];
    if (prec < minPrec) break;
    const opTok = cur.peek(left.nextOffset);
    const right = peekExprAt(cur, left.nextOffset + 1, prec + 1, localTags);
    if (!right) return null;
    left = {
      node: {
        kind: "binary",
        op: opText,
        left: left.node,
        right: right.node,
        line: opTok.line,
        col: opTok.col,
        endLine: right.node.endLine,
        endCol: right.node.endCol,
      },
      nextOffset: right.nextOffset,
    };
  }
  return left;
}

const isThenKeyword = (t: Token) => t.kind === "ident" && t.text.toUpperCase() === "THEN";
const isDoKeyword = (t: Token) => t.kind === "ident" && t.text.toUpperCase() === "DO";
const isSemicolon = (t: Token) => t.kind === "punct" && t.text === ";";

function parseSclBody(
  cur: TokenCursor,
  endKeyword: string,
  localTags?: LocalTagNames
): {
  calls: CallNode[];
  operandRefs: OperandRef[];
  conditionChecks: SclConditionCheck[];
  assignments: SclAssignmentExpr[];
  missingSemicolons: { line: number; col: number }[];
} {
  cur.tryIdent("BEGIN");
  const calls: CallNode[] = [];
  const operandRefs: OperandRef[] = [];
  const conditionChecks: SclConditionCheck[] = [];
  const assignments: SclAssignmentExpr[] = [];
  const missingSemicolons: { line: number; col: number }[] = [];
  let prevToken: Token | null = null;
  // Tracks the most recent `#tag(.member)*` chain seen at bracket depth 0
  // (i.e. NOT inside a `[...]`/`(...)`), and whether THAT chain is itself
  // being indexed (`#arr[#i]`) -- both needed to correctly identify a plain
  // assignment's LHS below. Depth-tracked because `#WaterFlow[#i] := ...`
  // pushes TWO refs to `operandRefs` (`WaterFlow`, then the index `i`) and
  // the index one is naturally the LAST one seen before `:=` -- without
  // this, the LHS would be misidentified as the loop counter `#i` instead
  // of `#WaterFlow` (confirmed against a real false positive this caused
  // in distributed-process-control.scl's `#WaterFlow[#i] := LIMIT(...)`, flagging a mismatch
  // against `#i`'s declared type instead of the array's element type).
  let lastTopLevelRef: OperandRef | null = null;
  let lastTopLevelRefIndexed = false;
  let bracketDepth = 0;
  while (!cur.isIdent(endKeyword) && !cur.atEnd()) {
    // Captured BEFORE tryParseCall attempts anything -- `prevToken` still
    // holds whatever this same loop consumed last iteration, i.e. the
    // token immediately preceding the call in the source (a pin's own
    // `:=`/`=>` is consumed inside parseCallArgs, never reaching this outer
    // loop, so a `:=` seen here can only be a plain SCL assignment operator).
    const precededByAssign = prevToken !== null && prevToken.kind === "op" && prevToken.text === ":=";
    const call = tryParseCall(cur, true, localTags);
    if (call) {
      if (precededByAssign) {
        call.isAssignmentRhs = true;
        // Only when the LHS is a plain, un-indexed chain -- `#arr[#i] :=
        // Call(...)` leaves `lastTopLevelRefIndexed` true, and `#arr`'s OWN
        // type is the whole array's type, not the element `[#i]` actually
        // receives, so a consumer resolving `assignmentTarget`'s type would
        // check the wrong thing entirely -- better to not report a target
        // at all than to guess against the array's own type.
        if (lastTopLevelRef && !lastTopLevelRefIndexed) call.assignmentTarget = lastTopLevelRef;
      }
      calls.push(call);
      prevToken = null; // last token consumed by the call isn't tracked; conservative reset (see isLiteralOrWireTail -- a false negative here is harmless)
      continue;
    }

    // Pure lookahead, same as the IF/WHILE/UNTIL conditions just below --
    // only recorded when `peekExprAt` confidently consumes the ENTIRE RHS
    // up to the terminating `;` (never a prefix of it), and only for a
    // plain, un-indexed LHS chain (same restriction `assignmentTarget`
    // above already applies, for the same reason: `#arr[#i] := ...`'s own
    // `#arr` type isn't what the indexed element actually receives).
    if (precededByAssign && lastTopLevelRef && !lastTopLevelRefIndexed) {
      const parsed = peekExprAt(cur, 0, 0, localTags);
      if (parsed) {
        const after = cur.peek(parsed.nextOffset);
        if (after.kind === "punct" && after.text === ";") {
          assignments.push({ target: lastTopLevelRef, expr: parsed.node, line: lastTopLevelRef.line, col: lastTopLevelRef.col });
        } else if (after.kind !== "eof") {
          // The RHS parsed as a clean, complete expression (peekExprAt
          // doesn't return a partial tree -- see its own comment), but
          // the very next token isn't the required terminating `;` --
          // every real SCL statement needs its own semicolon regardless
          // of what legally follows it (even a block-closing keyword like
          // END_IF doesn't substitute for one), so this is a precise,
          // low-false-positive signal: a genuinely unparseable RHS shape
          // (this grammar's own gaps) makes `parsed` null instead, never
          // reaching here, so this never fires on "don't understand the
          // syntax," only on "understood it, wrong terminator."
          missingSemicolons.push({ line: after.line, col: after.col });
        }
      }
    }

    // Pure lookahead -- doesn't consume anything, so the generic walk
    // below still processes "IF"/"WHILE"/"UNTIL" and every token of the
    // condition itself exactly as it always has (including adding the
    // condition's own tag to `operandRefs` once the loop reaches it).
    if (cur.isIdent("IF")) {
      const match = peekSimpleCondition(cur, 1, isThenKeyword, localTags);
      if (match) conditionChecks.push({ keyword: "IF", ...match, line: cur.peek().line, col: cur.peek().col });
    } else if (cur.isIdent("WHILE")) {
      const match = peekSimpleCondition(cur, 1, isDoKeyword, localTags);
      if (match) conditionChecks.push({ keyword: "WHILE", ...match, line: cur.peek().line, col: cur.peek().col });
    } else if (cur.isIdent("UNTIL")) {
      const match = peekSimpleCondition(cur, 1, isSemicolon, localTags);
      if (match) conditionChecks.push({ keyword: "UNTIL", ...match, line: cur.peek().line, col: cur.peek().col });
    }

    // A bare `#tag(.member)*` reference OUTSIDE of any call -- a plain
    // assignment's RHS/LHS, an IF/WHILE/UNTIL condition, etc. (a call's
    // own pin-value refs are already captured on that pin's own
    // `operandRefs`, see `parseCallArgs` -- this only sees what's left
    // once a call attempt above has failed.)
    const t0 = cur.peek();
    if (looksLikeOperandRefStart(cur, localTags) && !isLiteralOrWireTail(prevToken, t0)) {
      const ref = peekOperandRefChain(cur, localTags);
      operandRefs.push(ref);
      if (bracketDepth === 0) {
        lastTopLevelRef = ref;
        lastTopLevelRefIndexed = false;
      }
    } else if (looksLikeExternalRefStart(cur) && !isQuotedLocalTagName(prevToken, t0) && !isQuotedChainMember(prevToken, t0)) {
      const ref = peekExternalRefChain(cur);
      operandRefs.push(ref);
      if (bracketDepth === 0) {
        lastTopLevelRef = ref;
        lastTopLevelRefIndexed = false;
      }
    } else if (t0.kind === "punct" && t0.text === "[" && bracketDepth === 0) {
      lastTopLevelRefIndexed = true; // the pending top-level ref is being indexed, e.g. #arr[#i]
    }
    if (t0.kind === "punct" && (t0.text === "[" || t0.text === "(")) bracketDepth++;
    else if (t0.kind === "punct" && (t0.text === "]" || t0.text === ")")) bracketDepth = Math.max(0, bracketDepth - 1);

    prevToken = cur.next(); // skip anything this parser doesn't model (statements, operators, operands, comments already stripped by the lexer)
  }
  return { calls, operandRefs, conditionChecks, assignments, missingSemicolons };
}

function parseNetwork(cur: TokenCursor, pragma: Pragma | undefined): NetworkNode {
  cur.tryIdent("NETWORK");
  const rungs: RungNode[] = [];
  while (!cur.isIdent("END_NETWORK") && !cur.atEnd()) {
    if (cur.isIdent("RUNG")) {
      rungs.push(parseRung(cur));
      continue;
    }
    cur.next();
  }
  cur.tryIdent("END_NETWORK");
  return { pragma, rungs };
}

/** Parses one `FUNCTION_BLOCK/FUNCTION/ORGANIZATION_BLOCK/DATA_BLOCK "Name"
 * ... END_xxx` declaration starting at the cursor's current position (the
 * block keyword itself), or returns null without consuming anything if the
 * cursor isn't positioned at one. Shared by `parseS7dclBlock` (single-
 * declaration .s7dcl exports) and `parseS7dclFile` (multi-declaration .scl
 * source files). */
function pragmaBoolean(pragma: Pragma | null | undefined, key: string): boolean | undefined {
  if (!pragma) return undefined;
  const match = Object.entries(pragma).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase());
  if (!match) return undefined;
  const normalized = match[1].trim().toUpperCase();
  if (normalized === "TRUE") return true;
  if (normalized === "FALSE") return false;
  return undefined;
}

function parseBlockDeclaration(cur: TokenCursor, filePragma?: Pragma | null): ParsedBlockFile | null {
  let blockType: (typeof BLOCK_KEYWORDS)[number] | null = null;
  for (const kw of BLOCK_KEYWORDS) {
    if (cur.isIdent(kw)) {
      blockType = kw;
      cur.next();
      break;
    }
  }
  if (!blockType) return null;

  const nameTok = cur.next();
  const name = nameTok.kind === "string" ? (nameTok.value ?? nameTok.text) : nameTok.text;

  // Block-level attributes, e.g. S7_Language / S7_Optimized_Access, and (on an
  // instruction instance DB) InstructionName -- see ParsedBlockFile.
  const inlineHeaderPragma = cur.isPunct("{") ? parsePragmaBlock(cur) : null;
  const headerPragma: Pragma = { ...(filePragma ?? {}), ...(inlineHeaderPragma ?? {}) };
  const instructionName = headerPragma?.InstructionName;
  const optimizedAccess = pragmaBoolean(headerPragma, "S7_Optimized_Access");
  let instanceOf: { name: string; quoted: boolean } | undefined;
  // Only the HEADER region can carry the instance-of line; once a VAR section
  // or the body starts, anything left is data/statements.
  let headerDone = false;

  const varSections: VarSection[] = [];
  const networks: NetworkNode[] = [];
  const sclCalls: CallNode[] = [];
  const sclOperandRefs: OperandRef[] = [];
  const sclConditionChecks: SclConditionCheck[] = [];
  const sclAssignments: SclAssignmentExpr[] = [];
  const sclMissingSemicolons: { line: number; col: number }[] = [];
  const endKeyword = `END_${blockType}`;

  while (!cur.isIdent(endKeyword) && !cur.atEnd()) {
    // "VAR CONSTANT" is two separate tokens in real exports (unlike
    // VAR_INPUT/VAR_TEMP/etc, which are one underscore-joined identifier) --
    // without this check "CONSTANT" gets consumed as the first member's
    // name instead of being recognized as part of the section keyword.
    const isVarConstant = cur.isIdent("VAR") && cur.peek(1).kind === "ident" && cur.peek(1).text.toUpperCase() === "CONSTANT";
    const varKw = isVarConstant ? "VAR_CONSTANT" : VAR_KEYWORDS.find((kw) => cur.isIdent(kw));
    if (varKw) {
      cur.next();
      if (isVarConstant) cur.next(); // consume "CONSTANT" too
      const members: MemberRef[] = [];
      while (!cur.isIdent("END_VAR") && !cur.atEnd()) {
        members.push(parseVarMember(cur));
      }
      cur.tryIdent("END_VAR");
      varSections.push({ kind: varKw, members });
      headerDone = true;
      continue;
    }

    // A text-exported global DB can use an anonymous outer STRUCT instead of
    // a VAR...END_VAR section:
    //
    //   DATA_BLOCK "Store"
    //   NON_RETAIN
    //      STRUCT
    //         Units : Array[1..4] of "SlotRecord";
    //      END_STRUCT;
    //   BEGIN
    //   END_DATA_BLOCK
    //
    // This STRUCT is the DB's storage envelope, not an `instanceOf` type.
    // Parse its direct children as the DB's ordinary VAR members so the
    // BlockIndex can resolve `"Store".Units` just like a VAR-based global DB.
    if (blockType === "DATA_BLOCK" && !headerDone && cur.isIdent("STRUCT")) {
      const storage = parseTypeRefFromCursor(cur);
      if (storage.kind === "inline-struct") {
        varSections.push({ kind: "VAR", members: storage.members });
      }
      headerDone = true;
      continue;
    }

    if (cur.isPunct("{")) {
      const pragma = parsePragmaBlock(cur) ?? undefined;
      if (cur.isIdent("NETWORK")) {
        networks.push(parseNetwork(cur, pragma));
      }
      continue;
    }

    if (cur.isIdent("NETWORK")) {
      networks.push(parseNetwork(cur, undefined));
      continue;
    }

    if (cur.isIdent("BEGIN")) {
      headerDone = true;
      // Every VAR section precedes BEGIN in this grammar, so `varSections`
      // is already complete here -- which is what lets the body grammar
      // resolve TIA's bare, `#`-less local references (see `LocalTagNames`).
      const body = parseSclBody(cur, endKeyword, collectLocalTagNames(varSections));
      sclCalls.push(...body.calls);
      sclOperandRefs.push(...body.operandRefs);
      sclConditionChecks.push(...body.conditionChecks);
      sclAssignments.push(...body.assignments);
      sclMissingSemicolons.push(...body.missingSemicolons);
      continue;
    }

    // A DATA_BLOCK's instance-of line lives here, among the header tokens this
    // loop otherwise skips. Told apart from the other header entries by shape:
    // `VERSION : 0.1` / `TITLE = '...'` / `AUTHOR : x` are all followed by
    // `:`/`=`, and the standalone markers (NON_RETAIN, ...) are known
    // keywords -- what remains is the type name. See ParsedBlockFile.
    if (blockType === "DATA_BLOCK" && !headerDone && !instanceOf) {
      const t = cur.peek();
      if (t.kind === "string" && t.text.startsWith('"')) {
        instanceOf = { name: t.value ?? t.text, quoted: true };
      } else if (t.kind === "ident" && !DB_HEADER_KEYWORDS.has(t.text.toUpperCase())) {
        const nxt = cur.peek(1);
        const isLabelled = !!nxt && ((nxt.kind === "punct" && (nxt.text === ":" || nxt.text === "=")) || (nxt.kind === "op" && nxt.text === "="));
        if (!isLabelled) instanceOf = { name: t.text, quoted: false };
      }
    }

    cur.next(); // defensive skip: VERSION, NON_RETAIN, TITLE = '...', etc.
  }
  cur.tryIdent(endKeyword);

  return {
    blockType,
    name,
    varSections,
    networks,
    sclCalls,
    sclOperandRefs,
    sclConditionChecks,
    sclAssignments,
    sclMissingSemicolons,
    instanceOf,
    instructionName,
    optimizedAccess,
  };
}

/** Skips one `TYPE "Name" ... END_TYPE` declaration wholesale -- parsing its
 * STRUCT body is udtTextParser.ts's job (run separately over the same text
 * for the UDT type cache); `parseS7dclFile` only needs to step past it to
 * reach whatever program-block declarations follow in the same file. */
function skipTypeDeclaration(cur: TokenCursor): void {
  cur.tryIdent("TYPE");
  while (!cur.isIdent("END_TYPE") && !cur.atEnd()) {
    if (cur.isPunct("{")) {
      parsePragmaBlock(cur);
      continue;
    }
    cur.next();
  }
  cur.tryIdent("END_TYPE");
}

/** Returns null if `text` isn't a recognized block file (e.g. it's a TYPE
 * declaration file instead -- see udtTextParser.ts / detectS7dclKind). Only
 * ever parses the FIRST declaration found -- correct for a `.s7dcl` export,
 * which is always exactly one declaration per file. For a `.scl` source
 * file, which may bundle several declarations in one file, use
 * `parseS7dclFile` instead. */
export function parseS7dclBlock(text: string): ParsedBlockFile | null {
  const tokens: Token[] = new Lexer(text).tokenize();
  const cur = new TokenCursor(tokens);
  const filePragma = cur.isPunct("{") ? parsePragmaBlock(cur) : null; // file-level attributes
  return parseBlockDeclaration(cur, filePragma);
}

/** Parses every FUNCTION_BLOCK/FUNCTION/ORGANIZATION_BLOCK/DATA_BLOCK
 * declaration found in `text`, in order -- unlike a `.s7dcl` TIA export
 * (always one declaration per file), an authored `.scl` source file
 * routinely bundles several TYPE declarations and program blocks together
 * in one file (confirmed against real project `.scl` files). TYPE
 * declarations are skipped here (see `skipTypeDeclaration`); only
 * program-block declarations are returned. Safe to call on a `.s7dcl`
 * export too -- the loop just finds its one declaration and stops. */
export function parseS7dclFile(text: string): ParsedBlockFile[] {
  const tokens: Token[] = new Lexer(text).tokenize();
  const cur = new TokenCursor(tokens);
  const results: ParsedBlockFile[] = [];
  let pendingFilePragma: Pragma | null = null;

  while (!cur.atEnd()) {
    if (cur.isPunct("{")) {
      pendingFilePragma = parsePragmaBlock(cur);
      continue;
    }
    if (cur.isIdent("TYPE")) {
      skipTypeDeclaration(cur);
      continue;
    }
    const block = parseBlockDeclaration(cur, pendingFilePragma);
    if (block) {
      results.push(block);
      pendingFilePragma = null;
      continue;
    }
    if (cur.atEnd()) break;
    cur.next(); // defensive skip between declarations
  }

  return results;
}

/** Cheap sniff to decide which parser applies to a `.s7dcl` file's text,
 * without fully tokenizing it -- per udt-dependency-cache.md, a `.s7dcl`
 * file's top-level keyword may be `TYPE` instead of a program-block
 * keyword. Skips a leading `{...}` file-level pragma if present. */
export function detectS7dclKind(text: string): "block" | "type" | "unknown" {
  let i = 0;
  const skipWs = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  skipWs();
  if (text[i] === "{") {
    let depth = 0;
    do {
      if (text[i] === "{") depth++;
      if (text[i] === "}") depth--;
      i++;
    } while (depth > 0 && i < text.length);
  }
  skipWs();
  const rest = text.slice(i, i + 20).toUpperCase();
  if (rest.startsWith("TYPE")) return "type";
  if (BLOCK_KEYWORDS.some((kw) => rest.startsWith(kw))) return "block";
  return "unknown";
}
