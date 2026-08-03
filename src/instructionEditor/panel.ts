// VS Code webview panel hosting the instruction-registry editor. This is the
// only vscode-dependent file in the subsystem: it owns the WebviewPanel,
// serves the bundled Preact UI with a locked-down CSP, and routes the typed
// message protocol (messages.ts) between the webview and the EditorService.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { EditorService } from "./editorService";
import { HostToWebview, WebviewToHost } from "./messages";

/** An entry to select as soon as the editor is showing, addressed the only
 * way an outside caller can: by instruction NAME plus which half of the
 * registry it lives in (a `uid` belongs to one EditorService load and means
 * nothing to the panel's own). See `EditorService.findEntryByName`. */
export interface RevealEntryTarget {
  name: string;
  scl: boolean;
}

/** Fires after the editor commits registry changes to disk. Module-level (not
 * per-panel) so a subscriber can be wired once at activation and keep working
 * across every open/close cycle of the panel. */
const savedEmitter = new vscode.EventEmitter<string[]>();

export class RegistryEditorPanel {
  public static readonly viewType = "tiaLint.instructionEditor";
  private static current: RegistryEditorPanel | undefined;

  /**
   * Registry files were just written to disk; the payload is their
   * registry-relative paths. extension.ts uses this to reload the rule set
   * and re-lint, so an edit made in the editor takes effect on Save instead
   * of only after the extension is restarted.
   */
  public static readonly onDidSave: vscode.Event<string[]> = savedEmitter.event;

  /** Disposes the module-level emitter. Called from extension deactivation
   * via the subscription registered in activate(). */
  public static disposeEmitter(): void {
    savedEmitter.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly service: EditorService;
  private readonly disposables: vscode.Disposable[] = [];
  /** Set when the panel is opened with a reveal target but the webview hasn't
   * reported `ready` yet -- posting `openEntry` before its listener exists
   * would simply be dropped, so it waits for the `init` handshake. */
  private pendingReveal: RevealEntryTarget | undefined;

  /** True when the editor is open AND holds buffered changes. A registry
   * Quick Fix (providers/registryQuickFixProvider.ts) refuses to run in that
   * state: it edits the same YAML through its own short-lived EditorService,
   * so it would either be clobbered by the panel's next Save or -- worse --
   * trip the panel's external-change guard and strand the user's pending
   * work behind a "not overwritten" error. */
  static hasUnsavedChanges(): boolean {
    return RegistryEditorPanel.current?.service.hasDirty() ?? false;
  }

  /** Reload the open panel from disk after a registry Quick Fix wrote to it,
   * so the editor doesn't keep showing pre-fix data. Safe precisely because
   * `hasUnsavedChanges()` gated the fix: there is nothing buffered to lose. */
  static refreshAfterExternalEdit(): void {
    const panel = RegistryEditorPanel.current;
    if (!panel) return;
    panel.service.reload();
    panel.reinit();
  }

  /** Selects `target` in the open editor. Resolves the name against THIS
   * panel's own service (uids are per-load, see `RevealEntryTarget`), then
   * reuses the existing `openEntry` message the webview already handles for
   * create/duplicate/move -- which selects the entry, shows its form, and
   * expands the tree down to it. Silently does nothing if the name isn't
   * there: a reveal is a convenience, never a reason to show an error. */
  private revealEntry(target: RevealEntryTarget): void {
    const found = this.service.findEntryByName(target.name, target.scl);
    if (!found) return;
    const entry = this.service.entryData(found.uid);
    if (entry) this.post({ type: "openEntry", entry });
  }

  /**
   * Opens the editor (or reveals the existing one). `reveal` additionally
   * selects that entry and opens its form, so e.g. the "scaffold this
   * instruction" Quick Fix can land the user directly on the stub it just
   * wrote instead of on a collapsed tree they have to go hunting through.
   */
  static createOrShow(
    context: vscode.ExtensionContext,
    resourcesDir: string,
    output: vscode.OutputChannel,
    reveal?: RevealEntryTarget
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (RegistryEditorPanel.current) {
      RegistryEditorPanel.current.panel.reveal(column);
      // Already past the `init` handshake, so this lands immediately.
      if (reveal) RegistryEditorPanel.current.revealEntry(reveal);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      RegistryEditorPanel.viewType,
      "Instruction Registry Editor",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
      }
    );
    try {
      RegistryEditorPanel.current = new RegistryEditorPanel(context, panel, resourcesDir, output);
      RegistryEditorPanel.current.pendingReveal = reveal;
    } catch (err) {
      output.appendLine(`[Instruction Editor] Failed to open: ${String(err)}`);
      vscode.window.showErrorMessage(`Instruction Registry Editor failed to open: ${String(err)}`);
      panel.dispose();
    }
  }

