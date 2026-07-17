// Reverse of documentIndex.ts's MLC-pragma resolution: ctrl+click on a
// `.s7res` entry's `- id: <ID>` value jumps back to every `.s7dcl`/`.udt`
// pragma (S7_MLC/S7_NetworkTitle/S7_NetworkComment/S7_BlockTitle/
// S7_BlockComment) in its sibling source file that references that ID.
// Self-contained (no RuleSet/BlockIndex needed) since it only has to match
// a literal ID string, not resolve types.
import * as fs from "fs";
import * as vscode from "vscode";
import { findMlcPragmaUsages, idOnLine, siblingSourcePath } from "../parser/s7resParser";

export class S7ResDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Definition> {
    const found = idOnLine(document.lineAt(position.line).text);
    if (!found || position.character < found.start || position.character > found.end) return undefined;

    const sourcePath = siblingSourcePath(document.uri.fsPath);
    if (!sourcePath) return undefined;
    let text: string;
    try {
      text = fs.readFileSync(sourcePath, "utf8");
    } catch {
      return undefined;
    }

    const locations = findMlcPragmaUsages(text, found.id).map(
      (tok) => new vscode.Location(vscode.Uri.file(sourcePath), new vscode.Position(tok.line - 1, tok.col - 1))
    );
    return locations.length > 0 ? locations : undefined;
  }
}
