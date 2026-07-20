// Editable view of resources/type-registry/system-types.yaml.
//
// This file was originally a READ-ONLY input to the editor, but authoring an
// instruction whose `instanceType` (or a pin `dataTypes` entry) names a system
// type that isn't catalogued yet is a dead end otherwise: the editor flags
// "not a known system type" with no way to fix it. So system-types.yaml is now
// a first-class editable document, using the SAME comment-preserving
// RegistryDocument machinery as the instruction files (it is likewise a
// top-level mapping of name -> entry, so RegistryDocument works unchanged).
//
// It is deliberately kept SEPARATE from RegistryWorkspace: the instruction
// registry is a folder tree of many files, whereas this is one fixed file in a
// different registry, with its own schema and its own validation rules.
import * as fs from "fs";
import * as path from "path";
import { SystemTypeRegistry } from "../rules/types";
import { EXTERNAL_REGISTRY_FILES } from "./registryPaths";
import { RegistryDocument } from "./yamlDocument";

/** The two shapes system-types.yaml documents under `category`. */
export const SYSTEM_TYPE_CATEGORIES = ["system-struct", "system-alias"] as const;

/** Fields the editor understands on a system-type entry; anything else is
 * preserved verbatim (same discipline as instruction entries). */
export const KNOWN_SYSTEM_TYPE_FIELDS = new Set<string>([
  "sizeBytes",
  "category",
  "description",
  "basicDataType",
  "usedByInstructions",
  "members",
  "confidence",
  "source",
  "notes",
]);

export interface SystemTypeMemberDraft {
  name: string;
  /** Elementary/system type name for a `{ kind: named, name: X }` TypeRef. */
  typeName: string;
}

export class SystemTypesFile {
  private doc: RegistryDocument;
  private diskTextValue: string;
  private mtimeMsValue: number;
  readonly absPath: string;

  private constructor(absPath: string, doc: RegistryDocument, diskText: string, mtimeMs: number) {
    this.absPath = absPath;
    this.doc = doc;
    this.diskTextValue = diskText;
    this.mtimeMsValue = mtimeMs;
  }

  static load(resourcesDir: string): SystemTypesFile {
    const absPath = path.join(resourcesDir, ...EXTERNAL_REGISTRY_FILES.systemTypes.split("/"));
    const text = fs.readFileSync(absPath, "utf-8");
    const stat = fs.statSync(absPath);
    return new SystemTypesFile(absPath, RegistryDocument.parse(text), text, stat.mtimeMs);
  }

  document(): RegistryDocument {
    return this.doc;
  }
  diskText(): string {
    return this.diskTextValue;
  }
  mtimeMs(): number {
    return this.mtimeMsValue;
  }
  isDirty(): boolean {
    return this.doc.isDirty();
  }
  toText(): string {
    return this.doc.toText();
  }

  /** Baseline update after a successful write (keeps uids/selection stable). */
  markSaved(text: string, mtimeMs: number): void {
    this.doc.markClean();
    this.diskTextValue = text;
    this.mtimeMsValue = mtimeMs;
  }

  /** Restore from an undo/redo snapshot. */
  restore(text: string, diskText: string, mtimeMs: number): void {
    this.doc = RegistryDocument.parse(text);
    if (text !== diskText) this.doc.markDirty();
    this.diskTextValue = diskText;
    this.mtimeMsValue = mtimeMs;
  }

  /** Type names in document order. */
  names(): string[] {
    return this.doc.entries().map((e) => e.name);
  }

  /** uid for a type name (stable across renames within the session). */
  uidOf(name: string): string | undefined {
    return this.doc.entries().find((e) => e.name === name)?.uid;
  }

  has(name: string): boolean {
    return this.doc.hasName(name);
  }

  entryJS(name: string): Record<string, unknown> | undefined {
    const uid = this.uidOf(name);
    return uid ? this.doc.entryJS(uid) : undefined;
  }

