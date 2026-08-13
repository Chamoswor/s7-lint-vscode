// Determines WHICH syntactic position an `.scl` document's cursor sits in,
// for providers/completion.ts's own section-aware suggestion gating: a
// declaration section (VAR_INPUT/VAR_OUTPUT/VAR_IN_OUT/VAR_TEMP/
// VAR_CONSTANT/VAR, up to its own END_VAR) has an entirely different legal
// vocabulary (datatype names) than the executable body (BEGIN ... its
// enclosing block's own END_xxx -- instructions, tag references, external
// block references). Parser/token-driven (this project's own Lexer),
// deliberately NOT regex-over-raw-text -- a regex can't tell "inside a
// `/* datatype-shaped */` comment" or "inside a string literal" from the
// real thing, a real tokenizer does for free.
//
// Only ever tokenizes `text.slice(0, offset)` -- everything AT OR AFTER the
// cursor is irrelevant to "what section/position is the cursor in RIGHT
// NOW" (a section is fully determined by what opened before the cursor and
// hasn't closed yet), and this sidesteps a real hazard: the project's own
// Lexer's double-quoted string rule has no line-boundary stop (see
// lexer.ts), so a lone `"` the user just typed (with a real closing quote
// possibly sitting many lines further down, e.g. some OTHER declaration's
// `"SomeUdt"`) would otherwise swallow everything up to that unrelated
// quote into one giant string token if the whole document were tokenized.
// Bounding to the cursor makes that impossible: there's nothing PAST the
// cursor to run into.
import { Lexer, Token } from "../parser/lexer";
import { RuleSet } from "../rules/types";

/** Every SCL top-level construct -- a source file's own root is everything
 * OUTSIDE of one of these, from its own opening keyword through its own
 * matching closer (`TOP_LEVEL_CLOSERS` below). Blocks never nest in this
 * grammar (same assumption providers/instanceQuickFix.ts's own
 * `findBlockSpan` already makes), so a plain open/close toggle -- not a
 * depth counter -- is enough to track "are we currently inside one". */
const TOP_LEVEL_KEYWORDS = ["FUNCTION_BLOCK", "FUNCTION", "ORGANIZATION_BLOCK", "DATA_BLOCK", "TYPE"];

/** The matching closers for `TOP_LEVEL_KEYWORDS` -- and ONLY those. This must
 * be an explicit list, never an `END_`-prefix test: an executable body is full
 * of STATEMENT closers that share that prefix (`END_IF`, `END_CASE`, `END_FOR`,
 * `END_WHILE`, `END_REPEAT`, `END_REGION`). Treating one of those as a
 * top-level closer ends the block early, which made every position after the
 * first `END_IF;` in a body look like the source-file ROOT -- offering
 * FUNCTION_BLOCK/DATA_BLOCK/TYPE templates mid-code and, worse, suppressing the
 * body's own instruction/tag completions. */
const TOP_LEVEL_CLOSERS = ["END_FUNCTION_BLOCK", "END_FUNCTION", "END_ORGANIZATION_BLOCK", "END_DATA_BLOCK", "END_TYPE"];
export const VAR_SECTION_KEYWORDS = ["VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT", "VAR_TEMP", "VAR_CONSTANT", "VAR"] as const;
export type SclSection = (typeof VAR_SECTION_KEYWORDS)[number] | "TYPE";

/** `SclSection` -> resources/type-registry/section-legality.yaml's own
 * section key -- mirrors analysis/documentIndex.ts's own (private, not
 * exported) `VAR_SECTION_TO_LEGALITY_SECTION`; kept as its own small copy
 * here rather than imported, matching this project's own convention of
 * duplicating a small, stable constant across independent modules instead
 * of adding a cross-module coupling for six lines of data. */
const VAR_SECTION_TO_LEGALITY_SECTION: Record<Exclude<SclSection, "TYPE">, string> = {
  VAR_INPUT: "Input",
  VAR_OUTPUT: "Output",
  VAR_IN_OUT: "InOut",
  VAR: "Static",
  VAR_TEMP: "Temp",
  VAR_CONSTANT: "Constant",
};

