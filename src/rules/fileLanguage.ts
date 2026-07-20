// Canonical language classification for instruction-registry file names.
//
// Files encode their language in the basename. The repo's actual convention is
// a PREFIX (`SCL-bit-logic.yaml`, `LAD-FBD-bit-logic.yaml`, `LAD-bit-logic.yaml`,
// `FBD-bit-logic.yaml`); the README/older convention used a SUFFIX
// (`*-SCL.yaml`). This module recognizes BOTH so the split into the linter's
// `instructions` (graphical: LAD/FBD) vs `sclInstructions` maps is driven by
// what the files are actually named -- not by a suffix that matches nothing.
//
// Both loadRules.ts (the linter loader) and the instruction-registry editor
// import from here, so the two never disagree on which file is "SCL".
// Dependency-free (no fs/vscode), safe to import from any layer.

/** The legacy `-SCL.yaml` suffix. Retained for callers that still reference it,
 * but classification should go through `isSclFile`/`detectLanguage`. */
export const SCL_ONLY_SUFFIX = "-SCL.yaml";

/** Language token(s) encoded in a file's basename, or undefined if none.
 * `LAD-FBD` is tested before `LAD`/`FBD` so the combined form wins. */
export function detectLanguage(fileName: string): string[] | undefined {
  const base = fileName.replace(/\.yaml$/i, "");
  const has = (tok: string) => base === tok || base.startsWith(`${tok}-`) || base.endsWith(`-${tok}`);
  if (has("LAD-FBD")) return ["LAD", "FBD"];
  if (has("SCL")) return ["SCL"];
  if (has("LAD")) return ["LAD"];
  if (has("FBD")) return ["FBD"];
  return undefined;
}

/** True when a file's basename marks it as SCL (prefix or suffix form) -- the
 * routing key for the linter's separate `sclInstructions` map. */
export function isSclFile(fileName: string): boolean {
  return detectLanguage(fileName)?.includes("SCL") ?? false;
}
