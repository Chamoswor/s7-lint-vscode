// The message protocol shared between the extension host (panel.ts) and the
// webview UI (webview/main.ts). Kept DOM-free and vscode-free so tsc can
// type-check it as part of the host build AND esbuild can bundle it into the
// browser webview -- the single contract both sides import.
//
// All payloads are plain JSON (no Sets/Maps/class instances), because they
// cross the webview postMessage boundary which structured-clones them.
// Type-only imports: these modules pull in Node built-ins (fs/path), so they
// MUST be `import type` to guarantee esbuild elides them from the browser
// webview bundle that also imports this file.
import type { FolderNode } from "./registryIndex";
import type { OptionGroup } from "./externalRegistries";
import type { ValidationFinding } from "./validation";

/** JSON-serializable form of OptionCatalog (Sets flattened to arrays), plus
 * the schema enums, sent to the webview so every dropdown/multiselect is
 * populated from the authoritative registries with no hardcoding in the UI. */
export interface SerializableCatalog {
  memoryAreas: { value: string; description?: string }[];
  declarationSections: { value: string; description?: string }[];
  resultKinds: { value: string; description?: string }[];
  resultInferenceRules: { value: string; description?: string }[];
  resultTransforms: { value: string; description?: string }[];
  resultUsageContexts: { value: string; description?: string }[];
  dataTypeGroups: OptionGroup[];
  systemTypeNames: string[];
  /** Schema enums (not registry data) -- see schemaEnums.ts. */
  families: string[];
  callShapes: string[];
  pinDirs: string[];
  confidenceLevels: string[];
  templateShapes: string[];
  /** Languages offered for the entry-level `language` multiselect. */
  languages: string[];
}

/** A compact per-file dirty + finding summary for the nav tree badges. */
export interface FileStatus {
  relPath: string;
  dirty: boolean;
  errorCount: number;
  warningCount: number;
}

/** The initial payload: everything the UI needs to render the tree, populate
 * option lists, and show validation/dirty badges. */
export interface EditorSnapshot {
  registryRootLabel: string;
  tree: FolderNode;
  catalog: SerializableCatalog;
  /** Findings across the whole registry (for the global error panel). */
  findings: ValidationFinding[];
  fileStatus: FileStatus[];
  /** Duplicate-name errors already fold into `findings`; this is a quick flag. */
  hasErrors: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** The editable external registry (type-registry/system-types.yaml).
   * `missing` lists type names the instruction registry references but that
   * aren't catalogued -- what the "add all missing" action would create. */
  systemTypes: { names: string[]; dirty: boolean; missing: MissingSystemType[] };
}

/** How a missing type name was referenced by the instruction registry. */
export type MissingTypeSource = "instanceType" | "pinDataType";

/** A type referenced by instructions but not catalogued anywhere. */
export interface MissingSystemType {
  name: string;
  usedByInstructions: string[];
  /** Proposed members (only when reachable from an instruction's pins). */
  members: { name: string; typeName: string }[];
  sources: MissingTypeSource[];
}

/** One system-types.yaml entry's editable data + findings. */
export interface SystemTypeData {
  name: string;
  json: Record<string, unknown>;
  findings: ValidationFinding[];
  unknownFields: string[];
}

/** One entry's editable data + its own findings, sent on selection/after edit. */
export interface EntryData {
  uid: string;
  name: string;
  filePath: string;
  /** Plain-JS value of the entry (preserves unknown fields). */
  json: Record<string, unknown>;
  findings: ValidationFinding[];
  /** Field names present on the entry that the editor schema doesn't model
   * (shown read-only so the user knows they're preserved, not lost). */
  unknownFields: string[];
}

// --- Host -> Webview ----------------------------------------------------
export type HostToWebview =
  | { type: "init"; snapshot: EditorSnapshot }
  | { type: "entryData"; entry: EntryData }
  | { type: "openEntry"; entry: EntryData }
  | { type: "systemTypeData"; data: SystemTypeData }
  | { type: "openSystemType"; data: SystemTypeData }
  | { type: "status"; fileStatus: FileStatus[]; findings: ValidationFinding[]; hasErrors: boolean; canUndo: boolean; canRedo: boolean }
  | { type: "saved"; savedFiles: string[]; failed?: { relPath: string; message: string }[] }
  | { type: "externallyChanged"; relPaths: string[] }
  | { type: "toast"; level: "info" | "warn" | "error"; message: string };

// --- Webview -> Host ----------------------------------------------------
export type WebviewToHost =
  | { type: "ready" }
  | { type: "selectEntry"; uid: string }
  | { type: "updateField"; uid: string; path: (string | number)[]; value: unknown }
  | { type: "deleteField"; uid: string; path: (string | number)[] }
  | { type: "renameEntry"; uid: string; newName: string }
  | { type: "save" }
  | { type: "revertAll" }
  | { type: "revealFile"; relPath: string }
  // Phase 3: create / duplicate / delete / move
  | { type: "createEntry"; targetRelPath: string; name: string; family?: string; callShape?: string }
  | { type: "duplicateEntry"; uid: string }
  | { type: "deleteEntry"; uid: string }
  | { type: "moveEntry"; uid: string; targetRelPath: string; index?: number }
  | { type: "createFile"; folderRelPath: string; fileName: string; fileLanguage?: string[] }
  | { type: "deleteFile"; relPath: string }
  | { type: "renameFile"; relPath: string; newName: string }
  | { type: "moveFile"; relPath: string; targetFolderRelPath: string }
  | { type: "createFolder"; parentRelPath: string; name: string }
  | { type: "deleteFolder"; relPath: string }
  // Phase 4: drag-and-drop
  | { type: "reorderFile"; relPath: string; orderedUids: string[] }
  | { type: "moveEntries"; uids: string[]; targetRelPath: string; index?: number }
  // Phase 5: undo/redo, diff preview
  | { type: "undo" }
  | { type: "redo" }
  | { type: "previewDiff"; relPath: string }
  // system-types.yaml editing
  | { type: "selectSystemType"; name: string }
  | { type: "createSystemType"; name: string; category?: string; basicDataType?: string; description?: string }
  /** Quick-fix from the "not a known system type" warning: create the type
   * seeded from the instruction's own pins. */
  | { type: "createSystemTypeForInstruction"; uid: string; typeName?: string }
  | { type: "updateSystemTypeField"; name: string; path: (string | number)[]; value: unknown }
  | { type: "deleteSystemTypeField"; name: string; path: (string | number)[] }
  | { type: "renameSystemType"; name: string; newName: string }
  | { type: "deleteSystemType"; name: string }
  /** Bulk-create every referenced-but-uncatalogued system type (one undo step). */
  | { type: "createMissingSystemTypes"; names?: string[] };