export interface SectionTypeLegality {
  /** Every legal BARE (non-quoted) built-in/system/opaque type name for
   * this section -- section-legality.yaml's `allSections.datatypes` plus
   * this section's own `additionalDatatypes`, with the `"Array[0..1] of"`
   * placeholder (see that file's own trailing note) replaced by a literal
   * `"Array"` entry when arrays are legal here at all. */
  names: string[];
  /** True when a quoted PLC-data-type (UDT) reference is legal in this
   * section at all -- section-legality.yaml has no per-UDT-name
   * granularity (a UDT's own legality here is a property of it resolving
   * to SOME struct shape, not its specific name), so this is keyed off
   * whether `"Struct"` appears in the section's own `additionalDatatypes`
   * -- e.g. `false` for VAR_CONSTANT (empty list), `true` everywhere
   * else. */
  allowsUdt: boolean;
}

/** Resolves `section`'s own legal-type-name set from RuleSet.sectionLegality
 * -- see `SectionTypeLegality`'s own comment on each field. */
export function legalTypeNamesForSection(ruleSet: RuleSet, section: SclSection): SectionTypeLegality {
  // section-legality.yaml explicitly models only code-block VAR_* sections,
  // not a PLC data type's own member list. Keep TYPE completion conservative:
  // use only its universally legal set plus the three composition forms that
  // composition-rules.yaml independently establishes for UDTs (Array,
  // Struct, and another named UDT). Do not leak Static-only system/opaque
  // handles into this separate declaration context.
  if (section === "TYPE") {
    return { names: [...ruleSet.sectionLegality.allSections.datatypes, "Array", "Struct"], allowsUdt: true };
  }
  const legalitySection = VAR_SECTION_TO_LEGALITY_SECTION[section];
  const names = new Set<string>(ruleSet.sectionLegality.allSections.datatypes);
  const additional = ruleSet.sectionLegality.sections[legalitySection]?.additionalDatatypes ?? [];
  let allowsUdt = false;
  for (const n of additional) {
    if (n === "Array[0..1] of") {
      names.add("Array");
      continue;
    }
    if (n === "Struct") allowsUdt = true;
    names.add(n);
  }
  return { names: [...names], allowsUdt };
}

/** Where exactly, within an in-progress declaration's TYPE position, the
 * cursor sits -- see this file's own header. `anchorEnd` is always the raw
 * text offset immediately after the token that introduces the type
 * position (`:`, or `of` for an array's element type) -- used by the
 * completion provider to decide whether a leading space needs inserting
 * (no gap at all between the anchor and the partial/cursor) without
 * re-deriving that from raw text itself. */
export type DeclSubContext =
  | { kind: "name" } // still typing the member name, or nothing typed since the last ';' -- no completions at all
  | { kind: "array-bounds" } // inside `Array[...]`'s own brackets -- no completions
  | { kind: "after-array-keyword" } // `Array` just typed/completed, nothing after it yet -- offer the `[lo..hi] of` scaffold
  | { kind: "awaiting-of" } // past `Array[...]`, `of` not typed (or not yet complete) -- no completions
  | { kind: "closed" } // already a complete, closed type expression -- nothing left to complete
  | { kind: "bare-type"; anchorEnd: number; afterArrayOf: boolean; identStart: number | null }
  | { kind: "quoted-type"; anchorEnd: number; afterArrayOf: boolean; quoteStart: number; identStart: number };

export type SclCompletionContext =
  | { kind: "none" } // not inside any recognized declaration section OR executable body, but ALSO not at the source-file root (for example a block header/attributes area)
  | { kind: "root" } // the source-file root itself, outside every top-level block -- see providers/completion.ts's `topLevelCompletions`
  | { kind: "executable" } // inside BEGIN ... the enclosing block's own END_xxx
  | { kind: "declaration"; section: SclSection; decl: DeclSubContext }
  | { kind: "function-return-type"; anchorEnd: number; identStart: number | null } // a FUNCTION header's own `: <ReturnType>` position, before VERSION/pragma -- see `classifyFunctionReturnType`
  | { kind: "data-block-instance-ref"; quoteStart: number; identStart: number; textSoFar: string }; // a DATA_BLOCK header's own quoted referenced-symbol slot, right after `NON_RETAIN` -- see `classifyDataBlockInstanceRef`

