// Bridges DocumentIndex (analysis/documentIndex.ts) to VS Code's semantic
// tokens API. Mostly standard token types/modifiers, so every color theme
// (not just the bundled one in themes/) already has a sensible default
// mapping for "type", "function", "variable", etc. Four custom literal
// types (charLiteral/timeLiteral/dateLiteral/pointerLiteral) and two custom
// number modifiers (radix/float) are added because no standard LSP token
// kind distinguishes e.g. a `T#10S` duration from a plain `4` -- see
// package.json's `semanticTokenTypes`/`semanticTokenModifiers`
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
  "charLiteral",
  "timeLiteral",
  "dateLiteral",
  "pointerLiteral",
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