  /** The whole file as the SystemTypeRegistry the option catalog expects --
   * built from BUFFERED content so unsaved additions count immediately. */
  toRegistry(): SystemTypeRegistry {
    const out: SystemTypeRegistry = {};
    for (const e of this.doc.entries()) {
      out[e.name] = (this.doc.entryJS(e.uid) ?? {}) as SystemTypeRegistry[string];
    }
    return out;
  }

  // --- mutations -------------------------------------------------------

  add(name: string, entry: Record<string, unknown>): boolean {
    if (this.doc.hasName(name)) return false;
    this.doc.addEntry(name, entry);
    return true;
  }

  setField(name: string, fieldPath: (string | number)[], value: unknown): boolean {
    const uid = this.uidOf(name);
    return uid ? this.doc.setEntryField(uid, fieldPath, value) : false;
  }

  deleteField(name: string, fieldPath: (string | number)[]): boolean {
    const uid = this.uidOf(name);
    return uid ? this.doc.deleteEntryField(uid, fieldPath) : false;
  }

  rename(name: string, newName: string): boolean {
    const uid = this.uidOf(name);
    return uid ? this.doc.renameEntry(uid, newName) : false;
  }

  remove(name: string): boolean {
    const uid = this.uidOf(name);
    return uid ? this.doc.deleteEntry(uid) : false;
  }
}

/** Build a minimal, schema-shaped `system-struct` entry. Members use the
 * `{ kind: named, name: X }` TypeRef shape this file documents. */
export function buildSystemStruct(opts: {
  description?: string;
  usedByInstructions?: string[];
  members?: SystemTypeMemberDraft[];
  sizeBytes?: number | null;
  confidence?: string;
  source?: string;
  notes?: string;
}): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (opts.sizeBytes != null) entry.sizeBytes = opts.sizeBytes;
  entry.category = "system-struct";
  entry.description = opts.description ?? "";
  if (opts.usedByInstructions?.length) entry.usedByInstructions = opts.usedByInstructions;
  // `members: null` is this file's documented "not yet mapped from a real TIA
  // reference" marker -- keep that convention when no members are supplied
  // rather than writing a misleading empty list.
  entry.members = opts.members?.length
    ? opts.members.map((m) => ({ name: m.name, type: { kind: "named", name: m.typeName } }))
    : null;
  entry.confidence = opts.confidence ?? "shape-only";
  entry.source = opts.source ?? "authored in the instruction-registry editor";
  if (opts.notes) entry.notes = opts.notes;
  return entry;
}

/** Build a `system-alias` entry (single-parent identifier/handle type). */
export function buildSystemAlias(basicDataType: string, opts: { description?: string; confidence?: string; source?: string } = {}): Record<string, unknown> {
  return {
    category: "system-alias",
    basicDataType,
    description: opts.description ?? "",
    confidence: opts.confidence ?? "shape-only",
    source: opts.source ?? "authored in the instruction-registry editor",
  };
}

/** Propose members for a system type backing an instruction, derived from that
 * instruction's own pins -- e.g. R_TRIG's CLK/Q pins become CLK/Q members.
 * Only pins with a name and a single unambiguous dataType are used; the user
 * reviews and completes the list (e.g. adding R_TRIG's `Stat_Bit`). */
export function membersFromInstructionPins(entry: Record<string, unknown>): SystemTypeMemberDraft[] {
  const pins = Array.isArray(entry.pins) ? entry.pins : [];
  const out: SystemTypeMemberDraft[] = [];
  for (const p of pins) {
    if (!p || typeof p !== "object") continue;
    const pin = p as Record<string, unknown>;
    const name = typeof pin.name === "string" ? pin.name : undefined;
    if (!name) continue;
    const types = Array.isArray(pin.dataTypes) ? (pin.dataTypes as unknown[]) : [];
    const typeName = types.length === 1 && typeof types[0] === "string" && types[0] !== "*" ? (types[0] as string) : "Bool";
    if (!out.some((m) => m.name === name)) out.push({ name, typeName });
  }
  return out;
}
