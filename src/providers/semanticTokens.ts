// Bridges DocumentIndex (analysis/documentIndex.ts) to VS Code's semantic
// tokens API. Mostly standard token types/modifiers, so every color theme
// (not just the bundled one in themes/) already has a sensible default
// mapping for "type", "function", "variable", etc. Four custom literal
// types (charLiteral/timeLiteral/dateLiteral/pointerLiteral) and two custom
// number modifiers (radix/float) are added because no standard LSP token
// kind distinguishes e.g. a `T#10S` duration from a plain `4`; a fifth
// custom type, `callable`, marks every PROJECT-DEFINED thing that can be
// called or that owns instance state -- an FB instance tag, a
// TON/R_TRIG/CTU-family instruction instance, and a workspace FB/FC call
// target (`"_IPC_SetRunning"(...)` / `Helper(...)`) alike -- separating all
// of them from ordinary data `variable`s on one side and from the Siemens
// instruction catalog (`function.defaultLibrary`) on the other. A sixth,
// `dataBlock`, does the same for a DATA_BLOCK (`"DB_IPC_Comms"`), which is
// neither: it's global storage, as distinct a kind of thing in TIA as a
// variable or a function block.
//
// `booleanLiteral` and `typeKeyword` exist because a semantic token OVERRIDES
// whatever TextMate scope the grammar gave the same span -- so emitting the
// blanket `keyword` type for `TRUE`/`FALSE`, `STRUCT`/`END_STRUCT`,
// `ARRAY`/`OF` and `REF_TO` flattened them all onto IF/END_IF/RETURN's colour,
// discarding the distinction syntaxes/s7dcl.tmLanguage.json already draws
// (`constant.language.boolean` / `storage.type`). These two types carry that
// same split up into the semantic layer; `NOT` uses the existing `operator`
// type, matching the grammar's `keyword.operator.logical`. See package.json's
// `semanticTokenTypes`/`semanticTokenModifiers`/`semanticTokenScopes`
// contributions and themes/tia-dark-color-theme.json's `semanticTokenColors`.
import * as vscode from "vscode";
import { BlockIndex } from "../analysis/blockIndex";
import { buildDocumentIndex } from "../analysis/documentIndex";
import { RuleSet } from "../rules/types";

export const SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "type",
  "function",
  "variable",
  "parameter",
  "property",
  "label",
  "keyword",
  "number",
  "operator",
  "string",
  "charLiteral",
  "timeLiteral",
  "dateLiteral",
  "pointerLiteral",
  "booleanLiteral",
  "callable",
  "dataBlock",
  "typeKeyword",
] as const;
export const SEMANTIC_TOKEN_MODIFIERS = ["declaration", "readonly", "defaultLibrary", "radix", "float"] as const;

export const semanticTokensLegend = new vscode.SemanticTokensLegend([...SEMANTIC_TOKEN_TYPES], [...SEMANTIC_TOKEN_MODIFIERS]);

const VALID_TYPES = new Set<string>(SEMANTIC_TOKEN_TYPES);
const VALID_MODIFIERS = new Set<string>(SEMANTIC_TOKEN_MODIFIERS);

export class S7dclSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  constructor(private readonly ruleSet: RuleSet, private readonly blockIndex: BlockIndex) {}

  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.ProviderResult<vscode.SemanticTokens> {
    const index = buildDocumentIndex(document.getText(), this.ruleSet, this.blockIndex);
    const builder = new vscode.SemanticTokensBuilder(semanticTokensLegend);
    for (const span of index.spans) {
      if (!VALID_TYPES.has(span.tokenType)) continue;
      const modifiers = span.tokenModifiers.filter((m) => VALID_MODIFIERS.has(m));
      const range = new vscode.Range(span.line - 1, span.startCol - 1, span.line - 1, span.startCol - 1 + span.length);
      builder.push(range, span.tokenType, modifiers);
    }
    return builder.build();
  }
}
