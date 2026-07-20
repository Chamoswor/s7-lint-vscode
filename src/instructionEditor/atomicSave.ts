// Atomic, validated file replacement for the editor's save path.
//
// The task brief mandates: write to a temp file, validate the result, and only
// then replace the original -- so a failed validation or a crash mid-write can
// never leave a half-written or invalid registry file on disk. `fs.renameSync`
// is atomic within a volume (on Windows it maps to MoveFileEx with
// replace-existing), so a reader never observes a partial file.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Returns an error message if `text` is unacceptable, or null/undefined if OK. */
export type SaveValidator = (text: string) => string | null | undefined;

export class AtomicSaveError extends Error {}

/**
 * Write `text` to `absPath` atomically:
 *  1. write to a sibling temp file,
 *  2. run `validate` on the content (e.g. re-parse to confirm valid YAML),
 *  3. rename the temp file over the original only if validation passed.
 * On any failure the temp file is removed and the original is left untouched.
 */
export function atomicWriteFile(absPath: string, text: string, validate?: SaveValidator): void {
  const dir = path.dirname(absPath);
  // Temp file in the SAME directory so the rename stays on one volume (a
  // cross-volume rename is a non-atomic copy+delete). Unique per call.
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, text, "utf-8");
    if (validate) {
      const err = validate(text);
      if (err) throw new AtomicSaveError(err);
    }
    fs.renameSync(tmp, absPath);
  } catch (err) {
    safeUnlink(tmp);
    throw err;
  }
}

function safeUnlink(p: string): void {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* best-effort cleanup */
  }
}

/** Detects whether a file changed on disk since it was loaded, by comparing
 * both mtime and content (mtime alone is unreliable; content alone misses a
 * revert-to-identical). Used to warn before overwriting external edits. */
export function fileChangedOnDisk(absPath: string, loadedText: string, loadedMtimeMs: number): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return true; // deleted or inaccessible counts as changed
  }
  if (stat.mtimeMs === loadedMtimeMs) return false;
  const current = fs.readFileSync(absPath, "utf-8");
  return current !== loadedText;
}

/** A scratch temp path under the OS temp dir, for callers that need one. */
export function scratchTempPath(hint = "registry-editor"): string {
  return path.join(os.tmpdir(), `${hint}.${process.pid}.${Date.now()}.tmp`);
}
