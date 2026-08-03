// Recognition of the `<prefix>#<value>` literal forms TIA/S7-SCL spells
// with a `#`, which the lexer is forced to split across several tokens
// because `#` only ever CONTINUES an identifier and never starts a bare
// number (see lexer.ts's own ident rule) -- e.g. `T#10S` lexes as
// ident("T") + ident("#10S"), `16#FF` as number("16") + ident("#FF"), and
// `BYTE#2#1111_0000` as three separate idents. Every consumer that walks
// raw tokens has to re-join those runs before it can tell a literal from a
// real `#tag` operand reference, so the rules live here once instead of in
// a copy per module (parser/s7dclParser.ts, analysis/documentIndex.ts and
// linter/synStructureChecks.ts each carried their own, and they had
// already drifted apart).
import { Token, TokenCursor } from "./lexer";

/** Every letter prefix that can legally precede the `#` of a typed literal,
 * per the S7-SCL "Notation for Constants" grammar (SIMATIC S7-SCL V5.3
 * manual A5E00324650-01, section 9.1.3) plus the S7-1200/1500 types TIA
 * added on top of it:
 *
 *   - bit constants (9.1.3.1): `BOOL#`, `BYTE#`/`B#`, `WORD#`/`W#`,
 *     `DWORD#`/`DW#` -- each followed by a decimal, octal, hexadecimal or
 *     binary digit string, so `BYTE#2#1111_0000` and `WORD#8#177777` are
 *     BOTH a type prefix AND a radix prefix on the same literal;
 *   - integer constants (9.1.3.2): `INT#`, `DINT#` (`INT#16#3f_ff`,
 *     `int#-32768`), plus `L#` for the STL/legacy DInt spelling the same
 *     manual's own comparison table lists;
 *   - real constants (9.1.3.3): `REAL#` (`real#1.5`, `real#2e4`);
 *   - char constants (9.1.3.4): `CHAR#` (`char#43`, `char#'B'`);
 *   - date/time constants (9.1.3.6-9.1.3.8): `DATE#`/`D#`, `TIME#`/`T#`,
 *     `TIME_OF_DAY#`/`TOD#`, `DATE_AND_TIME#`/`DT#`, `S5TIME#`/`S5T#`.
 *
 * The S7-1500 additions (`LWORD#`, `SINT#`/`USINT#`/`UINT#`/`UDINT#`/
 * `LINT#`/`ULINT#`, `LREAL#`, `WCHAR#`, `LTIME#`/`LT#`, `LTOD#`, `LDT#`,
 * `DTL#`) follow the identical `DataType#Value` shape -- they're the same
 * base-types.yaml names, just types the V5.3 manual predates.
 *
 * `P#` (pointer) isn't a constant notation at all, but it shares the exact
 * same split-token shape, so it belongs in the same whitelist.
 *
 * An explicit whitelist rather than "any short word": a `wire#w1` branch
 * label (analysis/documentIndex.ts's own walkOperandRef) must NOT be
 * mistaken for a literal just because "wire" is short. */
/** Prefixes whose value half is a duration (9.1.3.7) -- `T#0.0s`,
 * `TIME#24.855134d`. The trailing unit letters can lex as their own ident
 * once a decimal point has broken the value up, so these get the
 * unit-suffix tail rule. */
const DURATION_PREFIXES = new Set(["T", "TIME", "LT", "LTIME", "S5T", "S5TIME"]);

/** Prefixes whose value half is a date and/or a time of day (9.1.3.6,
 * 9.1.3.8) -- `DATE#1995-11-11`, `TOD#11:11:11`, `DT#95-01-01-12:12:12.2`.
 * The `-` and `:` separators are ordinary punctuation to the lexer (a `-`
 * hugging a digit even folds into the number token), so these get the
 * date/time-separator tail rules. */
const DATE_TIME_PREFIXES = new Set(["D", "DATE", "DT", "DATE_AND_TIME", "LDT", "DTL", "TOD", "TIME_OF_DAY", "LTOD", "LTIME_OF_DAY"]);

export const LITERAL_TYPE_PREFIXES = new Set([
  // bit constants
  "BOOL", "BYTE", "B", "WORD", "W", "DWORD", "DW", "LWORD",
  // integer constants
  "SINT", "INT", "DINT", "LINT", "USINT", "UINT", "UDINT", "ULINT", "L",
  // real constants
  "REAL", "LREAL",
  // character constants
  "CHAR", "WCHAR",
  ...DURATION_PREFIXES,
  ...DATE_TIME_PREFIXES,
  // pointer (not a constant notation, same token shape)
  "P",
]);