  private constructor(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    resourcesDir: string,
    private readonly output: vscode.OutputChannel
  ) {
    this.panel = panel;
    this.service = new EditorService(resourcesDir);
    this.panel.webview.html = this.html(context, panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m: WebviewToHost) => void this.onMessage(m), null, this.disposables);

    // Watch the registry on disk and notify the webview when a loaded file is
    // edited outside the editor (so it can offer to reload before clobbering).
    const registryRoot = path.join(resourcesDir, "instruction-registry");
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(registryRoot, "**/*.yaml"));
    const notify = () => {
      if (this.externalTimer) clearTimeout(this.externalTimer);
      this.externalTimer = setTimeout(() => {
        const changed = this.service.externalChanges();
        if (changed.length) this.post({ type: "externallyChanged", relPaths: changed });
      }, 300);
    };
    this.disposables.push(watcher, watcher.onDidChange(notify), watcher.onDidCreate(notify), watcher.onDidDelete(notify));
  }

  private externalTimer: ReturnType<typeof setTimeout> | undefined;

  private post(msg: HostToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  /** Re-send the full snapshot (tree changed by a structural op). The webview
   * preserves its own local UI state (expanded folders, filter). */
  private reinit(): void {
    this.post({ type: "init", snapshot: this.service.snapshot() });
  }

  /** Open a native VS Code diff of a file's on-disk baseline vs. its buffered
   * (pending) content, via throwaway temp files. */
  private async previewDiff(relPath: string): Promise<void> {
    // The editable external registry lives outside the instruction-registry
    // tree, so it resolves through its own accessors.
    const isSystemTypes = relPath === "type-registry/system-types.yaml";
    const pending = isSystemTypes ? this.service.systemTypesPendingText() : this.service.pendingText(relPath);
    if (pending == null) return void this.post({ type: "toast", level: "warn", message: `No pending content for ${relPath}.` });
    const abs = isSystemTypes ? this.service.systemTypesAbsPath() : this.service.absPathFor(relPath);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instr-diff-"));
    const rightPath = path.join(tmpDir, path.basename(relPath));
    fs.writeFileSync(rightPath, pending, "utf-8");
    let leftUri: vscode.Uri;
    if (fs.existsSync(abs)) {
      leftUri = vscode.Uri.file(abs);
    } else {
      const leftPath = path.join(tmpDir, "empty.yaml");
      fs.writeFileSync(leftPath, "");
      leftUri = vscode.Uri.file(leftPath);
    }
    await vscode.commands.executeCommand("vscode.diff", leftUri, vscode.Uri.file(rightPath), `${relPath} (on disk ↔ pending)`);
  }

  private async confirm(message: string, action: string): Promise<boolean> {
    const pick = await vscode.window.showWarningMessage(message, { modal: true }, action);
    return pick === action;
  }

  private async onMessage(msg: WebviewToHost): Promise<void> {
    try {
      switch (msg.type) {
        case "ready":
          this.post({ type: "init", snapshot: this.service.snapshot() });
          // `init` clears the webview's selection, so a pending reveal has to
          // follow it, never precede it.
          if (this.pendingReveal) {
            const target = this.pendingReveal;
            this.pendingReveal = undefined;
            this.revealEntry(target);
          }
          return;
        case "selectEntry": {
          const entry = this.service.entryData(msg.uid);
          if (entry) this.post({ type: "entryData", entry });
          return;
        }
        case "updateField": {
          const entry = this.service.updateField(msg.uid, msg.path, msg.value);
          if (entry) this.post({ type: "entryData", entry });
          this.postStatus();
          return;
        }
        case "deleteField": {
          const entry = this.service.deleteField(msg.uid, msg.path);
          if (entry) this.post({ type: "entryData", entry });
          this.postStatus();
          return;
        }
        case "renameEntry": {
          const res = this.service.renameEntry(msg.uid, msg.newName);
          if (!res.ok) {
            this.post({ type: "toast", level: "error", message: `Cannot rename to '${msg.newName}': a different entry with that name already exists in this file.` });
          } else if (res.data) {
            this.post({ type: "entryData", entry: res.data });
          }
          this.postStatus();
          return;
        }
        case "save": {
          const result = this.service.save();
          this.post({ type: "saved", savedFiles: result.savedFiles, failed: result.failed });
          if (result.failed.length) {
            this.post({ type: "toast", level: "error", message: `${result.failed.length} file(s) failed to save; originals left intact.` });
          } else if (result.savedFiles.length) {
            this.post({ type: "toast", level: "info", message: `Saved ${result.savedFiles.length} file(s).` });
          }
          this.postStatus();
          // Fired on a PARTIAL save too: whatever did reach disk is now what
          // the linter would load, so the rule set must not be left holding a
          // mix of old and new. Skipped only when nothing was written at all.
          if (result.savedFiles.length) savedEmitter.fire(result.savedFiles);
          return;
        }
        case "revertAll": {
          this.service.reload();
          this.post({ type: "init", snapshot: this.service.snapshot() });
          this.post({ type: "toast", level: "info", message: "Reverted all unsaved changes." });
          return;
        }
        case "revealFile": {
          const abs = this.service.absPathFor(msg.relPath);
          void vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true, viewColumn: vscode.ViewColumn.Beside });
          return;
        }
        case "createEntry": {
          const res = this.service.createEntry(msg.targetRelPath, msg.name, { family: msg.family, callShape: msg.callShape });
          if (!res.ok) return void this.post({ type: "toast", level: "error", message: res.reason ?? "Could not create entry." });
          this.reinit();
          if (res.data) this.post({ type: "openEntry", entry: res.data });
          this.postStatus();
          return;
        }
        case "duplicateEntry": {
          const res = this.service.duplicateEntry(msg.uid);
          if (!res.ok) return void this.post({ type: "toast", level: "error", message: res.reason ?? "Could not duplicate." });
          this.reinit();
          if (res.data) this.post({ type: "openEntry", entry: res.data });
          this.postStatus();
          return;
        }
        case "deleteEntry": {
          const found = this.service.entryData(msg.uid);
          if (!found) return;
          if (!(await this.confirm(`Delete instruction '${found.name}' from ${found.filePath}? This is buffered until you Save (Revert restores it).`, "Delete"))) return;
          this.service.deleteEntry(msg.uid);
          this.reinit();
          this.postStatus();
          return;
        }
        case "moveEntry": {
          const res = this.service.moveEntry(msg.uid, msg.targetRelPath, msg.index);
          if (!res.ok) return void this.post({ type: "toast", level: "error", message: res.reason ?? "Move failed." });
          this.reinit();
          if (res.data) this.post({ type: "openEntry", entry: res.data });
          this.postStatus();
          return;
        }
        case "createFile": {
          const res = this.service.createFile(msg.folderRelPath, msg.fileName, msg.fileLanguage);
          if (!res.ok) return void this.post({ type: "toast", level: "error", message: res.reason ?? "Could not create file." });
          this.reinit();
          this.post({ type: "toast", level: "info", message: `Created ${res.relPath} (unsaved).` });
          return;
        }
        case "deleteFile": {
          const doc = this.service.workspace().document(msg.relPath);
          const count = doc?.entries().length ?? 0;
          const warn = `Delete file ${msg.relPath}${count ? ` and its ${count} instruction(s)` : ""}? Buffered until Save (Revert restores it).`;
          if (!(await this.confirm(warn, "Delete file"))) return;
          this.service.deleteFile(msg.relPath);
          this.reinit();
          this.postStatus();
          return;
        }
        case "renameFile": {
          const res = this.service.renameFile(msg.relPath, msg.newName);
          if (!res.ok) return void this.post({ type: "toast", level: "error", message: res.reason ?? "Rename failed." });
          this.reinit();
          return;
        }
        case "moveFile": {
          const res = this.service.moveFile(msg.relPath, msg.targetFolderRelPath);
          if (!res.ok) return void this.post({ type: "toast", level: "error", message: res.reason ?? "Move failed." });
          this.reinit();
          return;
        }
        case "createFolder": {
          const res = this.service.createFolder(msg.parentRelPath, msg.name);
          if (!res.ok) return void this.post({ type: "toast", level: "error", message: res.reason ?? "Could not create folder." });
          this.reinit();
          return;
        }
        case "deleteFolder": {
          if (!(await this.confirm(`Delete folder ${msg.relPath}? Only empty folders can be deleted.`, "Delete folder"))) return;
          const res = this.service.deleteFolder(msg.relPath);
          if (!res.ok) return void this.post({ type: "toast", level: "error", message: res.reason ?? "Could not delete folder." });
          this.reinit();
          return;
        }
        case "reorderFile": {
          const res = this.service.reorderFile(msg.relPath, msg.orderedUids);
          if (!res.ok) return void this.post({ type: "toast", level: "error", message: res.reason ?? "Reorder failed." });
          this.reinit();
          this.postStatus();
          return;
        }
        case "moveEntries": {
          const res = this.service.moveEntries(msg.uids, msg.targetRelPath, msg.index);
          if (!res.ok) return void this.post({ type: "toast", level: "error", message: res.reason ?? "Move failed." });
          this.reinit();
          this.post({ type: "toast", level: "info", message: `Moved ${res.uids?.length ?? 0} instruction(s) to ${msg.targetRelPath}.` });
          this.postStatus();
          return;
        }
        case "undo": {
          if (!this.service.undo()) return void this.post({ type: "toast", level: "info", message: "Nothing to undo." });
          this.reinit();
          this.postStatus();
          return;
        }
        case "redo": {
          if (!this.service.redo()) return void this.post({ type: "toast", level: "info", message: "Nothing to redo." });
          this.reinit();
          this.postStatus();
          return;
        }
        case "previewDiff": {
          await this.previewDiff(msg.relPath);
          return;
        }
        case "selectSystemType": {
          const data = this.service.systemTypeData(msg.name);
          if (data) this.post({ type: "systemTypeData", data });
          return;
        }
        case "createSystemType": {
          const res = this.service.createSystemType(msg.name, { category: msg.category, basicDataType: msg.basicDataType, description: msg.description });
          if (!res.ok) return void this.post({ type: "toast", level: "error", message: res.reason ?? "Could not create system type." });
          this.reinit();
          if (res.data) this.post({ type: "openSystemType", data: res.data });
          this.postStatus();
          return;
        }
        case "createSystemTypeForInstruction": {
          const res = this.service.createSystemTypeForInstruction(msg.uid, msg.typeName);
          if (!res.ok) return void this.post({ type: "toast", level: "error", message: res.reason ?? "Could not create system type." });
          this.reinit();
          if (res.data) this.post({ type: "openSystemType", data: res.data });
          this.post({
            type: "toast",
            level: "info",
            message: `Added '${res.data?.name}' to system-types.yaml (members seeded from the instruction's pins -- review and Save).`,
          });
          this.postStatus();
          return;
        }
        case "updateSystemTypeField": {
          const data = this.service.updateSystemTypeField(msg.name, msg.path, msg.value);
          if (data) this.post({ type: "systemTypeData", data });
          this.postStatus();
          return;
        }
        case "deleteSystemTypeField": {
          const data = this.service.deleteSystemTypeField(msg.name, msg.path);
          if (data) this.post({ type: "systemTypeData", data });
          this.postStatus();
          return;
        }
        case "renameSystemType": {
          const res = this.service.renameSystemType(msg.name, msg.newName);
          if (!res.ok) return void this.post({ type: "toast", level: "error", message: res.reason ?? "Rename failed." });
          this.reinit();
          if (res.data) this.post({ type: "openSystemType", data: res.data });
          this.postStatus();
          return;
        }
        case "createMissingSystemTypes": {
          const missing = this.service.findMissingSystemTypes().filter((m) => !msg.names || msg.names.includes(m.name));
          if (missing.length === 0) {
            return void this.post({ type: "toast", level: "info", message: "No missing system types -- every referenced type is catalogued." });
          }
          // Review before writing: list what will be created and how complete
          // each one will be, so nothing is added blind.
          const withMembers = missing.filter((m) => m.members.length > 0).length;
          const preview = missing.slice(0, 25).map((m) => `  • ${m.name}${m.members.length ? ` (${m.members.length} member(s) from pins)` : " (members: null)"}`).join("\n");
          const detail =
            `${missing.length} type(s) will be added to type-registry/system-types.yaml.\n` +
            `${withMembers} get members seeded from the referencing instruction's pins; the rest are created with members: null for you to fill in.\n\n` +
            preview +
            (missing.length > 25 ? `\n  … and ${missing.length - 25} more` : "") +
            `\n\nThis is buffered until you Save (Revert undoes it).`;
          const pick = await vscode.window.showWarningMessage(
            `Add ${missing.length} missing system type(s)?`,
            { modal: true, detail },
            "Add all"
          );
          if (pick !== "Add all") return;
          const res = this.service.createMissingSystemTypes(msg.names);
          this.reinit();
          this.postStatus();
          this.post({
            type: "toast",
            level: "info",
            message: `Added ${res.created.length} system type(s)${res.skipped.length ? `, skipped ${res.skipped.length} existing` : ""} -- review and Save.`,
          });
          return;
        }
        case "deleteSystemType": {
          if (!(await this.confirm(`Delete system type '${msg.name}' from system-types.yaml? Buffered until Save (Revert restores it).`, "Delete"))) return;
          this.service.deleteSystemType(msg.name);
          this.reinit();
          this.postStatus();
          return;
        }
      }
    } catch (err) {
      this.output.appendLine(`[Instruction Editor] message '${msg.type}' failed: ${String(err)}`);
      this.post({ type: "toast", level: "error", message: `Operation failed: ${String(err instanceof Error ? err.message : err)}` });
    }
  }

  private postStatus(): void {
    const status = this.service.status();
    this.post({
      type: "status",
      fileStatus: status.fileStatus,
      findings: status.findings,
      hasErrors: status.hasErrors,
      canUndo: this.service.canUndo(),
      canRedo: this.service.canRedo(),
    });
  }

  private html(context: vscode.ExtensionContext, webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "instructionEditor.webview.js"));
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Instruction Registry Editor</title>
</head>
<body>
  <div id="root">Loading instruction registry…</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    RegistryEditorPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
