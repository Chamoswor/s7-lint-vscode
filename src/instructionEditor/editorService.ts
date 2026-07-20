// Host-side orchestration for the instruction-registry editor: owns the loaded
// workspace, the option catalog and the validation context, and exposes the
// operations the webview panel calls (snapshot, read entry, edit field, rename,
// save, revert). Deliberately vscode-free -- panel.ts adds the VS Code webview
// wiring on top -- so this whole layer is unit-testable under Node.
import * as fs from "fs";
import * as path from "path";
import { atomicWriteFile, fileChangedOnDisk } from "./atomicSave";
import { OptionCatalog, loadOptionCatalog } from "./externalRegistries";
import {
  KNOWN_SYSTEM_TYPE_FIELDS,
  SystemTypeMemberDraft,
  SystemTypesFile,
  buildSystemAlias,
  buildSystemStruct,
  membersFromInstructionPins,
} from "./systemTypes";
import { validateSystemType } from "./validation";
import {
  EditorSnapshot,
  EntryData,
  FileStatus,
  MissingSystemType,
  MissingTypeSource,
  SerializableCatalog,
  SystemTypeData,
} from "./messages";
import { RegistryWorkspace, registryRootFor } from "./registryIndex";
import { EXTERNAL_REGISTRY_FILES, isSclFile } from "./registryPaths";
import { CALL_SHAPES, CONFIDENCE_LEVELS, KNOWN_ENTRY_FIELDS, PIN_DIRS, TEMPLATE_SHAPES } from "./schemaEnums";
import { ValidationContext, ValidationFinding, validateEntry } from "./validation";
import { contextForWorkspace, validateWorkspace } from "./validateWorkspace";
import { RegistryDocument } from "./yamlDocument";
import { parseDocument } from "yaml";

const LANGUAGES = ["LAD", "FBD", "SCL"];

export interface SaveResult {
  savedFiles: string[];
  failed: { relPath: string; message: string }[];
}

const UNDO_LIMIT = 100;

/** A full undo/redo checkpoint: the instruction workspace AND the editable
 * system-types file, so undo restores both together. */
interface EditorState {
  ws: import("./registryIndex").WorkspaceState;
  sysTypes: { text: string; diskText: string; mtimeMs: number };
}

export class EditorService {
  private ws: RegistryWorkspace;
  private sysTypes: SystemTypesFile;
  private catalog: OptionCatalog;
  private ctx: ValidationContext;
  private undoStack: EditorState[] = [];
  private redoStack: EditorState[] = [];

  constructor(private readonly resourcesDir: string) {
    this.ws = RegistryWorkspace.load(registryRootFor(resourcesDir));
    this.sysTypes = SystemTypesFile.load(resourcesDir);
    this.catalog = this.buildCatalog();
    this.ctx = contextForWorkspace(this.ws, this.catalog);
  }

  /** Build the option catalog from BUFFERED system types, so a type the user
   * just added counts as "known" for validation/dropdowns before Save. */
  private buildCatalog(): OptionCatalog {
    return loadOptionCatalog(this.resourcesDir, { systemTypes: this.sysTypes.toRegistry() });
  }

  /** Recompute catalog + validation context after a system-types change. */
  private refreshCatalog(): void {
    this.catalog = this.buildCatalog();
    this.ctx = contextForWorkspace(this.ws, this.catalog);
  }

  /** Reload everything from disk (used on revert / external change). Clears
   * undo history since it no longer corresponds to the loaded state. */
  reload(): void {
    this.ws = RegistryWorkspace.load(registryRootFor(this.resourcesDir));
    this.sysTypes = SystemTypesFile.load(this.resourcesDir);
    this.catalog = this.buildCatalog();
    this.ctx = contextForWorkspace(this.ws, this.catalog);
    this.undoStack = [];
    this.redoStack = [];
  }

  private exportEditorState(): EditorState {
    return {
      ws: this.ws.exportState(),
      sysTypes: {
        text: this.sysTypes.isDirty() ? this.sysTypes.toText() : this.sysTypes.diskText(),
        diskText: this.sysTypes.diskText(),
        mtimeMs: this.sysTypes.mtimeMs(),
      },
    };
  }

