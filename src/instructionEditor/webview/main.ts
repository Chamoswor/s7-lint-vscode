// Webview entry point: the Preact app that renders the instruction-registry
// editor (navigation tree + form + validation panel) and speaks the typed
// message protocol to the extension host. Bundled by esbuild for the browser
// (see the bundle:webview npm script); never compiled by the host tsc build.
import { render } from "preact";
import { html, useEffect, useMemo, useRef, useState } from "./h";
import { STYLES } from "./styles";
import { EntryForm } from "./form";
import { SystemTypeForm } from "./systemTypeForm";
import type { EditorSnapshot, EntryData, FileStatus, HostToWebview, SystemTypeData, WebviewToHost } from "../messages";
import type { FolderNode, FileNode } from "../registryIndex";
import type { ValidationFinding } from "../validation";

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
  getState(): unknown;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();
const post = (m: WebviewToHost) => vscode.postMessage(m);

function App() {
  const [snapshot, setSnapshot] = useState<EditorSnapshot | null>(null);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [entry, setEntry] = useState<EntryData | null>(null);
  const [sysType, setSysType] = useState<SystemTypeData | null>(null);
  const [sysTypesOpen, setSysTypesOpen] = useState(false);
  /** Instruction to return to after a quick-add jumped into the type view. */
  const [backToEntry, setBackToEntry] = useState<{ uid: string; name: string } | null>(null);
  const [fileStatus, setFileStatus] = useState<FileStatus[]>([]);
  const [findings, setFindings] = useState<ValidationFinding[]>([]);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [problemsOpen, setProblemsOpen] = useState(true);
  const [toast, setToast] = useState<{ level: string; message: string } | null>(null);
  const [dialog, setDialog] = useState<DialogConfig | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [externalChanges, setExternalChanges] = useState<string[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [drop, setDrop] = useState<{ file: string; index: number; into: boolean } | null>(null);
  const dragRef = useRef<string[]>([]);
  const lastClickRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedUid;

  useEffect(() => {
    const onMsg = (ev: MessageEvent<HostToWebview>) => {
      const m = ev.data;
      switch (m.type) {
        case "init":
          setSnapshot(m.snapshot);
          setFileStatus(m.snapshot.fileStatus);
          setFindings(m.snapshot.findings);
          setCanUndo(m.snapshot.canUndo);
          setCanRedo(m.snapshot.canRedo);
          // uids change after reload/undo; drop stale selection (a structural
          // op that wants to keep an entry selected follows with `openEntry`).
          setEntry(null);
          setSelectedUid(null);
          setSelection(new Set());
          setSysType(null);
          break;
        case "entryData":
          if (m.entry.uid === selectedRef.current) setEntry(m.entry);
          break;
        case "openEntry":
          setSelectedUid(m.entry.uid);
          setEntry(m.entry);
          setSysType(null);
          break;
        case "systemTypeData":
          setSysType(m.data);
          // Mirror of selectEntry: entering the type view clears the
          // instruction selection so the two panes never fight.
          setEntry(null);
          setSelectedUid(null);
          break;
        case "openSystemType":
          // Quick-add from the "unknown system type" warning lands here: show
          // the new type so its seeded members can be reviewed immediately.
          // Remember where we came from so there's a one-click way back.
          setEntry((cur) => { if (cur) setBackToEntry({ uid: cur.uid, name: cur.name }); return null; });
          setSysType(m.data);
          setSelectedUid(null);
          setSysTypesOpen(true);
          break;
        case "status":
          setFileStatus(m.fileStatus);
          setFindings(m.findings);
          setCanUndo(m.canUndo);
          setCanRedo(m.canRedo);
          break;
        case "externallyChanged":
          setExternalChanges(m.relPaths);
          break;
        case "saved":
          if (m.savedFiles.length) setExternalChanges([]);
          break;
        case "toast":
          setToast({ level: m.level, message: m.message });
          break;
      }
    };
    window.addEventListener("message", onMsg);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Keyboard: Ctrl/Cmd+Z undo, Ctrl+Shift+Z / Ctrl+Y redo, Ctrl/Cmd+S save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); post({ type: "undo" }); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); post({ type: "redo" }); }
      else if (k === "s") { e.preventDefault(); post({ type: "save" }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const statusByFile = useMemo(() => {
    const m = new Map<string, FileStatus>();
    for (const s of fileStatus) m.set(s.relPath, s);
    return m;
  }, [fileStatus]);
  const dirtyCount = fileStatus.filter((s) => s.dirty).length;
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warnCount = findings.length - errorCount;

  function selectEntry(uid: string): void {
    setSelectedUid(uid);
    // Leave the system-type view: the editor pane prefers `sysType`, so
    // without this, picking an instruction would keep showing the type form.
    setSysType(null);
    setBackToEntry(null);
    post({ type: "selectEntry", uid });
  }
  function toggle(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function expand(id: string): void {
    setExpanded((prev) => new Set(prev).add(id));
  }

  const allFileRelPaths = useMemo(() => {
    const out: string[] = [];
    if (snapshot) (function c(f: FolderNode) { f.files.forEach((x) => out.push(x.relPath)); f.folders.forEach(c); })(snapshot.tree);
    return out.sort();
  }, [snapshot]);
  const allFolderRelPaths = useMemo(() => {
    const out: string[] = [""];
    if (snapshot) (function c(f: FolderNode) { f.folders.forEach((x) => { out.push(x.relPath); c(x); }); })(snapshot.tree);
    return out.sort();
  }, [snapshot]);

  // Maps used by drag-and-drop: which file each entry uid lives in, and each
  // file's ordered uid list. Rebuilt whenever the tree (snapshot) changes.
  const { uidFile, fileOrder } = useMemo(() => {
    const uf = new Map<string, string>();
    const fo = new Map<string, string[]>();
    if (snapshot) (function c(f: FolderNode) {
      f.files.forEach((file) => { fo.set(file.relPath, file.entries.map((e) => e.id)); file.entries.forEach((e) => uf.set(e.id, file.relPath)); });
      f.folders.forEach(c);
    })(snapshot.tree);
    return { uidFile: uf, fileOrder: fo };
  }, [snapshot]);

  // --- multi-select on entry rows ---
  function onEntryClick(uid: string, e: MouseEvent, fileRel: string): void {
    if (e.ctrlKey || e.metaKey) {
      setSelection((prev) => { const n = new Set(prev); n.has(uid) ? n.delete(uid) : n.add(uid); return n; });
      lastClickRef.current = uid;
      return;
    }
    if (e.shiftKey && lastClickRef.current && uidFile.get(lastClickRef.current) === fileRel) {
      const order = fileOrder.get(fileRel) ?? [];
      const a = order.indexOf(lastClickRef.current);
      const b = order.indexOf(uid);
      if (a >= 0 && b >= 0) { setSelection(new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1))); return; }
    }
    setSelection(new Set([uid]));
    lastClickRef.current = uid;
    selectEntry(uid);
  }

  // --- drag-and-drop ---
  const dnd = {
    onDragStart: (uid: string, e: DragEvent): void => {
      const uids = selection.has(uid) && selection.size > 0 ? [...selection] : [uid];
      if (!selection.has(uid)) setSelection(new Set([uid]));
      dragRef.current = uids;
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", uids.join(",")); }
    },
    onDragEnd: (): void => { dragRef.current = []; setDrop(null); },
    onDragOverEntry: (fileRel: string, index: number, e: DragEvent): void => {
      if (dragRef.current.length === 0) return;
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      const rect = el.getBoundingClientRect();
      const after = e.clientY - rect.top > rect.height / 2;
      setDrop({ file: fileRel, index: index + (after ? 1 : 0), into: false });
    },
    onDragOverFile: (fileRel: string, count: number, e: DragEvent): void => {
      if (dragRef.current.length === 0) return;
      e.preventDefault();
      setDrop({ file: fileRel, index: count, into: true });
    },
    onDrop: (e: DragEvent): void => { e.preventDefault(); performDrop(); },
  };

  function performDrop(): void {
    const target = drop;
    const uids = dragRef.current;
    dragRef.current = [];
    if (!target || uids.length === 0) { setDrop(null); return; }
    const srcFiles = new Set(uids.map((u) => uidFile.get(u)));
    if (srcFiles.size === 1 && [...srcFiles][0] === target.file) {
      // Within-file reorder: compute the full new order and send it.
      const cur = fileOrder.get(target.file) ?? [];
      const moving = new Set(uids);
      const without = cur.filter((u) => !moving.has(u));
      const removedBefore = cur.slice(0, target.index).filter((u) => moving.has(u)).length;
      const idx = Math.max(0, target.index - removedBefore);
      const newOrder = [...without.slice(0, idx), ...uids, ...without.slice(idx)];
      post({ type: "reorderFile", relPath: target.file, orderedUids: newOrder });
    } else {
      post({ type: "moveEntries", uids, targetRelPath: target.file, index: target.into ? undefined : target.index });
    }
    setDrop(null);
    setSelection(new Set());
  }

  // Tree row actions -- each opens a dialog for names, or posts directly.
  const actions: TreeActions = {
    newFolder: (parent) => setDialog({ title: "New folder", label: "Folder name", value: "", placeholder: "e.g. 15-custom", onOk: (name) => post({ type: "createFolder", parentRelPath: parent, name }) }),
    newFile: (folder) => setDialog({ title: "New YAML file", label: "File name (language encoded in name, e.g. SCL-…)", value: "", placeholder: "e.g. SCL-my-family.yaml", onOk: (fileName) => { post({ type: "createFile", folderRelPath: folder, fileName }); expand(folder); } }),
    deleteFolder: (relPath) => post({ type: "deleteFolder", relPath }),
    renameFile: (relPath, current) => setDialog({ title: "Rename file", label: "New file name", value: current, onOk: (newName) => post({ type: "renameFile", relPath, newName }) }),
    deleteFile: (relPath) => post({ type: "deleteFile", relPath }),
    moveFile: (relPath) => setDialog({ title: "Move file to folder", label: "Target folder", value: "", kind: "select", options: allFolderRelPaths.map((f) => ({ value: f, label: f === "" ? "(root)" : f })), onOk: (targetFolderRelPath) => post({ type: "moveFile", relPath, targetFolderRelPath }) }),
    previewDiff: (relPath) => post({ type: "previewDiff", relPath }),
    newEntry: (fileRelPath) => setDialog({ title: "New instruction", label: "Instruction name (identifier)", value: "", placeholder: "e.g. MY_INSTR", onOk: (name) => { post({ type: "createEntry", targetRelPath: fileRelPath, name }); expand(fileRelPath); } }),
    duplicateEntry: (uid) => post({ type: "duplicateEntry", uid }),
    deleteEntry: (uid) => post({ type: "deleteEntry", uid }),
    moveEntry: (uid) => setDialog({ title: "Move instruction to file", label: "Target file", value: "", kind: "select", options: allFileRelPaths.map((f) => ({ value: f })), onOk: (targetRelPath) => post({ type: "moveEntry", uid, targetRelPath }) }),
  };

  if (!snapshot) return html`<div style="padding:20px">Loading instruction registry…</div>`;

  return html`
    <div class="app">
      <div class="toolbar">
        <span class="title">📘 ${snapshot.registryRootLabel}</span>
        <span class=${"stat" + (errorCount ? " err" : "")}>${errorCount} error${errorCount === 1 ? "" : "s"}</span>
        <span class="stat">${warnCount} warning${warnCount === 1 ? "" : "s"}</span>
        ${dirtyCount > 0 && html`<span class="stat dirty">● ${dirtyCount} unsaved file${dirtyCount === 1 ? "" : "s"}</span>`}
        <span class="spacer"></span>
        <button class="ghost" title="Undo (Ctrl+Z)" disabled=${!canUndo} onClick=${() => post({ type: "undo" })}>↶ Undo</button>
        <button class="ghost" title="Redo (Ctrl+Shift+Z)" disabled=${!canRedo} onClick=${() => post({ type: "redo" })}>↷ Redo</button>
        <button disabled=${dirtyCount === 0} onClick=${() => post({ type: "save" })}>Save all</button>
        <button class="secondary" disabled=${dirtyCount === 0} onClick=${() => post({ type: "revertAll" })}>Revert</button>
      </div>

      ${externalChanges.length > 0 &&
      html`<div class="banner">
        ⚠ ${externalChanges.length} file(s) changed on disk outside the editor (${externalChanges.slice(0, 3).join(", ")}${externalChanges.length > 3 ? "…" : ""}).
        Saving will not overwrite them.
        <button class="ghost" onClick=${() => post({ type: "revertAll" })}>Reload from disk</button>
        <button class="ghost" onClick=${() => setExternalChanges([])}>Dismiss</button>
      </div>`}

      <div class="nav">
        <div class="navbar">
          <button class="ghost" onClick=${() => actions.newFolder("")}>+ Folder</button>
          <button class="ghost" onClick=${() => actions.newFile("")}>+ File</button>
        </div>
        <div class="search"><input type="search" placeholder="Filter instructions…" value=${filter}
          onInput=${(e: any) => setFilter(e.target.value)} /></div>
        <div class="tree">
          ${TreeFolder({ node: snapshot.tree, depth: 0, expanded, toggle, statusByFile, selectedUid, selection, onEntryClick, selectEntry, filter, actions, dnd, drop, reveal: (rel: string) => post({ type: "revealFile", relPath: rel }) })}

          ${SystemTypesSection({
            names: snapshot.systemTypes.names,
            dirty: snapshot.systemTypes.dirty,
            missingCount: snapshot.systemTypes.missing.length,
            open: sysTypesOpen || !!filter,
            toggle: () => setSysTypesOpen(!sysTypesOpen),
            selected: sysType?.name ?? null,
            filter,
            onSelect: (name: string) => post({ type: "selectSystemType", name }),
            onNew: () => setDialog({ title: "New system type", label: "Type name (identifier)", value: "", placeholder: "e.g. R_TRIG", onOk: (name) => post({ type: "createSystemType", name }) }),
            onAddMissing: () => post({ type: "createMissingSystemTypes" }),
            onDiff: () => post({ type: "previewDiff", relPath: "type-registry/system-types.yaml" }),
          })}
        </div>
      </div>

      <div class="editor">
        ${sysType && backToEntry &&
        html`<button class="ghost" style="margin-bottom:10px"
          onClick=${() => selectEntry(backToEntry.uid)}>← Back to ${backToEntry.name}</button>`}
        ${sysType
          ? html`<${SystemTypeForm} data=${sysType} catalog=${snapshot.catalog}
              onField=${(path: any, value: any) => post({ type: "updateSystemTypeField", name: sysType.name, path, value })}
              onDelete=${(path: any) => post({ type: "deleteSystemTypeField", name: sysType.name, path })}
              onRename=${(newName: string) => post({ type: "renameSystemType", name: sysType.name, newName })}
              onRemove=${() => post({ type: "deleteSystemType", name: sysType.name })} />`
          : entry
          ? html`<${EntryForm} entry=${entry} catalog=${snapshot.catalog}
              onField=${(path: any, value: any) => post({ type: "updateField", uid: entry.uid, path, value })}
              onDelete=${(path: any) => post({ type: "deleteField", uid: entry.uid, path })}
              onRename=${(newName: string) => post({ type: "renameEntry", uid: entry.uid, newName })}
              onAddSystemType=${(typeName: string) => post({ type: "createSystemTypeForInstruction", uid: entry.uid, typeName })} />`
          : html`<div class="empty">Select an instruction from the tree to edit it.</div>`}
      </div>

      ${ProblemsPanel({ open: problemsOpen, setOpen: setProblemsOpen, findings, selectEntry, reveal: (rel: string) => post({ type: "revealFile", relPath: rel }) })}

      ${toast && html`<div class=${"toast " + toast.level}>${toast.message}</div>`}
      ${dialog && html`<${Dialog} config=${dialog} onClose=${() => setDialog(null)} />`}
    </div>
  `;
}

// --- dialog -------------------------------------------------------------
interface DialogConfig {
  title: string;
  label: string;
  value: string;
  placeholder?: string;
  kind?: "text" | "select";
  options?: { value: string; label?: string }[];
  onOk: (value: string) => void;
}
function Dialog(props: { config: DialogConfig; onClose: () => void }) {
  const { config, onClose } = props;
  const [value, setValue] = useState(config.value);
  const submit = () => {
    const v = (config.kind === "select" ? value || (config.options?.[0]?.value ?? "") : value.trim());
    if (config.kind !== "select" && v === "") return;
    config.onOk(v);
    onClose();
  };
  return html`<div class="overlay" onClick=${onClose}>
    <div class="dialog" onClick=${(e: any) => e.stopPropagation()}>
      <h3>${config.title}</h3>
      <label>${config.label}</label>
      ${config.kind === "select"
        ? html`<select value=${value} onChange=${(e: any) => setValue(e.target.value)}>
            ${(config.options ?? []).map((o) => html`<option value=${o.value}>${o.label ?? o.value}</option>`)}
          </select>`
        : html`<input type="text" autofocus placeholder=${config.placeholder ?? ""} value=${value}
            onInput=${(e: any) => setValue(e.target.value)}
            onKeyDown=${(e: any) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }} />`}
      <div class="buttons">
        <button class="secondary" onClick=${onClose}>Cancel</button>
        <button onClick=${submit}>OK</button>
      </div>
    </div>
  </div>`;
}