/** A plain forward cursor over a fixed token array, used only by the
 * member-list walker below -- distinct from parser/lexer.ts's own
 * `TokenCursor` (that one clamps at the end and always has an EOF token to
 * park on; this walker instead needs a sharp "ran out of tokens" signal
 * `atEnd()` gives, since running out of tokens mid-construct IS the
 * cursor's own position -- see this file's own header). */
class Walk {
  i = 0;
  constructor(private readonly tokens: Token[]) {}
  atEnd(): boolean {
    return this.i >= this.tokens.length;
  }
  peek(): Token {
    return this.tokens[this.i];
  }
  next(): Token {
    return this.tokens[this.i++];
  }
}

/** Consumes ONE type expression starting at `w`'s current position (right
 * after the introducing `:`/`of`) -- `Array[lo..hi] of <type>` (recursing
 * for the element type), an inline `Struct <members> END_STRUCT` (
 * recursing into `walkMemberList` for the nested member list -- this is
 * what lets a completion request correctly land inside, or AFTER, an
 * arbitrarily nested inline STRUCT), a quoted UDT name, or a bare type
 * name. Returns `{ done: true, selfTerminated }` once a complete,
 * recognizable type expression has been consumed -- `selfTerminated` is
 * true ONLY for `Struct ... END_STRUCT;`, which (per real SCL grammar)
 * already consumes its OWN trailing `;` as part of `END_STRUCT;` itself,
 * so the caller (`walkMemberList`) must NOT then go looking for a
 * SEPARATE terminator the way it does for every other type shape.
 * `{ done: false, ctx }` the moment `w` runs out of tokens (or hits an
 * unrecognized/malformed shape) mid-expression -- `ctx` is exactly the
 * `DeclSubContext` for wherever that happened. */
function walkTypeExpr(w: Walk, anchorEnd: number, afterArrayOf: boolean): { done: true; selfTerminated: boolean } | { done: false; ctx: DeclSubContext } {
  if (w.atEnd()) return { done: false, ctx: { kind: "bare-type", anchorEnd, afterArrayOf, identStart: null } };
  const t0 = w.peek();

  if (!afterArrayOf && t0.kind === "ident" && t0.text.toUpperCase() === "ARRAY") {
    w.next();
    if (w.atEnd()) return { done: false, ctx: { kind: "after-array-keyword" } };
    if (!(w.peek().kind === "punct" && w.peek().text === "[")) return { done: false, ctx: { kind: "closed" } };
    w.next();
    let depth = 1;
    while (depth > 0) {
      if (w.atEnd()) return { done: false, ctx: { kind: "array-bounds" } };
      const t = w.next();
      if (t.kind === "punct" && t.text === "[") depth++;
      else if (t.kind === "punct" && t.text === "]") depth--;
    }
    if (w.atEnd()) return { done: false, ctx: { kind: "awaiting-of" } };
    const ofTok = w.peek();
    if (!(ofTok.kind === "ident" && ofTok.text.toUpperCase() === "OF")) return { done: false, ctx: { kind: "awaiting-of" } };
    w.next();
    return walkTypeExpr(w, ofTok.offset + ofTok.text.length, true);
  }

  if (t0.kind === "ident" && t0.text.toUpperCase() === "STRUCT") {
    w.next();
    const nested = walkMemberList(w, "END_STRUCT");
    if (nested) return { done: false, ctx: nested }; // cursor lands somewhere inside the nested member list
    return { done: true, selfTerminated: true }; // this Struct's own END_STRUCT + ';' already fully consumed
  }

  if (t0.kind === "string" && t0.text.startsWith('"')) {
    w.next();
    const isTerminated = t0.text.length >= 2 && t0.text.endsWith('"');
    // `isTerminated` can only be true here if BOTH quotes lie before the
    // cursor (this module only ever tokenizes up to it -- see file
    // header), i.e. the name is already fully typed and closed.
    if (!isTerminated) return { done: false, ctx: { kind: "quoted-type", anchorEnd, afterArrayOf, quoteStart: t0.offset, identStart: t0.offset + 1 } };
    if (w.atEnd()) return { done: false, ctx: { kind: "closed" } };
    return { done: true, selfTerminated: false };
  }

  if (t0.kind === "ident") {
    w.next();
    if (w.atEnd()) return { done: false, ctx: { kind: "bare-type", anchorEnd, afterArrayOf, identStart: t0.offset } };
    return { done: true, selfTerminated: false };
  }

  return { done: false, ctx: { kind: "closed" } };
}

