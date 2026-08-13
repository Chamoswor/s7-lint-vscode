// F2 / right-click "Rename Symbol" for `.s7dcl`/`.udt` documents. Built on
// the SAME `renameKey`-tagged spans hover/definition/semantic-tokens
// already share (analysis/documentIndex.ts) -- rename just groups spans by
// key instead of re-deriving what a `#tag`, a pin, or a block name refers
// to. Three scopes (see IdentifierSpan's own doc comment):
//   local:<docPath>:<name>   -- this document only
//   type:<blockName>         -- this FB/FC/OB/DB's own name, workspace-wide
//   member:<blockName>:<name> -- an FB/FC's VAR_INPUT/OUTPUT/IN_OUT pin, or
//                                a DATA_BLOCK member, workspace-wide
//   mlc:<id>\0<s7resPath>     -- an MLC pragma ID -- this doc's pragma
//                                value(s) + the sibling `.s7res` id line
import * as fs from "fs";
import * as vscode from "vscode";
import { BlockIndex } from "../analysis/blockIndex";
import { buildDocumentIndex, IdentifierSpan } from "../analysis/documentIndex";
import { TypeCacheResult } from "../cache/typeCache";
import { getMlcLocale } from "../config";
import { loadSiblingS7Res } from "../parser/s7resParser";
import { RuleSet } from "../rules/types";

const WORKSPACE_GLOB = "**/*.s7dcl";
const EXCLUDE_GLOB = "**/node_modules/**";

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function spanRange(span: IdentifierSpan): vscode.Range {
  return new vscode.Range(span.line - 1, span.startCol - 1, span.line - 1, span.startCol - 1 + span.length);
}

function lineOf(text: string, lineNo: number): string {
  // Same line-splitting documentIndex.ts's own token positions are 1-based
  // against -- good enough for a rename edit's small, single-line slice.
  return text.split(/\r\n|\n/)[lineNo - 1] ?? "";
}

function spanText(fileText: string, span: IdentifierSpan): string {
  return lineOf(fileText, span.line).slice(span.startCol - 1, span.startCol - 1 + span.length);
}

/** Preserves a span's own `#` prefix or surrounding quote characters --
 * e.g. renaming `#i_xCmdStart` (a whole-token span, `#` included) must
 * produce `#newName`, not `newName` swallowing the `#`; renaming
 * `"MLC_3UP"` must stay quoted. Determined from the CURRENT text at the
 * span (not tracked per-span) so one rule covers every push site in
 * documentIndex.ts without per-site bookkeeping. */
function replacementFor(oldText: string, newName: string): string {
  if (oldText.startsWith("#")) return "#" + newName;
  if (oldText.length >= 2 && (oldText[0] === '"' || oldText[0] === "'") && oldText[oldText.length - 1] === oldText[0]) {
    return oldText[0] + newName + oldText[0];
  }
  return newName;
}

function findRenameSpan(
  document: vscode.TextDocument,
  position: vscode.Position,
  ruleSet: RuleSet,
  blockIndex: BlockIndex,
  typeCache: TypeCacheResult
): IdentifierSpan | undefined {
  const index = buildDocumentIndex(document.getText(), ruleSet, blockIndex, document.uri.fsPath, getMlcLocale(document.uri), typeCache);
  const line = position.line + 1;
  const col = position.character + 1;
  return index.spans.find((s) => s.renameKey && s.line === line && col >= s.startCol && col <= s.startCol + s.length);
}

/** Narrows a span's full range down to just the renameable identifier --
 * strips a leading `#` or surrounding quotes -- for `prepareRename`'s
 * placeholder + inline-editable-widget range. */
function innerRange(document: vscode.TextDocument, span: IdentifierSpan): vscode.Range {
  const full = spanRange(span);
  const text = document.getText(full);
  let startDelta = 0;
  let endDelta = 0;
  if (text.startsWith("#")) startDelta = 1;
  else if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    startDelta = 1;
    endDelta = 1;
  }
  return new vscode.Range(full.start.line, full.start.character + startDelta, full.end.line, full.end.character - endDelta);
}

/** Reads a workspace `.s7dcl` file's current text -- an OPEN document's
 * live (possibly unsaved) buffer if there is one, otherwise disk content --
 * so a rename in progress elsewhere in the workspace isn't silently
 * ignored or overwritten. */
