// In-memory workspace model for the whole instruction-registry: every file
// parsed into a comment-preserving RegistryDocument, arranged into the
// folder/file/entry navigation tree, with duplicate-name and observed-family
// indexing. This is the single source of truth the UI state layer (Phase 2+)
// and the edit-operation/command layer bind to.
//
// Identity: every entry carries a stable synthetic `uid` from its
// RegistryDocument (see yamlDocument.ts), globally unique for the session and
// preserved across renames/reorders/cross-file moves -- so tree nodes, drag
// state and undo/redo never key off array indices, per the task brief.
//
// vscode-free, so the whole model is exercisable from the scripts/ harness.
import * as fs from "fs";
import * as path from "path";
import {
  DiscoveredFile,
  discoverFolders,
  discoverInstructionFiles,
  isSclFile,
} from "./registryPaths";
import { RegistryDocument } from "./yamlDocument";
import { fileChangedOnDisk } from "./atomicSave";

export interface EntryNode {
  kind: "entry";
  /** Globally-unique, reorder/rename/move-stable id (the RegistryDocument uid). */
  id: string;
  name: string;
  /** relPath of the file this entry currently lives in. */
  filePath: string;
}

export interface FileNode {
  kind: "file";
  /** Stable id (the file's relPath). */
  id: string;
  relPath: string;
  fileName: string;
  /** True for `*-SCL.yaml` (routed to the linter's sclInstructions map). */
  isScl: boolean;
  fileLanguage?: string[];
  entries: EntryNode[];
  parseErrors: string[];
}

export interface FolderNode {
  kind: "folder";
  /** Stable id (the folder's relPath; "" for the root). */
  id: string;
  relPath: string;
  name: string;
  folders: FolderNode[];
  files: FileNode[];
}

export interface DuplicateName {
  name: string;
  /** Which lookup map the collision is in (`instructions` vs `sclInstructions`
   * are separate maps, so the same name in each is NOT a duplicate). */
  scope: "general" | "scl";
  /** relPaths of every file declaring this name. */
  files: string[];
}

interface LoadedFile {
  /** `discovered.relPath`/`fileName`/`absPath`/`isScl` reflect the file's
   * CURRENT (possibly buffered-renamed) location, which may differ from disk. */
  discovered: DiscoveredFile;
  doc: RegistryDocument;
  /** File mtime at load time, for external-change detection (Phase 5). */
  mtimeMs: number;
  /** Text on disk at load time, for external-change detection and diffs. */
  diskText: string;
  /** True for a file created in-session that isn't on disk yet (written on Save). */
  isNew: boolean;
  /** True when the file is marked for deletion (unlinked on Save). */
  deleted: boolean;
  /** The path currently on disk, when it differs from `discovered.relPath`
   * because of a buffered rename/move -- the old file is unlinked on Save.
   * undefined when the on-disk path still matches (or the file is new). */
  diskRelPath?: string;
}

export class RegistryWorkspace {
  readonly registryRoot: string;
  private files = new Map<string, LoadedFile>();

  private constructor(registryRoot: string) {
    this.registryRoot = registryRoot;
  }

  /** Parse every instruction-registry file under `registryRoot`. */
  static load(registryRoot: string): RegistryWorkspace {
    const ws = new RegistryWorkspace(registryRoot);
    for (const discovered of discoverInstructionFiles(registryRoot)) {
      ws.loadFile(discovered);
    }
    return ws;
  }

  private loadFile(discovered: DiscoveredFile): void {
    const diskText = fs.readFileSync(discovered.absPath, "utf-8");
    const stat = fs.statSync(discovered.absPath);
    this.files.set(discovered.relPath, {
      discovered,
      doc: RegistryDocument.parse(diskText),
      mtimeMs: stat.mtimeMs,
      diskText,
      isNew: false,
      deleted: false,
    });
  }

  /** Relative paths of live (non-deleted) files, sorted. */
  fileRelPaths(): string[] {
    return [...this.files.entries()]
      .filter(([, f]) => !f.deleted)
      .map(([rel]) => rel)
      .sort((a, b) => a.localeCompare(b));
  }