/** True when `b` starts exactly where `a` ends, with no whitespace between
 * them -- the only thing that distinguishes a split-up literal from two
 * unrelated tokens that happen to sit next to each other. */
export function tokensAdjacent(a: Token, b: Token): boolean {
  return a.line === b.line && b.offset === a.offset + a.text.length;
}

export interface LiteralRunOptions {
  /** Also consume a `P#`-pointer's dotted address tail (`P#DB10.DBX20.0`)
   * -- alternating `.` + ident/number segments after the `#` part. Scoped
   * to a literal `P` prefix internally, so enabling it can't over-merge an
   * unrelated `.` chain. Only analysis/documentIndex.ts needs this (it
   * reconstructs the full pointer text for classifyLiteral); an expression
   * checker never does, since a pointer literal is not a legal
   * arithmetic/logical/comparison operand. */
  pointerTail?: boolean;
  /** Also treat a bare `TRUE`/`FALSE`/`NULL`/`ZERO` as a one-token literal
   * run. Callers that handle those keywords themselves leave it off. */
  keywordLiterals?: boolean;
}

/**
 * Length, in tokens, of the literal run starting at peek-offset `offset` --
 * 0 if that position isn't the start of one. Pure lookahead; consumes
 * nothing.
 *
 * Two entry shapes, matching the grammar cited on `LITERAL_TYPE_PREFIXES`:
 * a bare radix/decimal literal whose leading digits lexed as a `number`
 * (`16#FF`, `2#1111_0000`, `8#377`, `1.5`), or a letter-prefixed typed
 * literal (`T#10ms`, `W#16#00FF`, `BYTE#2#1111_0000`). Either way the run
 * then absorbs every further adjacent `#`-segment, so a literal carrying
 * BOTH a type prefix and a radix prefix stays one unit.
 */
export function literalRunLength(cur: TokenCursor, offset: number, opts: LiteralRunOptions = {}): number {
  const t0 = cur.peek(offset);

  if (t0.kind === "number") return scanRunTail(cur, offset, 1, t0, "numeric");

  if (t0.kind === "ident" && LITERAL_TYPE_PREFIXES.has(t0.text.toUpperCase())) {
    const t1 = cur.peek(offset + 1);
    if (tokensAdjacent(t0, t1) && t1.kind === "ident" && t1.text.startsWith("#")) {
      return scanRunTail(cur, offset, 2, t1, tailModeFor(t0.text, opts));
    }
  }

  if (opts.keywordLiterals && t0.kind === "ident" && /^(TRUE|FALSE|NULL|ZERO)$/i.test(t0.text)) return 1;

  return 0;
}

/** Which extra tail rules the run may use, decided by the prefix. Scoping
 * them this way is what keeps the permissive ones safe: a `-`-led number
 * continues a `DATE#1995-11-11`, but on a plain numeric run the very same
 * token shape is ordinary subtraction (`4-1`), and a `.`+ident continues a
 * `P#DB10.DBX20.0` but elsewhere is member access. */
type RunTailMode = "numeric" | "duration" | "dateTime" | "pointer";

function tailModeFor(prefixText: string, opts: LiteralRunOptions): RunTailMode {
  const upper = prefixText.toUpperCase();
  if (upper === "P") return opts.pointerTail ? "pointer" : "numeric";
  if (DURATION_PREFIXES.has(upper)) return "duration";
  if (DATE_TIME_PREFIXES.has(upper)) return "dateTime";
  return "numeric";
}

/** An exponent whose sign and digits stayed glued to the `E` (`4e2`,
 * `3E10`) -- as opposed to `3.0E+10`, where the `+` forces the lexer to
 * cut after the `E`. */
const GLUED_EXPONENT_RE = /^[eE]\d+$/;
/** A duration's unit letters, left stranded as their own ident once a
 * decimal point cut the value up: the `s` of `T#0.0s`, the `d` of
 * `TIME#24.855134d`. */
const DURATION_UNIT_RE = /^[A-Za-z]+$/;

/** Shared tail-walk for both entry shapes above: keep absorbing adjacent
 * segments for as long as they can only be part of the same literal. */