async function readWorkspaceFile(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => normalizePath(d.uri.fsPath) === normalizePath(uri.fsPath));
  if (open) return open.getText();
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

/** Collects every workspace `.s7dcl` file whose text COULD contain a match
 * for `renameKey` -- a cheap substring pre-filter (the key's own bare
 * name) before actually tokenizing/parsing each candidate, since most
 * files in a real workspace won't reference a given block/member at all. */
async function candidateFiles(needle: string, currentDoc: vscode.TextDocument): Promise<{ uri: vscode.Uri; text: string }[]> {
  const seen = new Set<string>([normalizePath(currentDoc.uri.fsPath)]);
  const results: { uri: vscode.Uri; text: string }[] = [{ uri: currentDoc.uri, text: currentDoc.getText() }];
  const uris = await vscode.workspace.findFiles(WORKSPACE_GLOB, EXCLUDE_GLOB);
  for (const uri of uris) {
    const norm = normalizePath(uri.fsPath);
    if (seen.has(norm)) continue;
    seen.add(norm);
    const text = await readWorkspaceFile(uri);
    if (text.includes(needle)) results.push({ uri, text });
  }
  return results;
}

export class S7dclRenameProvider implements vscode.RenameProvider {
  constructor(
    private readonly ruleSet: RuleSet,
    private readonly blockIndex: BlockIndex,
    private readonly getTypeCache: () => TypeCacheResult
  ) {}

  prepareRename(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Range> {
    const span = findRenameSpan(document, position, this.ruleSet, this.blockIndex, this.getTypeCache());
    if (!span) throw new Error("This isn't a renameable symbol (variable, block name, or MultiLingualTexts ID).");
    return innerRange(document, span);
  }

  async provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string): Promise<vscode.WorkspaceEdit | undefined> {
    const typeCache = this.getTypeCache();
    const span = findRenameSpan(document, position, this.ruleSet, this.blockIndex, typeCache);
    if (!span?.renameKey) return undefined;
    const key = span.renameKey;
    const edit = new vscode.WorkspaceEdit();

    if (key.startsWith("mlc:")) {
      const [id, resPath] = key.slice(4).split("\0");
      const index = buildDocumentIndex(document.getText(), this.ruleSet, this.blockIndex, document.uri.fsPath, getMlcLocale(document.uri), typeCache);
      for (const s of index.spans) {
        if (s.renameKey !== key) continue;
        edit.replace(document.uri, spanRange(s), replacementFor(document.getText(spanRange(s)), newName));
      }
      const s7res = loadSiblingS7Res(document.uri.fsPath);
      const entry = s7res?.entries.get(id);
      if (entry) {
        const resUri = vscode.Uri.file(resPath);
        let resText: string;
        try {
          resText = fs.readFileSync(resPath, "utf8");
        } catch {
          return edit; // .s7res vanished since parse -- still apply the .s7dcl-side edits
        }
        const idLineText = lineOf(resText, entry.idLine);
        const idStart = idLineText.indexOf(id, entry.idCol - 1);
        if (idStart >= 0) {
          edit.replace(resUri, new vscode.Range(entry.idLine - 1, idStart, entry.idLine - 1, idStart + id.length), newName);
        }
      }
      return edit;
    }

    if (key.startsWith("local:")) {
      const index = buildDocumentIndex(document.getText(), this.ruleSet, this.blockIndex, document.uri.fsPath, getMlcLocale(document.uri), typeCache);
      for (const s of index.spans) {
        if (s.renameKey !== key) continue;
        edit.replace(document.uri, spanRange(s), replacementFor(document.getText(spanRange(s)), newName));
      }
      return edit;
    }

    // `type:` / `member:` -- workspace-wide.
    const bareName = key.split(":").pop()!;
    const files = await candidateFiles(bareName, document);
    for (const f of files) {
      const index = buildDocumentIndex(f.text, this.ruleSet, this.blockIndex, f.uri.fsPath, getMlcLocale(f.uri), typeCache);
      for (const s of index.spans) {
        if (s.renameKey !== key) continue;
        edit.replace(f.uri, spanRange(s), replacementFor(spanText(f.text, s), newName));
      }
    }
    return edit;
  }
}