  document(relPath: string): RegistryDocument | undefined {
    const f = this.files.get(relPath);
    return f && !f.deleted ? f.doc : undefined;
  }

  /** Absolute path for a registry-relative file path. */
  absPathFor(relPath: string): string {
    return path.join(this.registryRoot, ...relPath.split("/"));
  }

  /** Any buffered, unsaved change: dirty content, new files, deletions, renames. */
  hasPendingChanges(): boolean {
    for (const f of this.files.values()) {
      if (f.deleted || f.isNew || f.diskRelPath || f.doc.isDirty()) return true;
    }
    return false;
  }

  /** True if a loaded file's on-disk bytes changed since it was read in (an
   * external edit). New files are never "externally changed". For a buffered
   * rename/move, the on-disk copy is still at the ORIGINAL path (`diskRelPath`),
   * so check there -- not the pending new path, which doesn't exist yet. */
  externallyChanged(relPath: string): boolean {
    const f = this.files.get(relPath);
    if (!f || f.isNew) return false;
    const diskAbs = this.absPathFor(f.diskRelPath ?? relPath);
    return fileChangedOnDisk(diskAbs, f.diskText, f.mtimeMs);
  }

  /** relPaths of all loaded files whose on-disk bytes changed externally. */
  externallyChangedFiles(): string[] {
    const out: string[] = [];
    for (const [relPath, f] of this.files) {
      if (!f.deleted && this.externallyChanged(relPath)) out.push(relPath);
    }
    return out;
  }

  diskText(relPath: string): string | undefined {
    return this.files.get(relPath)?.diskText;
  }

  loadMtimeMs(relPath: string): number | undefined {
    return this.files.get(relPath)?.mtimeMs;
  }

  /** Build the folder/file/entry navigation tree. */
  buildTree(): FolderNode {
    const root: FolderNode = { kind: "folder", id: "", relPath: "", name: "instruction-registry", folders: [], files: [] };
    const folderByPath = new Map<string, FolderNode>([["", root]]);

    // Materialize every folder (including empty ones) so the tree matches disk.
    for (const rel of discoverFolders(this.registryRoot)) {
      if (rel === "") continue;
      this.ensureFolder(rel, folderByPath);
    }

    for (const relPath of this.fileRelPaths()) {
      const loaded = this.files.get(relPath)!;
      const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
      const folder = this.ensureFolder(dir, folderByPath);
      const doc = loaded.doc;
      folder.files.push({
        kind: "file",
        id: relPath,
        relPath,
        fileName: loaded.discovered.fileName,
        isScl: loaded.discovered.isScl,
        fileLanguage: doc.fileLanguage(),
        parseErrors: doc.parseErrors(),
        entries: doc.entries().map((e) => ({ kind: "entry", id: e.uid, name: e.name, filePath: relPath })),
      });
    }

    sortFolder(root);
    return root;
  }

  private ensureFolder(relPath: string, folderByPath: Map<string, FolderNode>): FolderNode {
    const existing = folderByPath.get(relPath);
    if (existing) return existing;
    const parentPath = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
    const parent = this.ensureFolder(parentPath, folderByPath);
    const node: FolderNode = {
      kind: "folder",
      id: relPath,
      relPath,
      name: relPath.slice(relPath.lastIndexOf("/") + 1),
      folders: [],
      files: [],
    };
    parent.folders.push(node);
    folderByPath.set(relPath, node);
    return node;
  }

