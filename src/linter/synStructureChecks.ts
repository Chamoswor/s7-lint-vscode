// A dedicated, ADDITIVE recursive-descent structural/syntax checker over an
// SCL BEGIN...END body (and its VAR sections), exercised by the
// scripts/fixtures/scl-diagnostics/negative/parser suite. Deliberately kept as its OWN
// independent walk over its OWN Lexer/TokenCursor instance, rather than
// bolted onto parser/s7dclParser.ts or analysis/documentIndex.ts's existing
// walks -- both of those are explicitly tolerant-by-design (s7dclParser.ts's
// own header: "unrecognized tokens ... are skipped rather than raising a
// hard parse error"), and every OTHER check in this project depends on that
// tolerance never regressing. This module only ADDS diagnostics for
// constructs that are genuinely, unrecoverably malformed; it never changes
// what any other parser/check does, and its own recovery mistakes (this is
// a best-effort recursive descent, not a full validated grammar) can only
// ever produce an extra diagnostic on already-broken code, never a false
// positive on valid code -- see this file's own private functions for where
// that guarantee comes from (`scanExpr`'s "two operand-like tokens in a
// row" boundary rule, `isUniversalStop`'s keyword safety net, and every
// caller loop's own defensive `cur.next()` fallback that guarantees forward
// progress regardless of how confused the recovery gets).
import { Lexer, Token, TokenCursor } from "../parser/lexer";
import { parseTypeRefFromCursor } from "../parser/typeRef";
import { RuleSet } from "../rules/types";
import { formatDiagnostic, LintDiagnostic } from "./diagnostics";

const BLOCK_KEYWORDS = ["FUNCTION_BLOCK", "FUNCTION", "ORGANIZATION_BLOCK", "DATA_BLOCK"];
const VAR_KEYWORDS = ["VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT", "VAR_TEMP", "VAR_CONSTANT", "VAR"];

/** SCL's reserved statement/operator keywords -- mirrors s7dclParser.ts's
 * own `SCL_RESERVED_KEYWORDS` (kept as a separate copy since this module is
 * deliberately independent of that one, see this file's own header). */
const SCL_RESERVED_KEYWORDS = new Set([
  "IF", "THEN", "ELSE", "ELSIF", "END_IF",
  "CASE", "OF", "END_CASE",
  "FOR", "TO", "BY", "DO", "END_FOR",
  "WHILE", "END_WHILE",
  "REPEAT", "UNTIL", "END_REPEAT",
  "CONTINUE", "EXIT", "GOTO", "RETURN",
  "REGION", "END_REGION",
  "AND", "OR", "XOR", "NOT", "MOD",
]);

/** Keywords that can NEVER legally appear inside an expression -- reaching
 * one while scanning an expression (`scanExpr`) always means either "this
 * IS the caller's own expected terminator" (checked first) or "something
 * upstream is malformed, stop here rather than run away." Deliberately
 * EXCLUDES `AND`/`OR`/`XOR`/`NOT`/`MOD`, which genuinely are expression
 * operators. */
const STATEMENT_BOUNDARY_KEYWORDS = new Set([
  "IF", "THEN", "ELSE", "ELSIF", "END_IF",
  "CASE", "OF", "END_CASE",
  "FOR", "TO", "BY", "DO", "END_FOR",
  "WHILE", "END_WHILE",
  "REPEAT", "UNTIL", "END_REPEAT",
  "CONTINUE", "EXIT", "GOTO", "RETURN",
  "REGION", "END_REGION",
]);

/** `END_xxx` closers whose cross-construct nesting is actually validated
 * (`syn-unmatched-end-if`/`syn-unmatched-end-for`, and
 * `syn-mismatched-block-terminator` when it belongs to an ANCESTOR
 * construct instead of the immediate one) -- see the scl-diagnostics manifest's
 * SYN-IF-005/SYN-FOR-005/SYN-CTRL-003. Deliberately NOT extended to
 * END_WHILE/END_CASE/END_REPEAT: REPEAT's own "missing UNTIL" recovery
 * (SYN-REPEAT-001) relies on seeing its OWN upcoming END_REPEAT as "not a
 * statement, stop the list" rather than as a flagged mismatch, and no
 * fixture exercises the WHILE/CASE cross-construct case, so there's no
 * reason to take on that risk for zero benefit. */
const UNMATCHED_CLOSER_CODE: Record<string, string> = {
  END_IF: "syn-unmatched-end-if",
  END_FOR: "syn-unmatched-end-for",
};