// --- navigation tree ----------------------------------------------------
interface TreeActions {
  newFolder: (parentRelPath: string) => void;
  newFile: (folderRelPath: string) => void;
  deleteFolder: (relPath: string) => void;
  renameFile: (relPath: string, current: string) => void;
  deleteFile: (relPath: string) => void;
  moveFile: (relPath: string) => void;
  previewDiff: (relPath: string) => void;
  newEntry: (fileRelPath: string) => void;
  duplicateEntry: (uid: string) => void;
  deleteEntry: (uid: string) => void;
  moveEntry: (uid: string) => void;
}
interface DndCtx {
  onDragStart: (uid: string, e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOverEntry: (fileRel: string, index: number, e: DragEvent) => void;
  onDragOverFile: (fileRel: string, count: number, e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}
interface TreeCtx {
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
  statusByFile: Map<string, FileStatus>;
  selectedUid: string | null;
  selection: Set<string>;
  onEntryClick: (uid: string, e: MouseEvent, fileRel: string) => void;
  selectEntry: (uid: string) => void;
  filter: string;
  actions: TreeActions;
  reveal: (rel: string) => void;
  dnd: DndCtx;
  drop: { file: string; index: number; into: boolean } | null;
}

/** Small hover action button; stops propagation so the row's own click
 * (toggle/select) doesn't also fire. */
function act(label: string, title: string, fn: () => void): any {
  return html`<button title=${title} onClick=${(e: MouseEvent) => { e.stopPropagation(); fn(); }}>${label}</button>`;
}

function matchFilter(name: string, filter: string): boolean {
  return !filter || name.toLowerCase().includes(filter.toLowerCase());
}

function TreeFolder(props: { node: FolderNode } & TreeCtx): any {
  const { node, depth, expanded, toggle, filter, actions } = props;
  const isRoot = node.relPath === "";
  const open = isRoot || expanded.has(node.id) || !!filter;
  // Hide folders with no matching descendants when filtering.
  if (filter && !folderHasMatch(node, filter)) return null;
  const empty = node.folders.length === 0 && node.files.length === 0;
  return html`
    ${!isRoot &&
    html`<div class="row" style=${indent(depth)} onClick=${() => toggle(node.id)}>
      <span class="twist">${open ? "▾" : "▸"}</span><span class="icon">📁</span>
      <span class="label">${node.name}</span>
      <span class="actions">
        ${act("＋file", "New file in this folder", () => actions.newFile(node.relPath))}
        ${act("＋dir", "New subfolder", () => actions.newFolder(node.relPath))}
        ${empty ? act("✕", "Delete empty folder", () => actions.deleteFolder(node.relPath)) : ""}
      </span>
    </div>`}
    ${open &&
    html`<div>
      ${node.folders.map((f) => TreeFolder({ ...props, node: f, depth: depth + 1 }))}
      ${node.files.map((f) => TreeFile({ ...props, node: f, depth: depth + 1 }))}
    </div>`}
  `;
}

function TreeFile(props: { node: FileNode } & TreeCtx): any {
  const { node, depth, expanded, toggle, statusByFile, selectedUid, selection, onEntryClick, filter, reveal, actions, dnd, drop } = props;
  const matchingEntries = node.entries.filter((e) => matchFilter(e.name, filter));
  if (filter && matchingEntries.length === 0) return null;
  const open = expanded.has(node.id) || !!filter;
  const st = statusByFile.get(node.relPath);
  const lang = node.fileLanguage?.length ? node.fileLanguage.join("/") : "";
  const fileDropInto = drop && drop.file === node.relPath && drop.into;
  return html`
    <div class=${"row" + (fileDropInto ? " drop-into" : "")} style=${indent(depth)}
      onClick=${() => toggle(node.id)} onDblClick=${() => reveal(node.relPath)}
      onDragOver=${(e: DragEvent) => dnd.onDragOverFile(node.relPath, node.entries.length, e)}
      onDrop=${dnd.onDrop}>
      <span class="twist">${open ? "▾" : "▸"}</span><span class="icon">📄</span>
      <span class="label">${node.fileName}</span>
      ${lang && html`<span class="lang-tag">${lang}</span>`}
      ${st?.dirty && html`<span class="badge dot" title="unsaved changes">●</span>`}
      ${st && st.errorCount > 0 && html`<span class="badge err" title="errors">${st.errorCount}</span>`}
      ${st && st.warningCount > 0 && !st.errorCount && html`<span class="badge warn" title="warnings">${st.warningCount}</span>`}
      <span class="actions">
        ${act("＋", "New instruction in this file", () => actions.newEntry(node.relPath))}
        ${st?.dirty ? act("±", "Preview unsaved diff", () => actions.previewDiff(node.relPath)) : ""}
        ${act("✎", "Rename file", () => actions.renameFile(node.relPath, node.fileName))}
        ${act("⇄", "Move file to another folder", () => actions.moveFile(node.relPath))}
        ${act("✕", "Delete file", () => actions.deleteFile(node.relPath))}
      </span>
    </div>
    ${open &&
    matchingEntries.map((e, i) => {
      const isDrop = drop && drop.file === node.relPath && !drop.into;
      const cls =
        "row mono-row" +
        (e.id === selectedUid ? " selected" : "") +
        (selection.has(e.id) && e.id !== selectedUid ? " multiselected" : "") +
        (isDrop && drop!.index === i ? " drop-before" : "") +
        (isDrop && drop!.index === i + 1 ? " drop-after" : "");
      return html`<div class=${cls} style=${indent(depth + 1)} draggable=${true}
        onClick=${(ev: MouseEvent) => onEntryClick(e.id, ev, node.relPath)}
        onDragStart=${(ev: DragEvent) => dnd.onDragStart(e.id, ev)}
        onDragEnd=${dnd.onDragEnd}
        onDragOver=${(ev: DragEvent) => dnd.onDragOverEntry(node.relPath, i, ev)}
        onDrop=${dnd.onDrop}>
        <span class="twist"></span><span class="icon">▪</span><span class="label mono">${e.name}</span>
        <span class="actions">
          ${act("⧉", "Duplicate", () => actions.duplicateEntry(e.id))}
          ${act("⇄", "Move to another file", () => actions.moveEntry(e.id))}
          ${act("✕", "Delete", () => actions.deleteEntry(e.id))}
        </span>
      </div>`;
    })}
  `;
}

/** Nav section for the editable external registry
 * (type-registry/system-types.yaml). Rendered after the instruction tree so
 * the two registries stay visually distinct -- they have different schemas. */
function SystemTypesSection(p: {
  names: string[];
  dirty: boolean;
  missingCount: number;
  open: boolean;
  toggle: () => void;
  selected: string | null;
  filter: string;
  onSelect: (name: string) => void;
  onNew: () => void;
  onAddMissing: () => void;
  onDiff: () => void;
}): any {
  const matching = p.names.filter((n) => matchFilter(n, p.filter));
  if (p.filter && matching.length === 0) return null;
  return html`
    <div class="row" style=${indent(0)} onClick=${p.toggle}>
      <span class="twist">${p.open ? "▾" : "▸"}</span><span class="icon">🧩</span>
      <span class="label">system-types.yaml</span>
      <span class="lang-tag">type-registry</span>
      ${p.dirty && html`<span class="badge dot" title="unsaved changes">●</span>`}
      ${p.missingCount > 0 &&
      html`<span class="badge warn" title=${`${p.missingCount} referenced type(s) are not catalogued`}>${p.missingCount} missing</span>`}
      <span class="actions">
        ${p.missingCount > 0 ? act("⚡all", `Add all ${p.missingCount} missing system types (review first)`, p.onAddMissing) : ""}
        ${act("＋", "New system type", p.onNew)}
        ${p.dirty ? act("±", "Preview unsaved diff", p.onDiff) : ""}
      </span>
    </div>
    ${p.open &&
    matching.map(
      (name) => html`<div class=${"row" + (name === p.selected ? " selected" : "")} style=${indent(1)}
        onClick=${() => p.onSelect(name)}>
        <span class="twist"></span><span class="icon">▪</span><span class="label mono">${name}</span>
      </div>`
    )}
  `;
}

function folderHasMatch(node: FolderNode, filter: string): boolean {
  return (
    node.files.some((f) => f.entries.some((e) => matchFilter(e.name, filter))) ||
    node.folders.some((f) => folderHasMatch(f, filter))
  );
}
function indent(depth: number): string {
  return `padding-left:${6 + depth * 12}px`;
}

// --- problems panel -----------------------------------------------------
function ProblemsPanel(props: {
  open: boolean;
  setOpen: (v: boolean) => void;
  findings: ValidationFinding[];
  selectEntry: (uid: string) => void;
  reveal: (rel: string) => void;
}) {
  const { open, setOpen, findings, selectEntry, reveal } = props;
  const errors = findings.filter((f) => f.severity === "error").length;
  return html`<div class="problems">
    <div class="head" onClick=${() => setOpen(!open)}>
      <span>${open ? "▾" : "▸"}</span><strong>Problems</strong>
      <span class="stat">${errors} error${errors === 1 ? "" : "s"}, ${findings.length - errors} warning${findings.length - errors === 1 ? "" : "s"}</span>
    </div>
    ${open &&
    html`<div class="list">
      ${findings.length === 0 && html`<div class="item"><span class="msg">No problems 🎉</span></div>`}
      ${findings.slice(0, 500).map(
        (f) => html`<div class="item" onClick=${() => (f.entryUid ? selectEntry(f.entryUid) : f.file && reveal(f.file))}>
          <span class=${"sev " + f.severity}>${f.severity === "error" ? "⛔" : "⚠"}</span>
          <span class="loc mono">${f.file}${f.entry ? " › " + f.entry : ""}${f.fieldPath ? " › " + f.fieldPath : ""}</span>
          <span class="msg">${f.message}</span>
        </div>`
      )}
    </div>`}
  </div>`;
}

// --- boot ---------------------------------------------------------------
const styleEl = document.createElement("style");
styleEl.textContent = STYLES;
document.head.appendChild(styleEl);
const root = document.getElementById("root")!;
root.innerHTML = "";
render(html`<${App} />`, root);