  /** Detects instruction names declared in more than one file within the same
   * lookup map. (README: duplicate keys are "not a supported override
   * mechanism" -- the linter silently lets the later file win, so surfacing
   * these is a real gap the editor fills.) */
  findDuplicateNames(): DuplicateName[] {
    const general = new Map<string, string[]>();
    const scl = new Map<string, string[]>();
    for (const [relPath, loaded] of this.files) {
      if (loaded.deleted) continue;
      // Scope by real (basename-detected) SCL classification, not the loader's
      // never-matching -SCL.yaml suffix -- so a name legitimately shared
      // between an SCL file and a graphical (LAD/FBD) file isn't a duplicate.
      const target = loaded.discovered.isScl ? scl : general;
      for (const entry of loaded.doc.entries()) {
        if (!target.has(entry.name)) target.set(entry.name, []);
        target.get(entry.name)!.push(relPath);
      }
    }
    const out: DuplicateName[] = [];
    for (const [scope, map] of [["general", general], ["scl", scl]] as const) {
      for (const [name, filesFor] of map) {
        if (filesFor.length > 1) out.push({ name, scope, files: filesFor.sort() });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every `family` value actually present across the registry -- unioned with
   * the schema's KNOWN_FAMILIES by callers so a new family is still offered. */
  observedFamilies(): Set<string> {
    const out = new Set<string>();
    for (const loaded of this.files.values()) {
      if (loaded.deleted) continue;
      for (const entry of loaded.doc.entries()) {
        const js = loaded.doc.entryJS(entry.uid);
        const fam = js && typeof js.family === "string" ? js.family : undefined;
        if (fam) out.add(fam);
      }
    }
    return out;
  }

  /** Locate which file currently holds a given entry uid. */
  findEntry(uid: string): { relPath: string; name: string } | undefined {
    for (const [relPath, loaded] of this.files) {
      if (loaded.deleted) continue;
      for (const entry of loaded.doc.entries()) {
        if (entry.uid === uid) return { relPath, name: entry.name };
      }
    }
    return undefined;
  }

  /** Total entry count across all live files (for stats/tests). */
  entryCount(): number {
    let n = 0;
    for (const loaded of this.files.values()) if (!loaded.deleted) n += loaded.doc.entries().length;
    return n;
  }

  // --- buffered file/folder/entry mutations -----------------------------
  // All entry- and file-level changes are buffered here and committed by a
  // single Save (see EditorService.save); Revert (reload) discards them. This
  // gives one consistent undo point and satisfies the brief's "no silent data
  // loss / confirm before losing unsaved work" requirements. Folder create/
  // delete are the only immediate filesystem ops (containers, no data risk).

  fileExistsInWorkspace(relPath: string): boolean {
    const f = this.files.get(relPath);
    return !!f && !f.deleted;
  }

  /** Buffer a brand-new file (written to disk on Save). */
  createFile(relPath: string, initialText: string): void {
    const fileName = relPath.slice(relPath.lastIndexOf("/") + 1);
    this.files.set(relPath, {
      discovered: { absPath: this.absPathFor(relPath), relPath, fileName, isScl: isSclFile(fileName) },
      doc: RegistryDocument.parse(initialText),
      mtimeMs: 0,
      diskText: "",
      isNew: true,
      deleted: false,
    });
  }

  /** Mark a file for deletion (unlinked on Save). A never-saved new file is
   * simply dropped. */
  markFileDeleted(relPath: string): boolean {
    const f = this.files.get(relPath);
    if (!f) return false;
    if (f.isNew) this.files.delete(relPath);
    else f.deleted = true;
    return true;
  }

  /** Buffer a file rename/move to `newRelPath` (old path unlinked on Save). */
  renameFile(relPath: string, newRelPath: string): boolean {
    const f = this.files.get(relPath);
    if (!f || f.deleted) return false;
    if (this.fileExistsInWorkspace(newRelPath)) return false; // target taken
    // Remember the on-disk origin so Save can unlink it. If already renamed
    // once this session, keep the ORIGINAL disk path.
    if (!f.isNew && f.diskRelPath == null) f.diskRelPath = relPath;
    const fileName = newRelPath.slice(newRelPath.lastIndexOf("/") + 1);
    f.discovered = { absPath: this.absPathFor(newRelPath), relPath: newRelPath, fileName, isScl: isSclFile(fileName) };
    this.files.delete(relPath);
    this.files.set(newRelPath, f);
    return true;
  }

  /** Move an entry (by uid) into another file at an optional index, carrying
   * its comments. Returns the entry's (stable) uid on success. */
  moveEntry(uid: string, targetRelPath: string, index?: number): string | undefined {
    const src = this.findEntry(uid);
    if (!src) return undefined;
    const srcDoc = this.document(src.relPath);
    const dstDoc = this.document(targetRelPath);
    if (!srcDoc || !dstDoc) return undefined;
    if (src.relPath === targetRelPath) {
      if (index != null) srcDoc.moveEntryWithin(uid, index);
      return uid;
    }
    const pair = srcDoc.extractPair(uid);
    if (!pair) return undefined;
    return dstDoc.insertPair(pair, index);
  }

  /** Info the save routine needs for every buffered file (including deletions). */
  pendingSaveList(): {
    relPath: string;
    absPath: string;
    doc: RegistryDocument;
    isNew: boolean;
    deleted: boolean;
    diskRelPath?: string;
    dirty: boolean;
  }[] {
    const out = [];
    for (const [relPath, f] of this.files) {
      out.push({
        relPath,
        absPath: f.discovered.absPath,
        doc: f.doc,
        isNew: f.isNew,
        deleted: f.deleted,
        diskRelPath: f.diskRelPath,
        dirty: f.doc.isDirty(),
      });
    }
    return out;
  }

  /** Drop a deleted file from the map after its disk file was unlinked. */
  forgetFile(relPath: string): void {
    this.files.delete(relPath);
  }

  /** Update a file's on-disk baseline after a successful write, WITHOUT a full
   * reload -- so entry uids and the UI selection stay stable across a save. */
  markSaved(relPath: string, text: string, mtimeMs: number): void {
    const f = this.files.get(relPath);
    if (!f) return;
    f.doc.markClean();
    f.diskText = text;
    f.mtimeMs = mtimeMs;
    f.isNew = false;
    f.diskRelPath = undefined;
  }

  // --- undo/redo state snapshots ----------------------------------------
  // A snapshot captures the full buffered workspace state as plain data, so
  // undo/redo can restore it by re-parsing. Re-parsing mints fresh entry uids,
  // so the UI re-inits after an undo (selection is not preserved -- standard
  // for an undo of structural edits).

  /** Capture the current buffered state of every file (including deletions). */
  exportState(): WorkspaceState {
    const files: WorkspaceFileState[] = [];
    for (const [relPath, f] of this.files) {
      files.push({
        relPath,
        // Current (post-edit) content; clean files reuse their baseline text.
        text: f.doc.isDirty() ? f.doc.toText() : f.diskText,
        diskText: f.diskText,
        mtimeMs: f.mtimeMs,
        isNew: f.isNew,
        deleted: f.deleted,
        diskRelPath: f.diskRelPath,
      });
    }
    return { files };
  }

  /** Replace the workspace with a previously exported state. */
  importState(state: WorkspaceState): void {
    this.files.clear();
    for (const f of state.files) {
      const fileName = f.relPath.slice(f.relPath.lastIndexOf("/") + 1);
      const doc = RegistryDocument.parse(f.text);
      // A file whose content differs from its on-disk baseline (or that is
      // new/renamed) must be re-written on Save -> mark it dirty.
      if (f.text !== f.diskText || f.isNew || f.diskRelPath) doc.markDirty();
      this.files.set(f.relPath, {
        discovered: { absPath: this.absPathFor(f.relPath), relPath: f.relPath, fileName, isScl: isSclFile(fileName) },
        doc,
        mtimeMs: f.mtimeMs,
        diskText: f.diskText,
        isNew: f.isNew,
        deleted: f.deleted,
        diskRelPath: f.diskRelPath,
      });
    }
  }
}

export interface WorkspaceFileState {
  relPath: string;
  text: string;
  diskText: string;
  mtimeMs: number;
  isNew: boolean;
  deleted: boolean;
  diskRelPath?: string;
}
export interface WorkspaceState {
  files: WorkspaceFileState[];
}

function sortFolder(folder: FolderNode): void {
  folder.folders.sort((a, b) => a.name.localeCompare(b.name));
  folder.files.sort((a, b) => a.fileName.localeCompare(b.fileName));
  for (const child of folder.folders) sortFolder(child);
}

/** Convenience: the instruction-registry root under a resources dir. */
export function registryRootFor(resourcesDir: string): string {
  return path.join(resourcesDir, "instruction-registry");
}
