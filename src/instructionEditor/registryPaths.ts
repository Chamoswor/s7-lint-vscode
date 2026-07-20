// Path and file-discovery helpers for the instruction-registry editor.
//
// These deliberately mirror the conventions already encoded in
// src/rules/loadRules.ts (TEMPLATE_FILE, SCL_ONLY_SUFFIX, FILE_LANGUAGE_KEY,
// the recursive walk) so the editor sees EXACTLY the same set of files, in the
// same interpretation, that the linter itself loads at runtime. If the two
// ever diverge, the editor would let a user author entries the linter never
// reads (or hide files it does). Keep them in lock-step.
//
// This module is intentionally vscode-free so it can run under plain Node in
// the scripts/ test harness, matching analysis/documentIndex.ts's discipline.
import * as fs from "fs";
import * as path from "path";
import { detectLanguage, isSclFile } from "../rules/fileLanguage";

// Language classification lives in the foundational rules/ layer so the linter
// loader and this editor share one definition. Re-exported for existing
// editor imports.
export { detectLanguage, isSclFile };

/** Reserved top-level key a family file may set once to default every entry's
 * `language`; never a real instruction name. Mirrors loadRules.ts. */
export const FILE_LANGUAGE_KEY = "$fileLanguage";

/** Copy-me schema file, excluded from the loaded registry. Mirrors loadRules.ts. */
export const TEMPLATE_FILE = "_template.yaml";

/** Sub-path (relative to the resources dir) of the editable registry root. */
export const INSTRUCTION_REGISTRY_DIR = "instruction-registry";

/** The external, authoritative registry files whose contents drive the
 * editor's option lists. Paths are relative to the resources dir. These are
 * READ-ONLY inputs for the editor -- it never writes them. Mirrors the set the
 * task brief lists as autoritative datakilder, plus the two the linter already
 * reads for the same facts. */
export const EXTERNAL_REGISTRY_FILES = {
  memory: "system-registry/memory.yaml",
  result: "system-registry/result.yaml",
  baseTypes: "type-registry/base-types.yaml",
  systemTypes: "type-registry/system-types.yaml",
  categoryIndex: "type-registry/category-index.yaml",
  bcdFormats: "type-registry/bcd-formats.yaml",
} as const;

export interface DiscoveredFile {
  /** Absolute path on disk. */
  absPath: string;
  /** Path relative to the instruction-registry root, using forward slashes --
   * the stable, OS-independent identity used everywhere in the editor/UI. */
  relPath: string;
  /** Basename, e.g. `SCL-bit-logic.yaml`. */
  fileName: string;
  /** True when this file's basename ends in `-SCL.yaml` (linter routes it to
   * the `sclInstructions` map). */
  isScl: boolean;
}

/** Normalizes a path to forward-slash form for use as a stable cross-platform
 * identity (Windows `\` -> `/`). */
export function toRelId(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join("/");
}

/** Recursively lists every `*.yaml` file under the instruction-registry root,
 * excluding `_template.yaml`, matching loadRules.ts's `listFilesRecursive` +
 * per-file filter. Returned sorted by relPath for stable UI ordering. */
export function discoverInstructionFiles(registryRoot: string): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  walk(registryRoot);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".yaml") && entry.name !== TEMPLATE_FILE) {
        out.push({
          absPath: full,
          relPath: toRelId(registryRoot, full),
          fileName: entry.name,
          isScl: isSclFile(entry.name),
        });
      }
    }
  }
}

/** Lists every subfolder (recursively) under the registry root, as relPaths --
 * used to build the navigation tree even for folders that currently hold no
 * (or only non-YAML) files. The root itself is represented by "". */
export function discoverFolders(registryRoot: string): string[] {
  const out = new Set<string>([""]);
  walk(registryRoot);
  return [...out].sort((a, b) => a.localeCompare(b));

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      out.add(toRelId(registryRoot, full));
      walk(full);
    }
  }
}
