// Headless, one-shot instruction-registry mutations used by the Quick Fixes
// in providers/registryQuickFixProvider.ts -- "mark this pin optional" and
// "scaffold this missing instruction".
//
// Both go through the SAME EditorService the webview editor uses, rather than
// touching YAML directly: that buys the comment-preserving splice, the CRLF
// round-trip, the schema validation and the atomic write-and-verify save for
// free, and guarantees a Quick Fix can never produce a file the editor itself
// would refuse to load. The difference is lifecycle -- the panel keeps one
// long-lived buffered service with undo/redo, whereas each call here loads
// fresh from disk, makes exactly one change, saves, and throws the service
// away. That is deliberate: a Quick Fix must not silently commit whatever the
// user happens to have pending in an open editor panel (the caller refuses to
// run at all while the panel has unsaved changes -- see the provider).
import { EditorService } from "./editorService";
import { InstructionPin } from "../rules/types";

export interface RegistryEditResult {
  ok: boolean;
  /** Why it could not be applied -- shown to the user verbatim. */
  reason?: string;
  /** Registry-relative path of the file that was written. */
  relPath?: string;
}

function reportSave(service: EditorService, relPath: string): RegistryEditResult {
  const result = service.save();
  const failure = result.failed.find((f) => f.relPath === relPath) ?? result.failed[0];
  if (failure) return { ok: false, reason: `${failure.relPath}: ${failure.message}` };
  return { ok: true, relPath };
}

/**
 * Flips `required` on one or more of an instruction's named pins and saves.
 * Every pin must exist on the entry; a name that doesn't match is reported
 * rather than silently skipped, since that means the caller's view of the
 * registry is stale and the rest of the edit is probably wrong too.
 */
export function setPinsRequired(
  resourcesDir: string,
  instructionName: string,
  pinNames: string[],
  required: boolean,
  scl: boolean
): RegistryEditResult {
  const service = new EditorService(resourcesDir);
  const found = service.findEntryByName(instructionName, scl);
  if (!found) {
    return { ok: false, reason: `'${instructionName}' was not found in the ${scl ? "SCL" : "LAD/FBD"} instruction registry.` };
  }
  const data = service.entryData(found.uid);
  const pins = Array.isArray(data?.json.pins) ? (data!.json.pins as Record<string, unknown>[]) : [];

  for (const pinName of pinNames) {
    const index = pins.findIndex((p) => p && p.name === pinName);
    if (index < 0) return { ok: false, reason: `'${instructionName}' has no pin named '${pinName}'.` };
    service.updateField(found.uid, ["pins", index, "required"], required);
  }
  return reportSave(service, found.relPath);
}

export interface ScaffoldSpec {
  instructionName: string;
  family: string;
  scl: boolean;
  /** Named arguments observed at the call site, used to seed the pin list. */
  pinNames: string[];
}

/**
 * Creates a minimal entry for an instruction the registry doesn't know yet,
 * seeded from the call site so the common follow-up diagnostics
 * (`unknown-pin` for every argument) don't immediately replace the one just
 * fixed. Everything the call site cannot prove is left deliberately weak
 * rather than guessed, per instruction-registry/README.md:
 *
 *   - `confidence: shape-only` (EditorService's own minimum entry) -- which
 *     the linter already reads as "downgrade this entry's errors to
 *     warnings", so a scaffold can't harden into false certainty;
 *   - every pin `required: false`, so a scaffold never invents the very
 *     `missing-required-pin` error the other Quick Fix exists to undo;
 *   - `dataTypes` left off entirely (the README's "unfilled means don't
 *     check", not "checks against nothing");
 *   - `dir: in` is the one unavoidable placeholder -- the field is
 *     mandatory and a call site genuinely doesn't reveal direction. The
 *     entry `notes` says so, in the file, where whoever completes it looks.
 */
export function scaffoldInstruction(resourcesDir: string, spec: ScaffoldSpec): RegistryEditResult {
  const service = new EditorService(resourcesDir);
  if (service.findEntryByName(spec.instructionName, spec.scl)) {
    return { ok: false, reason: `'${spec.instructionName}' already exists in the ${spec.scl ? "SCL" : "LAD/FBD"} registry.` };
  }
  const targetRelPath = service.suggestFileForFamily(spec.family, spec.scl);
  if (!targetRelPath) {
    return {
      ok: false,
      reason: `No ${spec.scl ? "SCL" : "LAD/FBD"} registry file holds '${spec.family}' entries yet -- create one in the Instruction Registry Editor first.`,
    };
  }

  const created = service.createEntry(targetRelPath, spec.instructionName, { family: spec.family, callShape: "box" });
  if (!created.ok || !created.data) return { ok: false, reason: created.reason ?? "Could not create the entry." };

  if (spec.pinNames.length > 0) {
    const pins: Pick<InstructionPin, "name" | "dir" | "required" | "note">[] = spec.pinNames.map((name) => ({
      name,
      dir: "in",
      required: false,
      note: "",
    }));
    service.updateField(created.data.uid, ["pins"], pins);
  }
  service.updateField(
    created.data.uid,
    ["notes"],
    "Scaffolded from a call site by a Quick Fix. Pin names come from that call; " +
      "direction, data types and which pins are actually required are NOT verified -- " +
      "complete this against Siemens' own documentation and raise `confidence` when you have."
  );

  return reportSave(service, targetRelPath);
}
