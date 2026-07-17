// Reverse of providers/rename.ts's `mlc:` case: F2 / right-click rename on
// a `.s7res` entry's `- id: <ID>` value renames it here AND rewrites every
// `S7_MLC`-family pragma reference to it in the sibling `.s7dcl`/`.udt`.
// Self-contained, same convention as providers/s7resDefinition.ts.
import * as fs from "fs";
import * as vscode from "vscode";
import { findMlcPragmaUsages, idOnLine, siblingSourcePath } from "../parser/s7resParser";

export class S7ResRenameProvider implements vscode.RenameProvider {
  prepareRename(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Range> {
    const found = idOnLine(document.lineAt(position.line).text);
    if (!found || position.character < found.start || position.character > found.end) {
      throw new Error("Place the cursor on a `- id: <ID>` value to rename it.");
    }
    return new vscode.Range(position.line, found.start, position.line, found.end);
  }

  provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string): vscode.ProviderResult<vscode.WorkspaceEdit> {
    const found = idOnLine(document.lineAt(position.line).text);
    if (!found || position.character < found.start || position.character > found.end) return undefined;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(position.line, found.start, position.line, found.end), newName);

    const sourcePath = siblingSourcePath(document.uri.fsPath);
    if (!sourcePath) return edit;
    let text: string;
    try {
      text = fs.readFileSync(sourcePath, "utf8");
    } catch {
      return edit;
    }
    const sourceUri = vscode.Uri.file(sourcePath);
    for (const tok of findMlcPragmaUsages(text, found.id)) {
      // `tok.col` (1-based) points at the token's OPENING quote; the 0-based
      // inner (post-quote) offset is therefore the same numeric value --
      // replace only the inner ID, keeping the surrounding quotes.
      const innerStart = tok.col;
      edit.replace(sourceUri, new vscode.Range(tok.line - 1, innerStart, tok.line - 1, innerStart + found.id.length), newName);
    }
    return edit;
  }
}
