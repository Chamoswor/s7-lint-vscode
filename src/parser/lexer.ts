// Small hand-rolled lexer shared by the .udt/TYPE-block parser and the
// .s7dcl parser -- both are simple, keyword-driven text DSLs (not full
// SCL), so a general-purpose tokenizer is enough; no grammar/parser
// generator dependency needed.

export type TokenKind = "ident" | "string" | "number" | "punct" | "op" | "eof";

/** Recorded when a string literal or block comment runs off the end of the
 * file without ever finding its closing delimiter -- see linter/
 * synStructureChecks.ts's SYN-LEX-001/002 handling. Purely additive: the
 * lexer's own token-producing behavior is unchanged either way (advancing
 * past EOF was already a harmless no-op), this just gives a caller
 * something to check afterward. */
export interface LexerError {
  kind: "unterminated-string" | "unterminated-comment";
  line: number;
  col: number;
}

export interface Token {
  kind: TokenKind;
  text: string;
  /** Decoded value for string tokens (quotes stripped). */
  value?: string;
  line: number; // 1-based
  col: number; // 1-based
  offset: number;
}

// "?=" is SCL's assignment-ATTEMPT operator (references.yaml's own
// `assignmentAttempt` section -- VARIANT/DB_ANY-to-reference runtime-
// checked assignment). Without it here, "?" (not otherwise a legal
// character anywhere in this grammar) falls into the "unknown character,
// skip" fallback below and "=" tokenizes alone -- the same "silently
// vanished operator" story `-`/`/`/`<`/`>` used to have.
const MULTI_CHAR_OPS = [":=", "?=", "=>", "<>", "<=", ">="];
// "^" is References' dereference operator (`#myRef^`, references.yaml's
// `dereferencing.syntax`); "*" appears in `ARRAY[*] of <type>` (dynamic
// bounds, composition-rules.yaml's `array.dynamicBounds`) -- without them
// here, both silently vanished into the "unknown character, skip" fallback
// below instead of being real tokens a parser could see or a lint rule
// could check (an `ARRAY[*]` was indistinguishable from a malformed empty
// `ARRAY[]` once "*" disappeared).
// "%" prefixes an absolute/direct address (`%I0.0`, `%MW10`, base-types.yaml's
// `addressExamples`) -- same "silently vanished" story as ^ and *. A
// standalone "+" (not immediately adjacent to a digit -- that case is
// folded into a signed number token above, mirroring "-") falls here too,
// so e.g. an illegal array-index EXPRESSION like `#i + 1`
// (composition-rules.yaml's array.index.actualParameterRule) is visible
// as a real token instead of silently vanishing.
// "-"/"/"/"<"/">" were the SAME "silently vanished" bug as "+" above, just
// never actually fixed for these four despite the comment's own claim of
// mirroring "-" -- confirmed by direct lexer output: `#a - #b`, `#a / #b`,
// `#a < #b`, `#a > #b` each used to tokenize as just `#a`, `#b` with NO
// operator token in between at all (silently swallowed by the fallback
// "unknown character, skip" branch), while `#a + #b` and the two-char forms
// (`<=`, `>=`, `<>`, already in MULTI_CHAR_OPS) worked fine. A bare "-"
// immediately before a digit is still caught by the signed-number rule
// ABOVE this PUNCT check (checked first in `tokenize()`'s if/else chain),
// so adding "-" here only affects the subtraction-operator case that rule
// doesn't already claim.
const PUNCT = "{}[]()：:;,.=^*%+-<>/";

export class Lexer {
  private pos = 0;
  private line = 1;
  private col = 1;
  readonly errors: LexerError[] = [];
  constructor(private readonly text: string) {}

  private peekChar(offset = 0): string {
    return this.text[this.pos + offset] ?? "";
  }

  private advance(): string {
    const c = this.text[this.pos++];
    if (c === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return c;
  }

  private skipTrivia(): void {
    for (;;) {
      const c = this.peekChar();
      if (c === "" ) return;
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        this.advance();
        continue;
      }
      if (c === "/" && this.peekChar(1) === "/") {
        while (this.peekChar() !== "\n" && this.peekChar() !== "") this.advance();
        continue;
      }
      if (c === "/" && this.peekChar(1) === "*") {
        const startLine = this.line;
        const startCol = this.col;
        this.advance();
        this.advance();
        while (!(this.peekChar() === "*" && this.peekChar(1) === "/") && this.peekChar() !== "") this.advance();
        if (this.peekChar() === "") {
          this.errors.push({ kind: "unterminated-comment", line: startLine, col: startCol });
        } else {
          this.advance();
          this.advance();
        }
        continue;
      }
      if (c === "(" && this.peekChar(1) === "*") {
        const startLine = this.line;
        const startCol = this.col;
        this.advance();
        this.advance();
        while (!(this.peekChar() === "*" && this.peekChar(1) === ")") && this.peekChar() !== "") this.advance();
        if (this.peekChar() === "") {
          this.errors.push({ kind: "unterminated-comment", line: startLine, col: startCol });
        } else {
          this.advance();
          this.advance();
        }
        continue;
      }
      return;
    }
  }