function scanRunTail(cur: TokenCursor, offset: number, startLen: number, startPrev: Token, mode: RunTailMode): number {
  let n = startLen;
  let prev = startPrev;
  // An `#` that the lexer had to emit on its OWN, with no value glued to
  // it -- which only happens when the very next character can't continue
  // an identifier, i.e. a sign (`int#-32768`) or a quote (`char#'B'`). A
  // NON-empty segment like the `#FF` of `16#FF` must NOT pull in a
  // following signed number: there, `16#FF-1` is a subtraction.
  const prevIsEmptyHash = (): boolean => prev.kind === "ident" && prev.text === "#";
  for (;;) {
    const nxt = cur.peek(offset + n);
    if (!tokensAdjacent(prev, nxt)) break;

    // A further `#`-segment: the radix half of `BYTE#2#1111_0000`, or the
    // value half of `W#16#00FF`.
    if (nxt.kind === "ident" && nxt.text.startsWith("#")) {
      n++;
      prev = nxt;
      continue;
    }

    // The value half of a SIGNED typed constant (`int#-32768`), or the
    // next dash-separated field of a date (`DATE#1995-11-11`). Either way
    // the sign is part of the number token -- lexer.ts folds a `-`/`+`
    // sitting immediately before a digit into the number -- so the `#`
    // lexes alone and the value arrives as its own adjacent token.
    if (nxt.kind === "number" && (prevIsEmptyHash() || (mode === "dateTime" && nxt.text.startsWith("-")))) {
      n++;
      prev = nxt;
      continue;
    }

    // A quoted value half (`char#'B'`, `Byte#'A'` -- 9.1.3.1's "CHARACTER
    // (1)" branch and 9.1.3.4). Without this the quote lands on its own
    // and reads as a bare String/Char literal, losing the type prefix that
    // is the whole point of writing it that way.
    if (nxt.kind === "string" && prevIsEmptyHash()) {
      n++;
      prev = nxt;
      continue;
    }

    // A decimal point (`1.5`, `real#1.5`, `TIME#24.855134d`), a time-of-day
    // separator (`TOD#11:11:11`), or a P#-pointer's dotted address tail
    // (`P#DB10.DBX20.0` -- the only case where the segment after the dot
    // may be an ident rather than a number).
    if (nxt.kind === "punct" && (nxt.text === "." || (mode === "dateTime" && nxt.text === ":"))) {
      const after = cur.peek(offset + n + 1);
      if (tokensAdjacent(nxt, after) && (after.kind === "number" || (mode === "pointer" && after.kind === "ident"))) {
        n += 2;
        prev = after;
        continue;
      }
    }

    if (nxt.kind === "ident") {
      // `4e2` / `3E10` -- an exponent the lexer couldn't keep with its
      // mantissa. Only after a number, so a `16#FF` style radix tail (an
      // ident already) can't pick up an unrelated neighbour.
      if (mode === "numeric" && prev.kind === "number" && GLUED_EXPONENT_RE.test(nxt.text)) {
        n++;
        prev = nxt;
        continue;
      }
      // `3.0E+10` -- same exponent, but the explicit sign made the lexer
      // cut after the `E` and fold the sign into the following number.
      if (mode === "numeric" && prev.kind === "number" && /^[eE]$/.test(nxt.text)) {
        const after = cur.peek(offset + n + 1);
        if (tokensAdjacent(nxt, after) && after.kind === "number") {
          n += 2;
          prev = after;
          continue;
        }
      }
      // `T#0.0s` -- the duration's trailing unit.
      if (mode === "duration" && prev.kind === "number" && DURATION_UNIT_RE.test(nxt.text)) {
        n++;
        prev = nxt;
        continue;
      }
    }

    break;
  }
  return n;
}

/**
 * True if `hashToken` (a `#...`-shaped ident) is really the tail half of a
 * split-up literal or of a `wire#label` branch tap -- NOT a `#tag` operand
 * reference. Both share the exact token shape a real `#tag` has, so a
 * token-walking caller that skips this check reports e.g. the `#EFEF` of
 * `16#EFEF` as an undeclared identifier.
 *
 * Three ways the preceding token can mark it as a tail, all requiring
 * strict adjacency:
 *   - a `number` -- the bare radix prefix `2#`/`8#`/`16#` (the digits lex
 *     as a number, so this case is NOT covered by the prefix whitelist);
 *   - another `#`-segment -- the second half of a two-prefix literal like
 *     `W#16#00FF` or `BYTE#2#1111_0000`. Safe as a blanket rule: no legal
 *     syntax puts a real `#tag` immediately against another `#`, so an
 *     adjacent `#`-pair can only come from one split literal;
 *   - a whitelisted type prefix, or `wire`.
 */
export function isLiteralOrWireTail(prevToken: Token | null, hashToken: Token): boolean {
  if (!prevToken || !tokensAdjacent(prevToken, hashToken)) return false;
  if (prevToken.kind === "number") return true;
  if (prevToken.kind !== "ident") return false;
  if (prevToken.text.startsWith("#")) return true;
  const upper = prevToken.text.toUpperCase();
  return upper === "WIRE" || LITERAL_TYPE_PREFIXES.has(upper);
}