const LITERAL_LETTER_PREFIXES = new Set([
  "T", "TIME", "LT", "LTIME", "S5T", "S5TIME",
  "D", "DATE", "DT", "DATE_AND_TIME", "DTL",
  "TOD", "TIME_OF_DAY", "LTOD", "B", "W", "DW", "P",
]);

function tokensAdjacent(a: Token, b: Token): boolean {
  return a.line === b.line && b.offset === a.offset + a.text.length;
}

/** Checks a syntax-checker file for structural defects a real SCL parser
 * would report (missing THEN/DO/OF/semicolon, unclosed paren/bracket,
 * wrong or unmatched END_xxx, EXIT/CONTINUE outside a loop, ...), plus the
 * lexer-level unterminated-string/comment cases. Runs its own independent
 * tokenization; never throws on malformed input (every loop below either
 * consumes a token or returns, so the caller always makes forward
 * progress). */
export function checkSclSyntaxStructure(text: string, ruleSet: RuleSet): LintDiagnostic[] {
  const lexer = new Lexer(text);
  const tokens = lexer.tokenize();
  const cur = new TokenCursor(tokens);
  const diagnostics: LintDiagnostic[] = [];

  for (const err of lexer.errors) {
    diagnostics.push(
      formatDiagnostic(ruleSet, err.kind === "unterminated-string" ? "syn-unterminated-string" : "syn-unterminated-comment", err.line, err.col)
    );
  }

  function report(code: string, tok: Token, params: Record<string, string | number> = {}): void {
    diagnostics.push(formatDiagnostic(ruleSet, code, tok.line, tok.col, params));
  }

  // --- shared small helpers -------------------------------------------

  function literalRunLength(offset: number): number {
    const t0 = cur.peek(offset);
    if (t0.kind === "number") {
      let n = 1;
      let prev = t0;
      for (;;) {
        const nxt = cur.peek(offset + n);
        if (!tokensAdjacent(prev, nxt)) break;
        if (nxt.kind === "ident" && nxt.text.startsWith("#")) {
          n++;
          prev = nxt;
          continue;
        }
        if (nxt.kind === "punct" && nxt.text === ".") {
          const after = cur.peek(offset + n + 1);
          if (tokensAdjacent(nxt, after) && after.kind === "number") {
            n += 2;
            prev = after;
            continue;
          }
        }
        break;
      }
      return n;
    }
    if (t0.kind === "ident" && LITERAL_LETTER_PREFIXES.has(t0.text.toUpperCase())) {
      const t1 = cur.peek(offset + 1);
      if (tokensAdjacent(t0, t1) && t1.kind === "ident" && t1.text.startsWith("#")) {
        let n = 2;
        let prev = t1;
        for (;;) {
          const nxt = cur.peek(offset + n);
          if (!tokensAdjacent(prev, nxt)) break;
          if (nxt.kind === "ident" && nxt.text.startsWith("#")) {
            n++;
            prev = nxt;
            continue;
          }
          break;
        }
        return n;
      }
    }
    if (t0.kind === "ident" && /^(TRUE|FALSE|NULL|ZERO)$/i.test(t0.text)) return 1;
    return 0;
  }

  function isOperandRefStart(): boolean {
    const t0 = cur.peek();
    if (t0.kind === "ident" && t0.text.startsWith("#")) return true;
    if (t0.kind === "string" && t0.text.startsWith('"') && cur.peek(1).kind === "punct" && cur.peek(1).text === ".") return true;
    return false;
  }

  function isCallStart(): boolean {
    const t0 = cur.peek();
    if (t0.kind === "string" && t0.text.startsWith('"') && cur.peek(1).kind === "punct" && cur.peek(1).text === "(") return true;
    if (t0.kind === "ident" && t0.text.startsWith("#")) {
      const t1 = cur.peek(1);
      const t2 = cur.peek(2);
      const t3 = cur.peek(3);
      if (t1.kind === "punct" && t1.text === "." && t2.kind === "ident" && t3.kind === "punct" && t3.text === "(") return true;
      if (t1.kind === "punct" && t1.text === "(") return true;
      return false;
    }
    if (t0.kind === "ident" && !SCL_RESERVED_KEYWORDS.has(t0.text.toUpperCase()) && cur.peek(1).kind === "punct" && cur.peek(1).text === "(") {
      return true;
    }
    return false;
  }

  function isUniversalStop(t: Token): boolean {
    if (t.kind === "eof") return true;
    if (t.kind === "punct" && t.text === ";") return true;
    if (t.kind === "op" && (t.text === ":=" || t.text === "?=" || t.text === "=>")) return true;
    if (t.kind === "ident") {
      const up = t.text.toUpperCase();
      if (STATEMENT_BOUNDARY_KEYWORDS.has(up)) return true;
      if (up.startsWith("END_")) return true;
    }
    return false;
  }

  /** Consumes tokens (paren/bracket-depth aware) until a top-level `;` (
   * consumed) or a statement-boundary keyword (NOT consumed, so the normal
   * flow can pick back up from it) -- the shared "give up on this
   * statement, resync" recovery used when a nested call or array index
   * never finds its own closer. Bounded by keywords rather than only `;`
   * so a failure inside a condition (never `;`-terminated) can't run away
   * past its own IF/WHILE/FOR/CASE boundary. */
  function resyncPastStatement(): void {
    let depth = 0;
    while (!cur.atEnd()) {
      const t = cur.peek();
      if (t.kind === "punct" && (t.text === "(" || t.text === "[")) {
        depth++;
        cur.next();
        continue;
      }
      if (t.kind === "punct" && (t.text === ")" || t.text === "]")) {
        depth--;
        cur.next();
        continue;
      }
      if (depth <= 0 && t.kind === "punct" && t.text === ";") {
        cur.next();
        return;
      }
      if (depth <= 0 && t.kind === "ident") {
        const up = t.text.toUpperCase();
        if (STATEMENT_BOUNDARY_KEYWORDS.has(up) || up.startsWith("END_")) return;
      }
      cur.next();
    }
  }

  interface ScanResult {
    stopToken: Token;
    matchedStop: boolean;
    hadValue: boolean;
    /** True when a genuine unclosed-paren diagnostic already fired for
     * THIS scan (or a nested call/index inside it already reported +
     * resynced its own failure) -- callers use this to tell "stopped
     * because a paren never closed" (already handled, may still need a
     * resync past the wreckage) apart from "stopped because the next
     * token looks like a brand-new statement/keyword with nothing
     * actually unbalanced" (a plain missing terminator -- report that
     * instead, and do NOT resync, since the stop token is already a
     * valid place to resume from). */
    unclosedReported: boolean;
  }

  /** Scans one expression (condition, RHS, call-arg value, array index) by
   * PEEKING/CONSUMING from the shared cursor, reporting + recovering as it
   * goes for anything unclosed. Never validates operator precedence/types
   * (that's linter/exprTypeChecks.ts's job on a different pass) -- purely
   * shape: are parens/brackets balanced, is every operator followed by a
   * real operand, are call arguments comma-separated.
   *
   * `stopMatches` identifies THIS call's own intended terminator (e.g. "="
   * text "THEN" for an IF condition, "," or ")" for a call-arg value) --
   * checked only at this scan's own paren depth 0. Independently, ANY
   * depth also stops (not cleanly -- `matchedStop: false`) at
   * `isUniversalStop`, the shared safety net for tokens that can never
   * legally appear inside an expression at all. Sets `resyncPerformed`
   * when a nested call/index failure already consumed past this
   * statement's own end -- callers must check it before doing anything
   * else. */
  let resyncPerformed = false;

  function scanExpr(stopMatches: (t: Token) => boolean): ScanResult {
    const openStack: Token[] = [];
    let lastWasOperand = false;

    function finish(stopToken: Token, matchedStop: boolean, hadValue: boolean): ScanResult {
      const unclosedReported = !matchedStop && openStack.length > 0;
      if (unclosedReported) report("syn-expected-right-parenthesis", openStack[0]);
      return { stopToken, matchedStop, hadValue, unclosedReported };
    }

    for (;;) {
      const t = cur.peek();
      if (t.kind === "eof") return finish(t, false, lastWasOperand);
      if (openStack.length === 0 && stopMatches(t)) return finish(t, true, lastWasOperand);
      if (isUniversalStop(t)) return finish(t, false, lastWasOperand);

      if (isCallStart()) {
        if (lastWasOperand) return finish(t, false, true);
        parseCallInvocation();
        if (resyncPerformed) return { stopToken: cur.peek(), matchedStop: false, hadValue: true, unclosedReported: true };
        lastWasOperand = true;
        continue;
      }
      if (t.kind === "punct" && t.text === "(") {
        if (lastWasOperand) return finish(t, false, true);
        openStack.push(t);
        cur.next();
        lastWasOperand = false;
        continue;
      }
      if (t.kind === "punct" && t.text === ")") {
        if (openStack.length > 0) {
          openStack.pop();
          cur.next();
          lastWasOperand = true;
          continue;
        }
        return finish(t, false, lastWasOperand);
      }
      if (isOperandRefStart()) {
        if (lastWasOperand) return finish(t, false, true);
        consumeOperandChain();
        if (resyncPerformed) return { stopToken: cur.peek(), matchedStop: false, hadValue: true, unclosedReported: true };
        lastWasOperand = true;
        continue;
      }
      const litLen = literalRunLength(0);
      if (litLen > 0) {
        if (lastWasOperand) return finish(t, false, true);
        for (let i = 0; i < litLen; i++) cur.next();
        lastWasOperand = true;
        continue;
      }
      if (isOperatorToken(t)) {
        cur.next();
        lastWasOperand = false;
        continue;
      }
      // Unknown token -- tolerant fallback (mirrors the rest of this
      // project's own "don't understand it, don't guess, stay tolerant"
      // convention): treat it as an opaque operand-ish unit rather than
      // erroring, still subject to the same "two in a row" boundary check.
      if (lastWasOperand) return finish(t, false, true);
      cur.next();
      lastWasOperand = true;
    }
  }

  function isOperatorToken(t: Token): boolean {
    if (t.kind === "punct" && (t.text === "+" || t.text === "-" || t.text === "*" || t.text === "/" || t.text === "=" || t.text === "<" || t.text === ">")) {
      return true;
    }
    if (t.kind === "op" && (t.text === "<>" || t.text === "<=" || t.text === ">=")) return true;
    if (t.kind === "ident") {
      const up = t.text.toUpperCase();
      if (up === "AND" || up === "OR" || up === "XOR" || up === "MOD" || up === "NOT") return true;
    }
    return false;
  }

  /** Consumes a `#tag(.member)*[index]*^*` or `"External".member*[index]*^*`
   * chain -- everything `scanExpr` treats as one operand. An unclosed
   * index bracket reports `syn-expected-right-bracket` and resyncs (sets
   * `resyncPerformed`), same recovery contract as `parseCallInvocation`. */
  function consumeOperandChain(): void {
    const t0 = cur.next();
    if (t0.text === "#" && cur.peek().kind === "string") cur.next(); // #"Quoted Tag"
    // Members, indices, slice-access (`.%X0`/`.%B1`/`.%W2`), and trailing
    // dereferences can all repeat/interleave (`#arr[#i].member[#j]`,
    // `#tag.STATUS.%X0`), so this is ONE loop trying each shape in turn
    // until none match -- NOT separate single-pass loops, which would stop
    // after the first index/member run and leave the rest of the chain
    // (e.g. everything after `[#i]`) looking like a dangling second
    // operand to `scanExpr`.
    for (;;) {
      if (cur.isPunct(".") && cur.peek(1).kind === "ident") {
        cur.next();
        cur.next();
        continue;
      }
      if (cur.isPunct(".") && cur.peek(1).kind === "punct" && cur.peek(1).text === "%" && cur.peek(2).kind === "ident") {
        cur.next();
        cur.next();
        cur.next();
        continue;
      }
      if (cur.isPunct("[")) {
        const openTok = cur.next();
        const res = scanExpr((tk) => tk.kind === "punct" && tk.text === "]");
        if (resyncPerformed) return;
        if (res.matchedStop) {
          cur.next(); // consume ']'
          continue;
        }
        report("syn-expected-right-bracket", openTok);
        resyncPastStatement();
        resyncPerformed = true;
        return;
      }
      if (cur.isPunct("^")) {
        cur.next();
        continue;
      }
      break;
    }
  }

  function looksLikeNewArgStart(): boolean {
    if (cur.peek().kind === "ident" && cur.peek(1).kind === "op" && (cur.peek(1).text === ":=" || cur.peek(1).text === "=>")) return true;
    if (isOperandRefStart() || isCallStart()) return true;
    return literalRunLength(0) > 0;
  }

  /** Consumes one call invocation (`Ident(...)`, `#Instance(...)`,
   * `#Instance.Name(...)`, or `"External"(...)`) starting at the current
   * position -- validates its own arg-list parens/commas. Sets
   * `resyncPerformed` (and has already resynced) if its closing `)` was
   * never found; caller must check that flag before expecting anything
   * more to follow. */
  function parseCallInvocation(): void {
    if (cur.peek().kind === "string") {
      cur.next(); // "External"
    } else {
      cur.next(); // #Instance or Ident
      if (cur.isPunct(".")) {
        cur.next();
        cur.next(); // .Name
      }
    }
    const openParen = cur.peek();
    cur.tryPunct("(");
    if (!cur.isPunct(")")) {
      for (;;) {
        if (cur.peek().kind === "ident" && cur.peek(1).kind === "op" && (cur.peek(1).text === ":=" || cur.peek(1).text === "=>")) {
          cur.next();
          cur.next();
        }
        const res = scanExpr((tk) => tk.kind === "punct" && (tk.text === "," || tk.text === ")"));
        if (resyncPerformed) return;
        if (res.matchedStop && res.stopToken.text === ",") {
          cur.next();
          continue;
        }
        if (res.matchedStop && res.stopToken.text === ")") break;
        if (looksLikeNewArgStart()) {
          report("syn-expected-comma", res.stopToken);
          continue;
        }
        report("syn-expected-right-parenthesis", openParen);
        resyncPastStatement();
        resyncPerformed = true;
        return;
      }
    }
    if (cur.isPunct(")")) {
      cur.next();
    } else {
      report("syn-expected-right-parenthesis", openParen);
      resyncPastStatement();
      resyncPerformed = true;
    }
  }

  function expectSemicolon(): void {
    if (cur.isPunct(";")) {
      cur.next();
      return;
    }
    if (cur.atEnd()) return;
    report("syn-missing-semicolon", cur.peek());
  }

  // --- statement-level parsing -----------------------------------------

  const openStack: string[] = [];
  let loopDepth = 0;

  function looksLikeStatementStart(): boolean {
    if (cur.atEnd()) return false;
    const t = cur.peek();
    if (t.kind === "ident") {
      const up = t.text.toUpperCase();
      if (["IF", "CASE", "FOR", "WHILE", "REPEAT", "EXIT", "CONTINUE", "RETURN", "GOTO"].includes(up)) return true;
      if (t.text.startsWith("#")) return true;
      if (!SCL_RESERVED_KEYWORDS.has(up) && cur.peek(1).kind === "punct" && cur.peek(1).text === "(") return true;
      return false;
    }
    if (t.kind === "string" && t.text.startsWith('"')) {
      const t1 = cur.peek(1);
      if (t1.kind === "punct" && (t1.text === "." || t1.text === "(")) return true;
    }
    return false;
  }

  /** True at a bare single-token label (`0`, `-1`, `#MAN`, a plain
   * constant name, ...) immediately followed by `:` or `,` -- the CASE
   * label shape, which for a `#`-prefixed name is otherwise INDISTINGUISHABLE
   * from an ordinary assignment statement's LHS start (`looksLikeStatementStart`
   * also returns true for it) up until this specific next-token check: a
   * real assignment/call/index/member-chain always needs `:=`/`?=`/`(`/`.`/
   * `[` right after the base token, never a bare `:`/`,`. Confirmed needed
   * against distributed-process-control.scl's real, compiled `#MAN:`/`#AUTO:`-style symbolic
   * CASE labels -- without this, `#MAN:`'s own case-body statement list
   * swallows it (and everything up to the next accidental top-level `;`)
   * as one bogus, silently-resynced statement instead of ending the
   * PREVIOUS branch's body where it should. */
  function looksLikeCaseLabelBoundary(): boolean {
    const t = cur.peek();
    if (t.kind === "number") {
      const n1 = cur.peek(1);
      return n1.kind === "punct" && (n1.text === ":" || n1.text === "," || n1.text === ".");
    }
    if (t.kind === "ident" && !SCL_RESERVED_KEYWORDS.has(t.text.toUpperCase())) {
      const n1 = cur.peek(1);
      return n1.kind === "punct" && (n1.text === ":" || n1.text === ",");
    }
    return false;
  }

  function parseStatementList(closers: Set<string>, stopAtCaseLabel = false): void {
    for (;;) {
      if (cur.atEnd()) return;
      if (stopAtCaseLabel && looksLikeCaseLabelBoundary()) return;
      if (cur.isPunct(";")) {
        cur.next(); // empty/null statement -- legal on its own, e.g. real TIA source's `ELSE:\n  ;`
        continue;
      }
      const t = cur.peek();
      if (t.kind === "ident") {
        const up = t.text.toUpperCase();
        if (closers.has(up)) return;
        const unmatchedCode = UNMATCHED_CLOSER_CODE[up];
        if (unmatchedCode) {
          if (openStack.includes(up)) {
            report("syn-mismatched-block-terminator", t, { tokenText: t.text });
          } else {
            report(unmatchedCode, t);
          }
          cur.next();
          if (cur.isPunct(";")) cur.next();
          continue;
        }
      }
      if (looksLikeStatementStart()) {
        parseStatement();
        continue;
      }
      return;
    }
  }

  function parseStatement(): void {
    const t = cur.peek();
    const up = t.kind === "ident" ? t.text.toUpperCase() : "";
    if (up === "IF") return parseIfStatement();
    if (up === "CASE") return parseCaseStatement();
    if (up === "FOR") return parseForStatement();
    if (up === "WHILE") return parseWhileStatement();
    if (up === "REPEAT") return parseRepeatStatement();
    if (up === "EXIT") {
      cur.next();
      if (loopDepth === 0) report("syn-exit-outside-loop", t);
      expectSemicolon();
      return;
    }
    if (up === "CONTINUE") {
      cur.next();
      if (loopDepth === 0) report("syn-continue-outside-loop", t);
      expectSemicolon();
      return;
    }
    if (up === "RETURN") {
      cur.next();
      expectSemicolon();
      return;
    }
    if (up === "GOTO") {
      cur.next();
      if (cur.peek().kind === "ident") cur.next();
      expectSemicolon();
      return;
    }
    parseSimpleStatement();
  }

  function parseSimpleStatement(): void {
    resyncPerformed = false;
    if (isCallStart()) {
      parseCallInvocation();
      if (resyncPerformed) return;
      expectSemicolon();
      return;
    }
    if (!isOperandRefStart()) return; // defensive; caller already checked looksLikeStatementStart
    consumeOperandChain();
    if (resyncPerformed) return;
    if (cur.isOp(":=") || cur.isOp("?=")) {
      cur.next();
    } else if (cur.isPunct("=")) {
      report("syn-expected-assignment-operator", cur.peek());
      cur.next();
    } else {
      resyncPastStatement();
      return;
    }
    const res = scanExpr((tk) => tk.kind === "punct" && tk.text === ";");
    if (resyncPerformed) return;
    if (!res.hadValue) report("syn-expected-expression", res.stopToken);
    if (res.matchedStop) {
      cur.next();
      return;
    }
    if (res.stopToken.kind === "eof") return;
    if (res.unclosedReported) {
      // A real unclosed paren already got its own diagnostic; the
      // wreckage between here and the next safe boundary still needs
      // clearing so the NEXT statement can be parsed cleanly.
      resyncPastStatement();
      return;
    }
    if (!res.hadValue) return; // already reported "expected-expression" above; nothing more to add
    // Stopped on what looks like a brand-new statement/keyword with
    // nothing actually unbalanced -- a plain missing terminator. Don't
    // consume anything: `res.stopToken` is already a valid place for the
    // caller's own statement-list loop to resume from.
    report("syn-missing-semicolon", res.stopToken);
  }

  function parseIfStatement(): void {
    cur.next(); // IF
    const cond = scanExpr((tk) => tk.kind === "ident" && tk.text.toUpperCase() === "THEN");
    if (cond.matchedStop) cur.next();
    else report("syn-if-missing-then", cond.stopToken);
    openStack.push("END_IF");
    parseStatementList(new Set(["ELSIF", "ELSE", "END_IF"]));
    while (cur.isIdent("ELSIF")) {
      cur.next();
      const c2 = scanExpr((tk) => tk.kind === "ident" && tk.text.toUpperCase() === "THEN");
      if (c2.matchedStop) cur.next();
      else report("syn-elsif-missing-then", c2.stopToken);
      parseStatementList(new Set(["ELSIF", "ELSE", "END_IF"]));
    }
    if (cur.isIdent("ELSE")) {
      cur.next();
      cur.tryPunct(":"); // TIA accepts (and distributed-process-control.scl's real, compiled source uses) an optional colon after ELSE
      parseStatementList(new Set(["END_IF"]));
    }
    openStack.pop();
    if (cur.isIdent("END_IF")) {
      cur.next();
      expectSemicolon();
    } else if (!cur.atEnd()) {
      report("syn-expected-end-if", cur.peek(), { tokenText: cur.peek().text });
    }
  }

  function looksLikeCaseLabelItem(): boolean {
    const t = cur.peek();
    return t.kind === "number" || (t.kind === "ident" && !SCL_RESERVED_KEYWORDS.has(t.text.toUpperCase()));
  }

  function parseOneCaseLabelItem(): void {
    cur.next(); // label value
    if (cur.isPunct(".")) {
      const firstDot = cur.peek();
      let dotCount = 0;
      while (cur.isPunct(".")) {
        cur.next();
        dotCount++;
      }
      if (dotCount !== 2) report("syn-invalid-case-range", firstDot);
      if (cur.peek().kind === "number" || cur.peek().kind === "ident") cur.next();
    }
  }

  function parseCaseStatement(): void {
    cur.next(); // CASE
    const testExpr = scanExpr((tk) => tk.kind === "ident" && tk.text.toUpperCase() === "OF");
    if (testExpr.matchedStop) cur.next();
    else report("syn-case-missing-of", testExpr.stopToken);
    openStack.push("END_CASE");
    for (;;) {
      if (cur.isIdent("ELSE") || cur.isIdent("END_CASE") || cur.atEnd()) break;
      if (!looksLikeCaseLabelItem()) break;
      for (;;) {
        parseOneCaseLabelItem();
        if (cur.isPunct(",")) {
          cur.next();
          continue;
        }
        break;
      }
      if (cur.isPunct(":")) cur.next();
      else report("syn-case-label-missing-colon", cur.peek());
      parseStatementList(new Set(["ELSE", "END_CASE"]), true);
    }
    if (cur.isIdent("ELSE")) {
      cur.next();
      cur.tryPunct(":"); // TIA accepts (and distributed-process-control.scl's real, compiled source uses) an optional colon after ELSE
      parseStatementList(new Set(["END_CASE"]));
    }
    openStack.pop();
    if (cur.isIdent("END_CASE")) {
      cur.next();
      expectSemicolon();
    } else if (!cur.atEnd()) {
      report("syn-expected-end-case", cur.peek());
    }
  }

  function parseForStatement(): void {
    cur.next(); // FOR
    if (isOperandRefStart()) consumeOperandChain();
    if (cur.isOp(":=")) {
      cur.next();
    } else {
      report("syn-for-missing-assignment", cur.peek());
    }
    const start = scanExpr((tk) => tk.kind === "ident" && tk.text.toUpperCase() === "TO");
    if (start.matchedStop) cur.next();
    else report("syn-for-missing-to", start.stopToken);
    const end = scanExpr((tk) => tk.kind === "ident" && (tk.text.toUpperCase() === "DO" || tk.text.toUpperCase() === "BY"));
    const isBy = end.matchedStop && cur.peek().text.toUpperCase() === "BY";
    if (end.matchedStop) cur.next();
    else report("syn-for-missing-do", end.stopToken);
    if (isBy) {
      const byExpr = scanExpr((tk) => tk.kind === "ident" && tk.text.toUpperCase() === "DO");
      if (byExpr.matchedStop) cur.next();
      else report("syn-for-missing-do", byExpr.stopToken);
    }
    openStack.push("END_FOR");
    loopDepth++;
    parseStatementList(new Set(["END_FOR"]));
    loopDepth--;
    openStack.pop();
    if (cur.isIdent("END_FOR")) {
      cur.next();
      expectSemicolon();
    } else if (!cur.atEnd()) {
      report("syn-expected-end-for", cur.peek(), { tokenText: cur.peek().text });
    }
  }

  function parseWhileStatement(): void {
    cur.next(); // WHILE
    const cond = scanExpr((tk) => tk.kind === "ident" && tk.text.toUpperCase() === "DO");
    if (cond.matchedStop) cur.next();
    else report("syn-while-missing-do", cond.stopToken);
    openStack.push("END_WHILE");
    loopDepth++;
    parseStatementList(new Set(["END_WHILE"]));
    loopDepth--;
    openStack.pop();
    if (cur.isIdent("END_WHILE")) {
      cur.next();
      expectSemicolon();
    } else if (!cur.atEnd()) {
      report("syn-expected-end-while", cur.peek(), { tokenText: cur.peek().text });
    }
  }

  function parseRepeatStatement(): void {
    cur.next(); // REPEAT
    openStack.push("END_REPEAT");
    loopDepth++;
    parseStatementList(new Set(["UNTIL"]));
    loopDepth--;
    if (cur.isIdent("UNTIL")) {
      cur.next();
      scanExpr((tk) => tk.kind === "ident" && tk.text.toUpperCase() === "END_REPEAT");
    } else {
      report("syn-repeat-missing-until", cur.peek());
    }
    openStack.pop();
    if (cur.isIdent("END_REPEAT")) {
      cur.next();
      expectSemicolon();
    } else if (!cur.atEnd()) {
      report("syn-expected-end-repeat", cur.peek());
    }
  }

  // --- VAR section + top-level block walk ------------------------------

  function skipDefaultValueTokens(): void {
    let depth = 0;
    while (!cur.atEnd()) {
      const t = cur.peek();
      if (t.kind === "punct" && (t.text === "(" || t.text === "[")) {
        depth++;
        cur.next();
        continue;
      }
      if (t.kind === "punct" && (t.text === ")" || t.text === "]")) {
        depth--;
        cur.next();
        continue;
      }
      if (t.kind === "punct" && t.text === "{") {
        cur.skipBraceBlock();
        continue;
      }
      if (depth <= 0 && t.kind === "punct" && t.text === ";") return;
      if (depth <= 0 && t.kind === "ident") {
        const up = t.text.toUpperCase();
        if (up === "END_VAR" || up === "BEGIN" || up === "NETWORK" || VAR_KEYWORDS.includes(up) || BLOCK_KEYWORDS.includes(up)) return;
      }
      cur.next();
    }
  }

  function parseVarMember(): void {
    if (cur.isPunct("{")) cur.skipBraceBlock();
    cur.next(); // member name
    if (cur.isPunct("{")) cur.skipBraceBlock();
    if (cur.isPunct(":")) {
      cur.next();
    } else {
      report("syn-declaration-missing-colon", cur.peek());
    }
    parseTypeRefFromCursor(cur);
    if (cur.isOp(":=")) {
      cur.next();
      skipDefaultValueTokens();
    }
    if (cur.isPunct(";")) {
      cur.next();
    } else if (!cur.atEnd()) {
      report("syn-declaration-missing-semicolon", cur.peek());
    }
  }

  function checkVarSection(): void {
    for (;;) {
      if (cur.atEnd() || cur.isIdent("END_VAR")) return;
      if (cur.isIdent("BEGIN") || cur.isIdent("NETWORK") || cur.isPunct("{") || VAR_KEYWORDS.some((k) => cur.isIdent(k)) || BLOCK_KEYWORDS.some((k) => cur.isIdent(k))) {
        report("syn-expected-end-var", cur.peek());
        return;
      }
      parseVarMember();
    }
  }

  function parseBlockBody(endKeyword: string): void {
    let sawBeginOrNetwork = false;
    while (!cur.isIdent(endKeyword) && !cur.atEnd()) {
      const isVarConstant = cur.isIdent("VAR") && cur.peek(1).kind === "ident" && cur.peek(1).text.toUpperCase() === "CONSTANT";
      const varKw = isVarConstant ? "VAR_CONSTANT" : VAR_KEYWORDS.find((kw) => cur.isIdent(kw));
      if (varKw) {
        cur.next();
        if (isVarConstant) cur.next();
        checkVarSection();
        cur.tryIdent("END_VAR");
        continue;
      }
      if (cur.isPunct("{")) {
        cur.skipBraceBlock();
        if (cur.isIdent("NETWORK")) {
          sawBeginOrNetwork = true;
          skipNetwork();
        }
        continue;
      }
      if (cur.isIdent("NETWORK")) {
        sawBeginOrNetwork = true;
        skipNetwork();
        continue;
      }
      if (cur.isIdent("BEGIN")) {
        cur.next();
        sawBeginOrNetwork = true;
        openStack.length = 0;
        loopDepth = 0;
        parseStatementList(new Set());
        continue;
      }
      if (!sawBeginOrNetwork && looksLikeStatementStart()) {
        report("syn-expected-begin", cur.peek());
        sawBeginOrNetwork = true;
        openStack.length = 0;
        loopDepth = 0;
        parseStatementList(new Set());
        continue;
      }
      cur.next(); // defensive skip: pragmas, VERSION/TITLE/AUTHOR/etc., stray recovery leftovers
    }
    cur.tryIdent(endKeyword);
  }

  /** LAD/FBD NETWORK/RUNG bodies aren't this checker's concern (no SCL
   * statement grammar to validate there) -- just skip past the block
   * wholesale so `parseBlockBody`'s own defensive skip doesn't have to do
   * it one token at a time. */
  function skipNetwork(): void {
    cur.tryIdent("NETWORK");
    while (!cur.isIdent("END_NETWORK") && !cur.atEnd()) cur.next();
    cur.tryIdent("END_NETWORK");
  }

  function skipTypeDeclaration(): void {
    cur.tryIdent("TYPE");
    while (!cur.isIdent("END_TYPE") && !cur.atEnd()) {
      if (cur.isPunct("{")) {
        cur.skipBraceBlock();
        continue;
      }
      cur.next();
    }
    cur.tryIdent("END_TYPE");
  }

  if (cur.isPunct("{")) cur.skipBraceBlock(); // file-level pragma
  while (!cur.atEnd()) {
    if (cur.isPunct("{")) {
      cur.skipBraceBlock();
      continue;
    }
    if (cur.isIdent("TYPE")) {
      skipTypeDeclaration();
      continue;
    }
    let blockKeyword: string | null = null;
    for (const kw of BLOCK_KEYWORDS) {
      if (cur.isIdent(kw)) {
        blockKeyword = kw;
        cur.next();
        break;
      }
    }
    if (blockKeyword) {
      if (cur.peek().kind === "string" || cur.peek().kind === "ident") cur.next(); // block name
      if (cur.isPunct("{")) cur.skipBraceBlock();
      parseBlockBody(`END_${blockKeyword}`);
      continue;
    }
    if (cur.atEnd()) break;
    cur.next(); // defensive skip between declarations
  }

  return diagnostics;
}