/** Consumes a member list -- a VAR section's own top-level members, or an
 * inline `Struct`'s nested ones (same grammar either way: `name : type
 * [:= default];`, repeated) -- until `closer` (`END_VAR`/`END_STRUCT`) is
 * found and consumed (returns `null`: this list is fully closed, nothing
 * to say about it, caller continues past it) or `w` runs out of tokens
 * partway through a member (returns the `DeclSubContext` for wherever
 * that happened). */
function walkMemberList(w: Walk, closer: "END_VAR" | "END_STRUCT"): DeclSubContext | null {
  for (;;) {
    if (w.atEnd()) return { kind: "name" }; // right at a fresh member boundary
    if (w.peek().kind === "ident" && w.peek().text.toUpperCase() === closer) {
      w.next();
      if (!w.atEnd() && w.peek().kind === "punct" && w.peek().text === ";") w.next();
      return null;
    }

    w.next(); // the member's name (or, for a malformed/unexpected token, whatever's there -- treated the same way below)
    if (w.atEnd()) return { kind: "name" };
    if (!(w.peek().kind === "punct" && w.peek().text === ":")) return { kind: "name" };
    const colonTok = w.next();
    const anchorEnd = colonTok.offset + colonTok.text.length;

    const typeResult = walkTypeExpr(w, anchorEnd, false);
    if (!typeResult.done) return typeResult.ctx;
    if (typeResult.selfTerminated) continue; // Struct already consumed its own END_STRUCT + ';' -- nothing more to look for on this member

    if (w.atEnd()) return { kind: "closed" };
    if (w.peek().kind === "op" && w.peek().text === ":=") {
      w.next();
      let depth = 0;
      for (;;) {
        if (w.atEnd()) return { kind: "closed" }; // mid-default-value -- nothing to suggest
        const t = w.next();
        if (t.kind === "punct" && (t.text === "(" || t.text === "[")) depth++;
        else if (t.kind === "punct" && (t.text === ")" || t.text === "]")) depth--;
        else if (t.kind === "punct" && t.text === ";" && depth <= 0) break;
      }
      continue;
    }
    if (w.peek().kind === "punct" && w.peek().text === ";") {
      w.next();
      continue;
    }
    return { kind: "closed" }; // unexpected token right after a complete type -- malformed, don't guess
  }
}

/** Classifies `declTokens` (everything since the section keyword, up to
 * the cursor) by walking it as a real member list -- see `walkMemberList`.
 * The top-level call's own `closer` (`END_VAR`) can never actually be
 * FOUND within `declTokens` (if it had been, `resolveSclCompletionContext`'s
 * own section-tracking loop would already have reset `section` to `null`
 * and never called this at all) -- the `?? {kind:"name"}` fallback for
 * that case only exists for symmetry with `walkMemberList`'s general
 * contract, never actually exercised here. */
function classifyDeclaration(declTokens: Token[]): DeclSubContext {
  return walkMemberList(new Walk(declTokens), "END_VAR") ?? { kind: "name" };
}

/** Classifies `headerTokens` (everything since a `FUNCTION` keyword, up to
 * the cursor) as a `FUNCTION "<Name>" : <ReturnType>` header's own
 * return-type position -- `undefined` for every OTHER position in that
 * same header (still typing the quoted name, name done but `:` not yet
 * typed, or anything at all following a already-complete return-type
 * identifier -- VERSION/a pragma/BEGIN would all show up here as "more
 * tokens after a complete ident", correctly falling through to `undefined`
 * rather than being misread as the return-type slot). Deliberately only
 * recognizes a single bare identifier as the return type (`Void`, `Int`,
 * `Real`, ...) -- a function's return type is never an inline `Struct` or
 * `Array` in this grammar, unlike a VAR-section member's own type. */
