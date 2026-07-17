// `{ Key := 'Value'; Key2 := "Value2" }` pragma blocks -- appear before a
// block declaration, a VAR member, a NETWORK, or an instruction call in
// .s7dcl text (S7_Templates, S7_GenerateENO, S7_Language, S7_NetworkTitle,
// etc.). Parsed into a flat string map; unrecognized/non-string values are
// captured as their raw token text on a best-effort basis.
import { TokenCursor } from "./lexer";

export type Pragma = Record<string, string>;

export function parsePragmaBlock(cur: TokenCursor): Pragma | null {
  if (!cur.isPunct("{")) return null;
  cur.next(); // '{'
  const result: Pragma = {};
  while (!cur.isPunct("}") && !cur.atEnd()) {
    if (cur.peek().kind !== "ident") {
      cur.next();
      continue;
    }
    const key = cur.next().text;
    if (cur.isOp(":=")) {
      cur.next();
      const valueTok = cur.peek();
      const value = valueTok.kind === "string" ? (valueTok.value ?? "") : valueTok.text;
      cur.next();
      result[key] = value;
    }
    cur.tryPunct(";");
  }
  cur.tryPunct("}");
  return result;
}
