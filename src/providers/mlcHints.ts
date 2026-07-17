// Always-visible inline annotation for S7_MLC/S7_NetworkTitle/... pragma
// values -- unlike hover.ts's hoverMarkdown (mouse-over only), this renders
// the resolved `.s7res` comment text directly after the pragma on the SAME
// line, via a TextEditorDecorationType, so it's readable without hovering
// (the user's own requirement: "man skal kunne se ... uten at man må hovre
// over"). Built on the same DocumentIndex spans (`inlineHint`) hover and
// semantic tokens already share.
import * as vscode from "vscode";
import { BlockIndex } from "../analysis/blockIndex";
import { buildDocumentIndex } from "../analysis/documentIndex";
import { getMlcLocale } from "../config";
import { RuleSet } from "../rules/types";

const DECORATION_TYPE = vscode.window.createTextEditorDecorationType({
  after: {
    color: new vscode.ThemeColor("editorCodeLens.foreground"),
    fontStyle: "italic",
    margin: "0 0 0 1.5em",
  },
});

export class MlcHintsController {
  constructor(private readonly ruleSet: RuleSet, private readonly blockIndex: BlockIndex) {}

  /** Recomputes and applies decorations for one visible editor. No-ops on
   * anything that isn't an `.s7dcl`/`.udt` document (the only file kinds
   * `buildDocumentIndex` understands). */
  refresh(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;
    const fsPath = editor.document.uri.fsPath;
    if (!/\.(s7dcl|udt)$/i.test(fsPath)) return;

    const mlcLocale = getMlcLocale(editor.document.uri);
    const index = buildDocumentIndex(editor.document.getText(), this.ruleSet, this.blockIndex, fsPath, mlcLocale);

    const options: vscode.DecorationOptions[] = [];
    for (const span of index.spans) {
      if (!span.inlineHint) continue;
      const lineIdx = span.line - 1;
      if (lineIdx < 0 || lineIdx >= editor.document.lineCount) continue;
      const endCol = span.startCol - 1 + span.length;
      const pos = new vscode.Position(lineIdx, endCol);
      options.push({ range: new vscode.Range(pos, pos), renderOptions: { after: { contentText: `// ${span.inlineHint}` } } });
    }
    editor.setDecorations(DECORATION_TYPE, options);
  }

  refreshAllVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) this.refresh(editor);
  }
}