function classifyFunctionReturnType(headerTokens: Token[]): { anchorEnd: number; identStart: number | null } | undefined {
  let i = 0;
  if (i >= headerTokens.length) return undefined; // nothing typed since `FUNCTION` -- still the block's own name
  const nameTok = headerTokens[i];
  if (nameTok.kind !== "string") return undefined;
  const nameClosed = nameTok.text.length >= 2 && nameTok.text.endsWith('"');
  if (!nameClosed) return undefined; // still typing the quoted name itself
  i++;
  if (i >= headerTokens.length) return undefined; // name done, ':' not yet typed
  const colonTok = headerTokens[i];
  if (!(colonTok.kind === "punct" && colonTok.text === ":")) return undefined;
  const anchorEnd = colonTok.offset + colonTok.text.length;
  i++;
  if (i >= headerTokens.length) return { anchorEnd, identStart: null }; // right after ':', nothing typed yet
  const typeTok = headerTokens[i];
  if (typeTok.kind !== "ident") return undefined; // malformed -- don't guess
  i++;
  if (i >= headerTokens.length) return { anchorEnd, identStart: typeTok.offset }; // mid-typing the return type
  return undefined; // something follows an already-complete return type -- slot is closed
}

/** Classifies `headerTokens` (everything since a `DATA_BLOCK` keyword, up
 * to the cursor) as that DATA_BLOCK's own quoted referenced-symbol slot --
 * the `"<Name>"` line right after a bare `NON_RETAIN`, used by both the FB-
 * instance and PLC-data-type-based DATA_BLOCK templates (see
 * providers/completion.ts's own `topLevelCompletions`). `undefined`
 * everywhere else in that header (name not yet closed, `NON_RETAIN` not
 * reached yet, or -- once something follows a fully-typed referenced-
 * symbol string -- the slot has already closed). Deliberately looks for
 * the LAST `NON_RETAIN` in the header (there's only ever one in a
 * well-formed header) rather than anchoring off the block's own name/
 * pragma/VERSION shape the way `classifyFunctionReturnType` does for a
 * FUNCTION header -- a DATA_BLOCK's own pragma/VERSION content is free-
 * form enough (an arbitrary property list) that re-deriving its exact
 * shape here would be duplicating, and could drift out of sync with,
 * `buildSingleInstanceDbText`'s own real generated shape; anchoring on
 * `NON_RETAIN` instead needs no assumption about anything before it. */
function classifyDataBlockInstanceRef(headerTokens: Token[]): { quoteStart: number; identStart: number; textSoFar: string } | undefined {
  let lastNonRetain = -1;
  for (let i = 0; i < headerTokens.length; i++) {
    if (headerTokens[i].kind === "ident" && headerTokens[i].text.toUpperCase() === "NON_RETAIN") lastNonRetain = i;
  }
  if (lastNonRetain === -1) return undefined;
  const rest = headerTokens.slice(lastNonRetain + 1);
  if (rest.length !== 1) return undefined; // nothing typed yet after NON_RETAIN, or the slot's already closed
  const strTok = rest[0];
  if (strTok.kind !== "string" || !strTok.text.startsWith('"')) return undefined;
  return { quoteStart: strTok.offset, identStart: strTok.offset + 1, textSoFar: strTok.value ?? "" };
}

/** The one entry point: where is `offset` (an absolute character offset
 * into `text`) syntactically, for completion-gating purposes? See this
 * file's own header for the overall approach. */
