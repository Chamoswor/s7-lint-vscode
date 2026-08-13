// Quick Fixes for deterministic .s7res repairs: create a missing sibling
// resource, add missing MLC IDs, quote text truncated by YAML's ` # comment`
// rule, and repair a missing/non-string mandatory locale field.
import * as vscode from "vscode";
import {
  analyzeS7res,
  findAllMlcPragmaUsages,
  siblingS7ResPath,
  siblingSourcePath,
} from "../parser/s7resParser";
import {
  addMissingEnUs,
  addS7resEntries,
  quoteInvalidLocaleScalar,
  quoteS7resLocaleLine,
  renderS7res,
} from "./s7resQuickFix";

const MLC_ID_NOT_FOUND = "mlc-id-not-found";
const UNQUOTED_COMMENT = "s7res-unquoted-comment";
const INVALID_ENTRY = "s7res-invalid-entry";
const INVALID_ROOT = "s7res-invalid-root";

function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.toString().toLowerCase() === b.toString().toLowerCase();
}

function fullRange(text: string): vscode.Range {
  const lines = text.split(/\r\n|\n/);
  const last = lines.length - 1;
  return new vscode.Range(0, 0, last, lines[last].length);
}

function diagnosticPositionKey(diagnostic: vscode.Diagnostic): string {
  return `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export class S7ResQuickFixProvider implements vscode.CodeActionProvider {
  public static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  async provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): Promise<vscode.CodeAction[]> {
    const relevant = context.diagnostics.filter((diagnostic) =>
      [MLC_ID_NOT_FOUND, UNQUOTED_COMMENT, INVALID_ENTRY, INVALID_ROOT].includes(String(diagnostic.code))
    );
    if (relevant.length === 0) return [];

    const lowerPath = document.uri.fsPath.toLowerCase();
    if (lowerPath.endsWith(".s7res")) return this.resourceActions(document, relevant);
    if (/\.(s7dcl|udt)$/.test(lowerPath)) return this.sourceActions(document, relevant.filter((d) => d.code === MLC_ID_NOT_FOUND));
    return [];
  }

  private async readWorkspaceText(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find((document) => sameUri(document.uri, uri));
    if (open) return open.getText();
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8");
    } catch {
      return undefined;
    }
  }

  private async sourceActions(document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]): Promise<vscode.CodeAction[]> {
    if (diagnostics.length === 0) return [];
    const usages = findAllMlcPragmaUsages(document.getText());
    const usageByPosition = new Map(usages.map((usage) => [`${usage.token.line}:${usage.token.col}`, usage.id]));
    const allIds = unique(usages.map((usage) => usage.id));
    if (allIds.length === 0) return [];

    const resourceUri = vscode.Uri.file(siblingS7ResPath(document.uri.fsPath));
    const resourceText = await this.readWorkspaceText(resourceUri);
    if (resourceText === undefined) {
      const action = new vscode.CodeAction(
        `Create sibling .s7res with ${allIds.length} referenced MLC ${allIds.length === 1 ? "ID" : "IDs"}`,
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = diagnostics;
      action.isPreferred = true;
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(resourceUri);
      edit.insert(resourceUri, new vscode.Position(0, 0), renderS7res(allIds, document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"));
      action.edit = edit;
      return [action];
    }

    const analysis = analyzeS7res(resourceText);
    if (!analysis.parsed) return [];
    const missingIds = allIds.filter((id) => !analysis.parsed!.entries.has(id));
    if (missingIds.length === 0) return [];

    const actions: vscode.CodeAction[] = [];
    const diagnosticsById = new Map<string, vscode.Diagnostic[]>();
    for (const diagnostic of diagnostics) {
      const id = usageByPosition.get(diagnosticPositionKey(diagnostic));
      if (!id || !missingIds.includes(id)) continue;
      const grouped = diagnosticsById.get(id) ?? [];
      grouped.push(diagnostic);
      diagnosticsById.set(id, grouped);
    }

    for (const [id, idDiagnostics] of diagnosticsById) {
      actions.push(this.replaceResourceAction(`Add MLC id '${id}' to sibling .s7res`, resourceUri, resourceText, addS7resEntries(resourceText, [id]), idDiagnostics, missingIds.length === 1));
    }
    if (missingIds.length > 1) {
      actions.push(
        this.replaceResourceAction(
          `Add all ${missingIds.length} missing MLC IDs to sibling .s7res`,
          resourceUri,
          resourceText,
          addS7resEntries(resourceText, missingIds),
          diagnostics,
          true
        )
      );
    }
    return actions;
  }

  private replaceResourceAction(
    title: string,
    uri: vscode.Uri,
    oldText: string,
    newText: string,
    diagnostics: vscode.Diagnostic[],
    preferred: boolean
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    action.diagnostics = diagnostics;
    action.isPreferred = preferred;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange(oldText), newText);
    action.edit = edit;
    return action;
  }

  private async resourceActions(document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]): Promise<vscode.CodeAction[]> {
    const text = document.getText();
    const lines = text.split(/\r\n|\n/);
    const actions: vscode.CodeAction[] = [];
    const analysis = analyzeS7res(text);

    for (const diagnostic of diagnostics) {
      const lineNumber = diagnostic.range.start.line + 1;
      if (diagnostic.code === UNQUOTED_COMMENT) {
        const replacement = quoteS7resLocaleLine(lines[lineNumber - 1] ?? "");
        if (!replacement) continue;
        const action = new vscode.CodeAction("Quote the complete resource text", vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(lineNumber - 1, 0, lineNumber - 1, (lines[lineNumber - 1] ?? "").length), replacement);
        action.edit = edit;
        actions.push(action);
        continue;
      }

      if (diagnostic.code === INVALID_ENTRY) {
        const issue = analysis.issues.find((candidate) => candidate.kind === "invalid-entry" && candidate.line === lineNumber);
        if (!issue) continue;
        let repaired: string | undefined;
        let title: string;
        if (issue.reason === "'en-US' must be present and contain text" && issue.id && !/^\s+en-US\s*:/.test(lines[lineNumber - 1] ?? "")) {
          repaired = addMissingEnUs(text, lineNumber);
          title = `Add missing en-US text for '${issue.id}'`;
        } else {
          repaired = quoteInvalidLocaleScalar(text, lineNumber);
          title = "Convert locale value to quoted text";
        }
        if (!repaired) continue;
        actions.push(this.replaceResourceAction(title, document.uri, text, repaired, [diagnostic], true));
      }
    }

    if (text.trim() === "" && diagnostics.some((diagnostic) => diagnostic.code === INVALID_ROOT)) {
      const sourcePath = siblingSourcePath(document.uri.fsPath);
      const sourceText = sourcePath ? await this.readWorkspaceText(vscode.Uri.file(sourcePath)) : undefined;
      const ids = sourceText ? unique(findAllMlcPragmaUsages(sourceText).map((usage) => usage.id)) : [];
      const action = new vscode.CodeAction(
        ids.length > 0 ? `Initialize .s7res with ${ids.length} referenced MLC ${ids.length === 1 ? "ID" : "IDs"}` : "Initialize empty .s7res structure",
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = diagnostics.filter((diagnostic) => diagnostic.code === INVALID_ROOT);
      action.isPreferred = true;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, fullRange(text), renderS7res(ids, document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"));
      action.edit = edit;
      actions.push(action);
    }

    return actions;
  }
}