  private importEditorState(state: EditorState): void {
    this.ws.importState(state.ws);
    this.sysTypes.restore(state.sysTypes.text, state.sysTypes.diskText, state.sysTypes.mtimeMs);
    this.refreshCatalog();
  }

  /** Record the current buffered state before a mutation, so it can be undone.
   * Called at the start of every buffered edit/structural operation. */
  private beginMutation(): void {
    this.undoStack.push(this.exportEditorState());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Undo the last buffered operation. Returns false if nothing to undo. */
  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.exportEditorState());
    this.importEditorState(prev);
    return true;
  }

  /** Redo the last undone operation. Returns false if nothing to redo. */
  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.exportEditorState());
    this.importEditorState(next);
    return true;
  }

  workspace(): RegistryWorkspace {
    return this.ws;
  }

  snapshot(): EditorSnapshot {
    const status = this.status();
    return {
      registryRootLabel: path.basename(registryRootFor(this.resourcesDir)),
      tree: this.ws.buildTree(),
      catalog: this.serializeCatalog(),
      findings: status.findings,
      fileStatus: status.fileStatus,
      hasErrors: status.hasErrors,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      systemTypes: this.systemTypesInfo(),
    };
  }

  private serializeCatalog(): SerializableCatalog {
    const families = new Set<string>(this.ctx.familySet);
    return {
      memoryAreas: this.catalog.memoryAreas,
      declarationSections: this.catalog.declarationSections,
      resultKinds: this.catalog.resultKinds,
      resultInferenceRules: this.catalog.resultInferenceRules,
      resultTransforms: this.catalog.resultTransforms,
      resultUsageContexts: this.catalog.resultUsageContexts,
      dataTypeGroups: this.catalog.dataTypeGroups,
      systemTypeNames: [...this.catalog.systemTypeNames].sort(),
      families: [...families].sort(),
      callShapes: [...CALL_SHAPES],
      pinDirs: [...PIN_DIRS],
      confidenceLevels: [...CONFIDENCE_LEVELS],
      templateShapes: [...TEMPLATE_SHAPES],
      languages: LANGUAGES,
    };
  }

  /** Whole-registry validation grouped for the panel + per-file badges. */
  status(): { findings: ValidationFinding[]; fileStatus: FileStatus[]; hasErrors: boolean } {
    const report = validateWorkspace(this.ws, this.ctx);
    const perFile = new Map<string, { e: number; w: number }>();
    for (const rel of this.ws.fileRelPaths()) perFile.set(rel, { e: 0, w: 0 });
    for (const f of report.findings) {
      if (!f.file) continue;
      const rec = perFile.get(f.file) ?? { e: 0, w: 0 };
      if (f.severity === "error") rec.e += 1;
      else rec.w += 1;
      perFile.set(f.file, rec);
    }
    const fileStatus: FileStatus[] = [...perFile.entries()].map(([relPath, rec]) => ({
      relPath,
      dirty: this.ws.document(relPath)?.isDirty() ?? false,
      errorCount: rec.e,
      warningCount: rec.w,
    }));
    return { findings: report.findings, fileStatus, hasErrors: report.errorCount > 0 };
  }

  private locate(uid: string): { doc: RegistryDocument; relPath: string; name: string } | undefined {
    const found = this.ws.findEntry(uid);
    if (!found) return undefined;
    const doc = this.ws.document(found.relPath);
    if (!doc) return undefined;
    return { doc, relPath: found.relPath, name: found.name };
  }

  entryData(uid: string): EntryData | undefined {
    const loc = this.locate(uid);
    if (!loc) return undefined;
    const json = loc.doc.entryJS(uid) ?? {};
    const unknownFields = Object.keys(json).filter((k) => !KNOWN_ENTRY_FIELDS.has(k));
    return {
      uid,
      name: loc.name,
      filePath: loc.relPath,
      json,
      findings: validateEntry(json, this.ctx),
      unknownFields,
    };
  }

  updateField(uid: string, fieldPath: (string | number)[], value: unknown): EntryData | undefined {
    const loc = this.locate(uid);
    if (!loc) return undefined;
    this.beginMutation();
    loc.doc.setEntryField(uid, fieldPath, value);
    return this.entryData(uid);
  }

  deleteField(uid: string, fieldPath: (string | number)[]): EntryData | undefined {
    const loc = this.locate(uid);
    if (!loc) return undefined;
    this.beginMutation();
    loc.doc.deleteEntryField(uid, fieldPath);
    return this.entryData(uid);
  }

  renameEntry(uid: string, newName: string): { ok: boolean; data?: EntryData } {
    const loc = this.locate(uid);
    if (!loc) return { ok: false };
    this.beginMutation();
    const ok = loc.doc.renameEntry(uid, newName);
    if (!ok) this.undoStack.pop(); // no-op: discard the snapshot we just took
    return { ok, data: ok ? this.entryData(uid) : undefined };
  }

  hasDirty(): boolean {
    return this.ws.hasPendingChanges() || this.sysTypes.isDirty();
  }

  // --- system-types.yaml (editable external registry) -------------------

  /** All system type names, unsaved state, and the referenced-but-missing
   * types the bulk "add all" action would create. */
  systemTypesInfo(): { names: string[]; dirty: boolean; missing: MissingSystemType[] } {
    return { names: this.sysTypes.names(), dirty: this.sysTypes.isDirty(), missing: this.findMissingSystemTypes() };
  }

  /** One system type's editable data + its validation findings. */
  systemTypeData(name: string): SystemTypeData | undefined {
    const json = this.sysTypes.entryJS(name);
    if (!json) return undefined;
    return {
      name,
      json,
      findings: validateSystemType(name, json, this.catalog),
      unknownFields: Object.keys(json).filter((k) => !KNOWN_SYSTEM_TYPE_FIELDS.has(k)),
    };
  }

  /** Create a system type. `members` may be pre-filled from an instruction's
   * pins (see createSystemTypeForInstruction). */
  createSystemType(
    name: string,
    opts: {
      category?: string;
      basicDataType?: string;
      description?: string;
      usedByInstructions?: string[];
      members?: SystemTypeMemberDraft[];
      /** Stamp the entry as editor-inferred + unverified (see inferredProvenance). */
      inferred?: boolean;
    } = {}
  ): { ok: boolean; reason?: string; data?: SystemTypeData } {
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ok: false, reason: "Type name must be a valid identifier." };
    if (this.sysTypes.has(name)) return { ok: false, reason: `'${name}' already exists in system-types.yaml.` };
    const entry =
      opts.category === "system-alias"
        ? buildSystemAlias(opts.basicDataType ?? "UInt", { description: opts.description })
        : buildSystemStruct({
            description: opts.description,
            usedByInstructions: opts.usedByInstructions,
            members: opts.members,
            ...(opts.inferred ? inferredProvenance(!!opts.members?.length) : {}),
          });
    this.beginMutation();
    this.sysTypes.add(name, entry);
    this.refreshCatalog();
    return { ok: true, data: this.systemTypeData(name) };
  }

  /** Quick-fix for "instanceType 'X' is not a known system type": create the
   * type, seeding its members from the instruction's own pins so the common
   * case (R_TRIG -> CLK/Q) is one click plus review. */
  createSystemTypeForInstruction(instructionUid: string, typeName?: string): { ok: boolean; reason?: string; data?: SystemTypeData } {
    const entry = this.entryData(instructionUid);
    if (!entry) return { ok: false, reason: "Instruction not found." };
    const name = typeName ?? (typeof entry.json.instanceType === "string" ? entry.json.instanceType : undefined);
    if (!name) return { ok: false, reason: "This instruction has no instanceType to create." };
    const members = membersFromInstructionPins(entry.json);
    return this.createSystemType(name, {
      category: "system-struct",
      description: `Instance structure for ${entry.name}.`,
      usedByInstructions: [entry.name],
      members,
      inferred: members.length > 0,
    });
  }

  updateSystemTypeField(name: string, fieldPath: (string | number)[], value: unknown): SystemTypeData | undefined {
    if (!this.sysTypes.has(name)) return undefined;
    this.beginMutation();
    this.sysTypes.setField(name, fieldPath, value);
    this.refreshCatalog();
    return this.systemTypeData(name);
  }

  deleteSystemTypeField(name: string, fieldPath: (string | number)[]): SystemTypeData | undefined {
    if (!this.sysTypes.has(name)) return undefined;
    this.beginMutation();
    this.sysTypes.deleteField(name, fieldPath);
    this.refreshCatalog();
    return this.systemTypeData(name);
  }

  renameSystemType(name: string, newName: string): { ok: boolean; reason?: string; data?: SystemTypeData } {
    if (!this.sysTypes.has(name)) return { ok: false, reason: "Type not found." };
    if (!newName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return { ok: false, reason: "Type name must be a valid identifier." };
    if (this.sysTypes.has(newName)) return { ok: false, reason: `'${newName}' already exists.` };
    this.beginMutation();
    this.sysTypes.rename(name, newName);
    this.refreshCatalog();
    return { ok: true, data: this.systemTypeData(newName) };
  }

  deleteSystemType(name: string): boolean {
    if (!this.sysTypes.has(name)) return false;
    this.beginMutation();
    const ok = this.sysTypes.remove(name);
    this.refreshCatalog();
    return ok;
  }

  /** Every type name referenced by the instruction registry that isn't
   * catalogued anywhere (not a system type, base type or umbrella label) --
   * i.e. exactly the references the editor flags as unknown.
   *
   * `instanceType` references carry proposed members (from the instruction's
   * own pins); a name seen only in a pin/result `dataTypes` list gets
   * `members: null`, because nothing in the registry says what its fields are.
   * Names that aren't plain identifiers are skipped so a typo like "Bool "
   * or a stray label can't become a bogus type. */
  findMissingSystemTypes(): MissingSystemType[] {
    const known = this.catalog.systemTypeNames;
    const byName = new Map<string, MissingSystemType>();
    const isIdentifier = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
    const isCatalogued = (s: string) =>
      known.has(s) || this.catalog.baseTypeNames.has(s) || this.catalog.umbrellaLabelNames.has(s) || this.catalog.bcdFormatNames.has(s);

    const note = (name: string, instruction: string, members: SystemTypeMemberDraft[], via: MissingTypeSource) => {
      const existing = byName.get(name);
      if (!existing) {
        byName.set(name, { name, usedByInstructions: [instruction], members, sources: [via] });
        return;
      }
      if (!existing.usedByInstructions.includes(instruction)) existing.usedByInstructions.push(instruction);
      if (!existing.sources.includes(via)) existing.sources.push(via);
      // Prefer a members proposal over none (instanceType beats a bare mention).
      if (existing.members.length === 0 && members.length > 0) existing.members = members;
    };

    for (const rel of this.ws.fileRelPaths()) {
      const doc = this.ws.document(rel)!;
      for (const e of doc.entries()) {
        const js = doc.entryJS(e.uid);
        if (!js) continue;
        const instanceType = js.instanceType;
        if (typeof instanceType === "string" && isIdentifier(instanceType) && !isCatalogued(instanceType)) {
          note(instanceType, e.name, membersFromInstructionPins(js), "instanceType");
        }
        const pins = Array.isArray(js.pins) ? js.pins : [];
        for (const p of pins) {
          if (!p || typeof p !== "object") continue;
          const dts = (p as Record<string, unknown>).dataTypes;
          if (!Array.isArray(dts)) continue;
          for (const dt of dts) {
            if (typeof dt !== "string" || dt === "*" || !isIdentifier(dt) || isCatalogued(dt)) continue;
            note(dt, e.name, [], "pinDataType");
          }
        }
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Bulk-create the missing system types (optionally a chosen subset). The
   * whole batch is ONE undo step. Types that already exist are skipped. */
  createMissingSystemTypes(names?: string[]): { created: string[]; skipped: string[] } {
    const wanted = new Set(names ?? []);
    const missing = this.findMissingSystemTypes().filter((m) => !names || wanted.has(m.name));
    const created: string[] = [];
    const skipped: string[] = [];
    if (missing.length === 0) return { created, skipped };
    this.beginMutation();
    for (const m of missing) {
      if (this.sysTypes.has(m.name)) {
        skipped.push(m.name);
        continue;
      }
      const viaInstance = m.sources.includes("instanceType");
      this.sysTypes.add(m.name, buildSystemStruct({
        description: viaInstance ? `Instance structure for ${m.usedByInstructions[0]}.` : "",
        usedByInstructions: m.usedByInstructions,
        members: m.members,
        ...inferredProvenance(m.members.length > 0),
      }));
      created.push(m.name);
    }
    this.refreshCatalog();
    return { created, skipped };
  }

  /** Pending vs. baseline text of system-types.yaml, for diff preview. */
  systemTypesPendingText(): string {
    return this.sysTypes.toText();
  }
  systemTypesAbsPath(): string {
    return this.sysTypes.absPath;
  }

  /** Commit all buffered changes: writes new/edited/renamed files atomically
   * (serialize -> re-parse to confirm valid YAML -> temp-write -> rename),
   * unlinks deleted/old-path files, and updates baselines in place (no reload,
   * so entry uids and the open selection stay stable). A file that fails
   * validation is left untouched on disk and reported in `failed`. */
  save(): SaveResult {
    const savedFiles: string[] = [];
    const failed: { relPath: string; message: string }[] = [];
    for (const f of this.ws.pendingSaveList()) {
      try {
        if (f.deleted) {
          const diskPath = this.ws.absPathFor(f.diskRelPath ?? f.relPath);
          if (!f.isNew && fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
          this.ws.forgetFile(f.relPath);
          savedFiles.push(f.relPath);
          continue;
        }
        if (!f.isNew && !f.dirty && !f.diskRelPath) continue; // unchanged
        // Refuse to clobber a file edited externally since we loaded it.
        if (!f.isNew && this.ws.externallyChanged(f.relPath)) {
          failed.push({ relPath: f.relPath, message: "Changed on disk externally since it was opened -- not overwritten. Revert to reload, or copy your changes out first." });
          continue;
        }
        const text = f.doc.toText();
        fs.mkdirSync(path.dirname(f.absPath), { recursive: true });
        atomicWriteFile(f.absPath, text, (t) => {
          const errs = parseDocument(t).errors;
          return errs.length ? `Produced invalid YAML: ${errs[0].message}` : null;
        });
        // Unlink the previous on-disk path after a rename/move succeeded.
        if (f.diskRelPath && f.diskRelPath !== f.relPath) {
          const old = this.ws.absPathFor(f.diskRelPath);
          if (fs.existsSync(old)) fs.unlinkSync(old);
        }
        this.ws.markSaved(f.relPath, text, fs.statSync(f.absPath).mtimeMs);
        savedFiles.push(f.relPath);
      } catch (err) {
        failed.push({ relPath: f.relPath, message: String(err instanceof Error ? err.message : err) });
      }
    }

    // The editable external registry (system-types.yaml) saves the same way:
    // external-change guard, atomic write, baseline update.
    if (this.sysTypes.isDirty()) {
      const label = EXTERNAL_REGISTRY_FILES.systemTypes;
      try {
        const abs = this.sysTypes.absPath;
        if (fileChangedOnDisk(abs, this.sysTypes.diskText(), this.sysTypes.mtimeMs())) {
          failed.push({ relPath: label, message: "Changed on disk externally since it was opened -- not overwritten." });
        } else {
          const text = this.sysTypes.toText();
          atomicWriteFile(abs, text, (t) => {
            const errs = parseDocument(t).errors;
            return errs.length ? `Produced invalid YAML: ${errs[0].message}` : null;
          });
          this.sysTypes.markSaved(text, fs.statSync(abs).mtimeMs);
          savedFiles.push(label);
        }
      } catch (err) {
        failed.push({ relPath: label, message: String(err instanceof Error ? err.message : err) });
      }
    }
    return { savedFiles, failed };
  }

  // --- Phase 3: create / duplicate / delete / move ----------------------

  /** A minimal, schema-valid entry object (no validation errors). */
  private minimumEntry(family: string, callShape: string): Record<string, unknown> {
    const entry: Record<string, unknown> = {
      family,
      callShape,
      pins: [],
      template: { shape: "none", keys: [], extra: {} },
      confidence: "shape-only",
    };
    if (callShape === "instance-dot" || callShape === "coil-ref") entry.instanceType = null;
    return entry;
  }

  private uniqueName(doc: RegistryDocument, base: string): string {
    if (!doc.hasName(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}_${i}`;
      if (!doc.hasName(candidate)) return candidate;
    }
    return `${base}_${Date.now()}`;
  }

  createEntry(targetRelPath: string, name: string, opts?: { family?: string; callShape?: string }): { ok: boolean; reason?: string; data?: EntryData } {
    const doc = this.ws.document(targetRelPath);
    if (!doc) return { ok: false, reason: `File not found: ${targetRelPath}` };
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ok: false, reason: "Name must be a valid identifier." };
    if (doc.hasName(name)) return { ok: false, reason: `'${name}' already exists in this file.` };
    this.beginMutation();
    const uid = doc.addEntry(name, this.minimumEntry(opts?.family ?? "bit-logic", opts?.callShape ?? "box"));
    return { ok: true, data: this.entryData(uid) };
  }

  duplicateEntry(uid: string): { ok: boolean; reason?: string; data?: EntryData } {
    const loc = this.locate(uid);
    if (!loc) return { ok: false, reason: "Entry not found." };
    const newName = this.uniqueName(loc.doc, `${loc.name}_copy`);
    this.beginMutation();
    const newUid = loc.doc.duplicateEntry(uid, newName);
    if (!newUid) { this.undoStack.pop(); return { ok: false, reason: "Duplicate failed." }; }
    return { ok: true, data: this.entryData(newUid) };
  }

  deleteEntry(uid: string): boolean {
    const loc = this.locate(uid);
    if (!loc) return false;
    this.beginMutation();
    return loc.doc.deleteEntry(uid);
  }

  /** Move an entry into another file (or reorder within one), carrying comments. */
  moveEntry(uid: string, targetRelPath: string, index?: number): { ok: boolean; reason?: string; data?: EntryData } {
    const target = this.ws.document(targetRelPath);
    if (!target) return { ok: false, reason: `File not found: ${targetRelPath}` };
    const loc = this.locate(uid);
    if (loc && loc.relPath !== targetRelPath && target.hasName(loc.name)) {
      return { ok: false, reason: `'${loc.name}' already exists in ${targetRelPath}.` };
    }
    this.beginMutation();
    const movedUid = this.ws.moveEntry(uid, targetRelPath, index);
    if (!movedUid) return { ok: false, reason: "Move failed." };
    return { ok: true, data: this.entryData(movedUid) };
  }

  /** Drag-and-drop move of one or more entries to `targetRelPath`, inserted
   * starting at `index` (append when omitted), preserving the given order.
   * Validates the whole batch up front so a name collision aborts cleanly
   * without a partial move. Returns the (possibly updated) uids in order. */
  moveEntries(uids: string[], targetRelPath: string, index?: number): { ok: boolean; reason?: string; uids?: string[] } {
    const target = this.ws.document(targetRelPath);
    if (!target) return { ok: false, reason: `File not found: ${targetRelPath}` };
    // Pre-flight: every moved entry must have a locatable source, and any
    // cross-file move must not collide with an existing name in the target
    // (ignoring entries already being moved out of the target itself).
    const movingNames = new Set<string>();
    for (const uid of uids) {
      const loc = this.locate(uid);
      if (!loc) return { ok: false, reason: "One of the dragged entries no longer exists." };
      if (loc.relPath !== targetRelPath) {
        if (target.hasName(loc.name)) return { ok: false, reason: `'${loc.name}' already exists in ${targetRelPath}.` };
        if (movingNames.has(loc.name)) return { ok: false, reason: `Two dragged entries are both named '${loc.name}'.` };
        movingNames.add(loc.name);
      }
    }
    // Apply in order. Each insertion advances the target index so the batch
    // keeps its relative order at the drop point.
    this.beginMutation();
    let at = index;
    const out: string[] = [];
    for (const uid of uids) {
      const moved = this.ws.moveEntry(uid, targetRelPath, at);
      if (!moved) return { ok: false, reason: "Move failed mid-batch." };
      out.push(moved);
      if (at != null) at += 1;
    }
    return { ok: true, uids: out };
  }

  /** Reorder a file's entries to the given uid order (within-file DnD). */
  reorderFile(relPath: string, orderedUids: string[]): { ok: boolean; reason?: string } {
    const doc = this.ws.document(relPath);
    if (!doc) return { ok: false, reason: `File not found: ${relPath}` };
    this.beginMutation();
    return { ok: doc.reorderEntries(orderedUids) };
  }

  // --- Phase 3: files & folders -----------------------------------------

  /** Suggest a target file for a new entry of `family`/`isScl`: the existing
   * file that already holds the most entries of that family and matches the
   * SCL/graphical split. Falls back to undefined (caller picks). */
  suggestFileForFamily(family: string, isScl: boolean): string | undefined {
    let best: string | undefined;
    let bestCount = 0;
    for (const rel of this.ws.fileRelPaths()) {
      if (rel.endsWith("/") ) continue;
      const doc = this.ws.document(rel)!;
      if (isSclOf(rel) !== isScl) continue;
      let count = 0;
      for (const e of doc.entries()) {
        const js = doc.entryJS(e.uid);
        if (js && js.family === family) count += 1;
      }
      if (count > bestCount) {
        bestCount = count;
        best = rel;
      }
    }
    return best;
  }

  createFile(folderRelPath: string, fileName: string, fileLanguage?: string[]): { ok: boolean; reason?: string; relPath?: string } {
    let name = fileName.trim();
    if (!name) return { ok: false, reason: "File name required." };
    if (!name.endsWith(".yaml")) name += ".yaml";
    if (!/^[A-Za-z0-9._-]+\.yaml$/.test(name)) return { ok: false, reason: "Invalid file name." };
    const relPath = folderRelPath ? `${folderRelPath}/${name}` : name;
    if (this.ws.fileExistsInWorkspace(relPath) || fs.existsSync(this.ws.absPathFor(relPath))) {
      return { ok: false, reason: `File already exists: ${relPath}` };
    }
    // Repo files use CRLF; new files match so they don't stand out in diffs.
    const nl = "\r\n";
    let text = `# ${name.replace(/\.yaml$/, "")} instruction registry.${nl}`;
    if (fileLanguage && fileLanguage.length) text += `$fileLanguage: [${fileLanguage.join(", ")}]${nl}`;
    this.beginMutation();
    this.ws.createFile(relPath, text);
    return { ok: true, relPath };
  }

  deleteFile(relPath: string): boolean {
    if (!this.ws.fileExistsInWorkspace(relPath)) return false;
    this.beginMutation();
    return this.ws.markFileDeleted(relPath);
  }

  /** Rename a file within its folder (buffered). */
  renameFile(relPath: string, newName: string): { ok: boolean; reason?: string; relPath?: string } {
    let name = newName.trim();
    if (!name.endsWith(".yaml")) name += ".yaml";
    if (!/^[A-Za-z0-9._-]+\.yaml$/.test(name)) return { ok: false, reason: "Invalid file name." };
    const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
    const newRelPath = dir ? `${dir}/${name}` : name;
    if (newRelPath === relPath) return { ok: true, relPath };
    this.beginMutation();
    if (!this.ws.renameFile(relPath, newRelPath)) { this.undoStack.pop(); return { ok: false, reason: `Cannot rename to ${name} (target exists?).` }; }
    return { ok: true, relPath: newRelPath };
  }

  /** Move a file into another folder (buffered). */
  moveFile(relPath: string, targetFolderRelPath: string): { ok: boolean; reason?: string; relPath?: string } {
    const name = relPath.slice(relPath.lastIndexOf("/") + 1);
    const newRelPath = targetFolderRelPath ? `${targetFolderRelPath}/${name}` : name;
    if (newRelPath === relPath) return { ok: true, relPath };
    this.beginMutation();
    if (!this.ws.renameFile(relPath, newRelPath)) { this.undoStack.pop(); return { ok: false, reason: `Target already has ${name}.` }; }
    return { ok: true, relPath: newRelPath };
  }

  /** Create a folder immediately on disk (containers carry no data-loss risk). */
  createFolder(parentRelPath: string, name: string): { ok: boolean; reason?: string; relPath?: string } {
    const clean = name.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(clean)) return { ok: false, reason: "Invalid folder name." };
    const relPath = parentRelPath ? `${parentRelPath}/${clean}` : clean;
    const abs = this.ws.absPathFor(relPath);
    if (fs.existsSync(abs)) return { ok: false, reason: `Folder already exists: ${relPath}` };
    fs.mkdirSync(abs, { recursive: true });
    return { ok: true, relPath };
  }

  /** Delete an EMPTY folder immediately (guards against data loss: any file
   * still under it -- on disk or buffered -- blocks the delete). */
  deleteFolder(relPath: string): { ok: boolean; reason?: string } {
    const prefix = relPath + "/";
    if (this.ws.fileRelPaths().some((r) => r.startsWith(prefix))) {
      return { ok: false, reason: "Folder is not empty (move or delete its files first)." };
    }
    const abs = this.ws.absPathFor(relPath);
    try {
      if (fs.existsSync(abs)) fs.rmdirSync(abs);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `Could not delete folder: ${String(err instanceof Error ? err.message : err)}` };
    }
  }

  /** Absolute path for a registry-relative file path. */
  absPathFor(relPath: string): string {
    return this.ws.absPathFor(relPath);
  }

  fileExists(relPath: string): boolean {
    return fs.existsSync(this.absPathFor(relPath));
  }

  /** Current (buffered) serialized text of a file, for diff preview. */
  pendingText(relPath: string): string | undefined {
    return this.ws.document(relPath)?.toText();
  }

  /** On-disk baseline text captured at load, for diff preview. */
  baselineText(relPath: string): string | undefined {
    return this.ws.diskText(relPath);
  }

  /** relPaths of loaded files changed on disk externally since load. */
  externalChanges(): string[] {
    return this.ws.externallyChangedFiles();
  }
}

/**
 * Provenance stamp for types the editor INFERRED rather than transcribed.
 *
 * system-types.yaml's own header states that `members` stays null until mapped
 * from a real TIA Portal reference, and the registry README's rule is to record
 * only evidence-backed facts. Members derived from an instruction's pins are a
 * useful starting point but are NOT that evidence: an instance struct can carry
 * internal state a pin list never shows (R_TRIG's `Stat_Bit`, for example), and
 * pin spelling/casing can differ from member names. So every inferred entry
 * says so in `source`/`notes` -- keeping the file honest and making the
 * unverified ones trivially greppable.
 */
function inferredProvenance(hasInferredMembers: boolean): { confidence: string; source: string } & { notes?: string } {
  return {
    confidence: "shape-only",
    source: "inferred by the instruction-registry editor -- NOT verified against a TIA reference",
    notes: hasInferredMembers
      ? "Members were inferred from the referencing instruction's pins and are UNVERIFIED: an instance struct may contain additional internal members (e.g. edge-detector state bits) and member spelling may differ. Verify against a TIA Portal Interface-editor/instance-DB export before relying on this."
      : "Referenced by the instruction registry but not yet catalogued; members not established (see this file's header) -- transcribe them from a TIA Portal reference.",
  };
}

function isSclOf(relPath: string): boolean {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  return isSclFile(name);
}
