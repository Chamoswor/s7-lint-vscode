// Parses the .udt / TYPE-block text grammar confirmed in
// resources/type-registry/udt-dependency-cache.md's "Nested-UDT syntax"
// section: `TYPE "Name" VERSION : x.y STRUCT ... END_STRUCT; END_TYPE`.
// One file may contain multiple TYPE...END_TYPE blocks. Shared by .udt
// files and any .s7dcl file whose top-level keyword is TYPE (see that
// same doc section) -- callers pass in whichever text.
import { Lexer, TokenCursor } from "./lexer";
import { MemberRef, parseMemberFromCursor } from "./typeRef";

export interface ParsedUdtDecl {
  name: string;
  members: MemberRef[];
  line: number;
}

/** Parses every `TYPE "Name" ... END_TYPE` block found in `text`. Tolerant
 * of surrounding content (e.g. a .s7dcl file that mixes TYPE blocks with
 * other declarations) -- unrecognized tokens outside a TYPE block are
 * skipped rather than raising a parse error. */
export function parseUdtText(text: string): ParsedUdtDecl[] {
  const tokens = new Lexer(text).tokenize();
  const cur = new TokenCursor(tokens);
  const results: ParsedUdtDecl[] = [];

  while (!cur.atEnd()) {
    if (cur.isIdent("TYPE")) {
      const typeTok = cur.next();
      const nameTok = cur.next();
      const name = nameTok.kind === "string" ? (nameTok.value ?? nameTok.text) : nameTok.text;

      if (cur.tryIdent("VERSION")) {
        cur.tryPunct(":");
        while (!cur.isIdent("STRUCT") && !cur.atEnd()) cur.next();
      }
      cur.tryIdent("STRUCT");
      const members: MemberRef[] = [];
      while (!cur.isIdent("END_STRUCT") && !cur.atEnd()) {
        members.push(parseMemberFromCursor(cur));
      }
      cur.tryIdent("END_STRUCT");
      cur.tryPunct(";");
      cur.tryIdent("END_TYPE");

      results.push({ name, members, line: typeTok.line });
      continue;
    }
    cur.next();
  }

  return results;
}