  /** Tokenizes the whole input up front -- these files are small (a few KB). */
  tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      this.skipTrivia();
      const startLine = this.line;
      const startCol = this.col;
      const startOffset = this.pos;
      const c = this.peekChar();
      if (c === "") {
        tokens.push({ kind: "eof", text: "", line: startLine, col: startCol, offset: startOffset });
        break;
      }

      if (c === '"' || c === "'") {
        const quote = c;
        this.advance();
        let value = "";
        while (this.peekChar() !== quote && this.peekChar() !== "") {
          value += this.advance();
        }
        if (this.peekChar() === "") {
          this.errors.push({ kind: "unterminated-string", line: startLine, col: startCol });
        } else {
          this.advance(); // closing quote
        }
        tokens.push({
          kind: "string",
          text: this.text.slice(startOffset, this.pos),
          value,
          line: startLine,
          col: startCol,
          offset: startOffset,
        });
        continue;
      }

      const twoChar = c + this.peekChar(1);
      if (MULTI_CHAR_OPS.includes(twoChar)) {
        this.advance();
        this.advance();
        tokens.push({ kind: "op", text: twoChar, line: startLine, col: startCol, offset: startOffset });
        continue;
      }

      if (/[A-Za-z_#]/.test(c)) {
        // Consume the leading char first (it may be `#`, which isn't part
        // of the continuation class) -- otherwise a bare `#` token would
        // never advance the cursor and the tokenizer would hang.
        let text = this.advance();
        while (/[A-Za-z0-9_]/.test(this.peekChar())) text += this.advance();
        tokens.push({ kind: "ident", text, line: startLine, col: startCol, offset: startOffset });
        continue;
      }

      if (/[0-9]/.test(c) || ((c === "-" || c === "+") && /[0-9]/.test(this.peekChar(1)))) {
        let text = this.advance();
        while (/[0-9]/.test(this.peekChar())) text += this.advance();
        tokens.push({ kind: "number", text, line: startLine, col: startCol, offset: startOffset });
        continue;
      }

      if (PUNCT.includes(c)) {
        this.advance();
        tokens.push({ kind: "punct", text: c, line: startLine, col: startCol, offset: startOffset });
        continue;
      }

      // Unknown character -- skip it rather than throwing, so a lint pass
      // degrades gracefully on syntax this parser doesn't yet model.
      this.advance();
    }
    return tokens;
  }
}

/** Small cursor helper for hand-written recursive-descent parsing over a token array. */
export class TokenCursor {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
  }

  next(): Token {
    const t = this.tokens[this.i];
    if (this.i < this.tokens.length - 1) this.i++;
    return t;
  }

  atEnd(): boolean {
    return this.peek().kind === "eof";
  }

  isIdent(text?: string): boolean {
    const t = this.peek();
    return t.kind === "ident" && (text === undefined || t.text.toUpperCase() === text.toUpperCase());
  }

  isPunct(text: string): boolean {
    const t = this.peek();
    return t.kind === "punct" && t.text === text;
  }

  isOp(text: string): boolean {
    const t = this.peek();
    return t.kind === "op" && t.text === text;
  }

  /** Consumes and returns the token if it matches an identifier (case-insensitive keyword match); else returns null without advancing. */
  tryIdent(text: string): Token | null {
    if (this.isIdent(text)) return this.next();
    return null;
  }

  tryPunct(text: string): Token | null {
    if (this.isPunct(text)) return this.next();
    return null;
  }

  /** Skips a balanced `{ ... }` block (pragma) starting at the current `{` token and returns its raw source span, or null if not positioned at `{`. */
  skipBraceBlock(): string | null {
    if (!this.isPunct("{")) return null;
    const startOffset = this.peek().offset;
    let depth = 0;
    let lastEnd = startOffset;
    do {
      const t = this.next();
      lastEnd = t.offset + t.text.length;
      if (t.kind === "punct" && t.text === "{") depth++;
      if (t.kind === "punct" && t.text === "}") depth--;
    } while (depth > 0 && !this.atEnd());
    return `[${startOffset}-${lastEnd}]`;
  }
}
