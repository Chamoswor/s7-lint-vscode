import * as vscode from "vscode";

export const SAFETY_CALL_METADATA_CODE = "safety-call-metadata-missing";
export const SAFETY_CALL_ENABLE_CODE = "safety-call-enable-input";

/** Builds the canonical attribute block immediately before a safety call.
 * Kept separate from the provider so the text transformation is easy to test. */
export function safetyCallMetadataInsertion(lineText: string, eol: string): string | undefined {
  const match = /^(\s*)(?:#[^\s.]+\.)?[A-Za-z_][\w]*\s*\(/.exec(lineText);
  if (!match) return undefined;
  const indent = match[1];
  return [
    `${indent}{`,
    `${indent}    f_user_card := "1";`,
    `${indent}    f_image_card := "0"`,
    `${indent}}`,
    "",
  ].join(eol);
}

export class SafetyCallQuickFixProvider implements vscode.CodeActionProvider {
  public static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code === SAFETY_CALL_ENABLE_CODE) {
        const line = diagnostic.range.start.line;
        const lineText = document.lineAt(line).text;
        const trueMatch = /^(\s*RUNG)\s+TRUE\s*$/i.exec(lineText);
        if (!trueMatch) continue;
        const action = new vscode.CodeAction("Remove constant EN from Safety CallBox", vscode.CodeActionKind.QuickFix);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(line, 0, line, lineText.length), trueMatch[1]);
        action.edit = edit;
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        actions.push(action);
        continue;
      }
      if (diagnostic.code !== SAFETY_CALL_METADATA_CODE) continue;
      const line = diagnostic.range.start.line;
      const insertion = safetyCallMetadataInsertion(document.lineAt(line).text, document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
      if (!insertion) continue;

      const action = new vscode.CodeAction("Add Siemens Safety call attributes", vscode.CodeActionKind.QuickFix);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, new vscode.Position(line, 0), insertion);
      action.edit = edit;
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      actions.push(action);
    }
    return actions;
  }
}
