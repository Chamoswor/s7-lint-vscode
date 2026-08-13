// Ctrl+click / go-to-definition support: jumps a `#tag` reference to its
// VAR declaration (same document), or an instance/UDT type name to the
// block file that declares it (workspace-wide, via BlockIndex). Backed by
// the same DocumentIndex the semantic tokens/hover providers use.
import * as vscode from "vscode";
import { BlockIndex } from "../analysis/blockIndex";
import { buildDocumentIndex } from "../analysis/documentIndex";
import { TypeCacheResult } from "../cache/typeCache";
import { getMlcLocale } from "../config";
import { RuleSet } from "../rules/types";

export class S7dclDefinitionProvider implements vscode.DefinitionProvider {
  constructor(
    private readonly ruleSet: RuleSet,
    private readonly blockIndex: BlockIndex,
    private readonly getTypeCache: () => TypeCacheResult
  ) {}

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Definition> {
    const index = buildDocumentIndex(
      document.getText(),
      this.ruleSet,
      this.blockIndex,
      document.uri.fsPath,
      getMlcLocale(document.uri),
      this.getTypeCache()
    );
    const line = position.line + 1;
    const col = position.character + 1;
    for (const span of index.spans) {
      if (span.line !== line || !span.definition) continue;
      if (col < span.startCol || col > span.startCol + span.length) continue;
      const targetUri = span.definition.file ? vscode.Uri.file(span.definition.file) : document.uri;
      const targetLine = Math.max(0, span.definition.line - 1);
      const targetCol = Math.max(0, (span.definition.col ?? 1) - 1);
      return new vscode.Location(targetUri, new vscode.Position(targetLine, targetCol));
    }
    return undefined;
  }
}