export function resolveSclCompletionContext(text: string, offset: number): SclCompletionContext {
  // `tokenize()` always appends a trailing EOF token -- drop it so every
  // length/last-token check below (an empty type expression, an in-
  // progress declaration with nothing typed since the last `;`, ...)
  // isn't thrown off by a phantom extra token.
  const tokens = new Lexer(text.slice(0, offset)).tokenize().filter((t) => t.kind !== "eof");

  let section: SclSection | null = null;
  let inBody = false;
  let sectionStart = -1;
  // Toggled false the moment ANY top-level keyword opens, true again once
  // its own closer is reached -- see `TOP_LEVEL_KEYWORDS`'s own comment for
  // why a plain toggle (not a depth counter) is enough.
  let atRoot = true;
  // Set to the token index right after a `FUNCTION` opener (cleared by any
  // OTHER top-level opener, `BEGIN`, or that same function's own closer) --
  // lets the final check below re-walk just that header's own tokens for
  // `classifyFunctionReturnType`, without re-scanning the whole document.
  let functionHeaderStart = -1;
  // Same idea, for a `DATA_BLOCK` opener -- `classifyDataBlockInstanceRef`.
  let dataBlockHeaderStart = -1;
  // A top-level TYPE owns a STRUCT member list without a VAR/END_VAR wrapper.
  // Track the OUTERMOST STRUCT separately, including nested inline Struct
  // types, so its members can reuse the same real member-list classifier as a
  // VAR section without mistaking the header or post-END_STRUCT area for one.
  let topLevelKind: string | null = null;
  let typeMemberStart = -1;
  let typeStructDepth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== "ident") continue;
    const up = t.text.toUpperCase();

    if (TOP_LEVEL_KEYWORDS.includes(up)) {
      section = null;
      inBody = false;
      atRoot = false;
      functionHeaderStart = up === "FUNCTION" ? i + 1 : -1;
      dataBlockHeaderStart = up === "DATA_BLOCK" ? i + 1 : -1;
      topLevelKind = up;
      typeMemberStart = -1;
      typeStructDepth = 0;
      continue;
    }
    if (up === "END_VAR") {
      section = null;
      continue;
    }
    if (up === "END_STRUCT") {
      // A fully-typed inline Struct member's own closer, seen at THIS
      // (section-tracking) level -- entirely `classifyDeclaration`/
      // `walkMemberList`'s own concern (they re-walk this same section's
      // tokens from scratch and correctly recurse through it), OR (inside
      // a top-level TYPE declaration) just the UDT's own struct body --
      // nothing for the outer section/body/root tracker to do with it
      // either way; a TYPE's own root-return only happens at `END_TYPE`
      // below.
      if (topLevelKind === "TYPE" && typeStructDepth > 0) {
        typeStructDepth--;
        if (typeStructDepth === 0) typeMemberStart = -1;
      }
      continue;
    }
    if (up === "STRUCT" && topLevelKind === "TYPE") {
      if (typeStructDepth === 0) typeMemberStart = i + 1;
      typeStructDepth++;
      continue;
    }
    if (up === "BEGIN") {
      inBody = true;
      section = null;
      functionHeaderStart = -1;
      dataBlockHeaderStart = -1;
      topLevelKind = null;
      typeMemberStart = -1;
      typeStructDepth = 0;
      continue;
    }
    if (TOP_LEVEL_CLOSERS.includes(up)) {
      // A real top-level block closer -- back at the source-file root.
      // Statement closers (END_IF/END_CASE/END_FOR/END_WHILE/END_REPEAT/
      // END_REGION) deliberately do NOT match here; they are ordinary body
      // tokens and must leave `inBody`/`atRoot` untouched. See
      // TOP_LEVEL_CLOSERS' own comment.
      inBody = false;
      atRoot = true;
      functionHeaderStart = -1;
      dataBlockHeaderStart = -1;
      continue;
    }
    if (up === "VAR" && tokens[i + 1]?.kind === "ident" && tokens[i + 1].text.toUpperCase() === "CONSTANT") {
      section = "VAR_CONSTANT";
      sectionStart = i + 2;
      i++;
      continue;
    }
    if ((VAR_SECTION_KEYWORDS as readonly string[]).includes(up)) {
      section = up as SclSection;
      sectionStart = i + 1;
      continue;
    }
  }

  if (inBody) return { kind: "executable" };
  if (section) return { kind: "declaration", section, decl: classifyDeclaration(tokens.slice(sectionStart)) };
  if (typeMemberStart >= 0) return { kind: "declaration", section: "TYPE", decl: classifyDeclaration(tokens.slice(typeMemberStart)) };
  if (functionHeaderStart >= 0) {
    const returnType = classifyFunctionReturnType(tokens.slice(functionHeaderStart));
    if (returnType) return { kind: "function-return-type", ...returnType };
  }
  if (dataBlockHeaderStart >= 0) {
    const ref = classifyDataBlockInstanceRef(tokens.slice(dataBlockHeaderStart));
    if (ref) return { kind: "data-block-instance-ref", ...ref };
  }
  return atRoot ? { kind: "root" } : { kind: "none" };
}
