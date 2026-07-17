// Hover-over-instruction/type/variable support, backed by the same
// DocumentIndex the semantic tokens provider uses -- see analysis/documentIndex.ts.
import * as vscode from "vscode";
import { BlockIndex } from "../analysis/blockIndex";
import { buildDocumentIndex } from "../analysis/documentIndex";
import { getMlcLocale } from "../config";
import { RuleSet } from "../rules/types";

export class S7dclHoverProvider implements vscode.HoverProvider {
  constructor(private readonly ruleSet: RuleSet, private readonly blockIndex: BlockIndex) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    const index = buildDocumentIndex(document.getText(), this.ruleSet, this.blockIndex, document.uri.fsPath, getMlcLocale(document.uri));
    const line = position.line + 1;
    const col = position.character + 1;
    for (const span of index.spans) {
      if (span.line !== line || col < span.startCol || col > span.startCol + span.length) continue;
      if (!span.hoverMarkdown) return undefined;
      const range = new vscode.Range(span.line - 1, span.startCol - 1, span.line - 1, span.startCol - 1 + span.length);
      return new vscode.Hover(new vscode.MarkdownString(span.hoverMarkdown), range);
    }
    return undefined;
  }
}
