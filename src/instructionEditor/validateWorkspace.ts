// Whole-registry validation: runs the per-entry checks across every file and
// adds registry-scoped findings (duplicate names, empty files/entries) that a
// single-entry check can't see. This is what the editor's "validate all" panel
// and a future CI/`npm test` gate would call.
import { OptionCatalog } from "./externalRegistries";
import { RegistryWorkspace } from "./registryIndex";
import { KNOWN_FAMILIES } from "./schemaEnums";
import { ValidationContext, ValidationFinding, makeValidationContext, validateEntry } from "./validation";

export interface WorkspaceValidation {
  findings: ValidationFinding[];
  errorCount: number;
  warningCount: number;
}

/** Build the validation context for a workspace: catalog + the family set
 * (schema known-families unioned with families actually observed in the
 * registry, so a new family isn't flagged as unknown). */
export function contextForWorkspace(ws: RegistryWorkspace, catalog: OptionCatalog): ValidationContext {
  const families = new Set<string>(KNOWN_FAMILIES);
  for (const f of ws.observedFamilies()) families.add(f);
  return makeValidationContext(catalog, families);
}

export function validateWorkspace(ws: RegistryWorkspace, ctx: ValidationContext): WorkspaceValidation {
  const findings: ValidationFinding[] = [];

  for (const relPath of ws.fileRelPaths()) {
    const doc = ws.document(relPath)!;
    const errs = doc.parseErrors();
    for (const message of errs) {
      findings.push({ severity: "error", code: "yaml-parse-error", file: relPath, fieldPath: "", message });
    }
    const entries = doc.entries();
    if (entries.length === 0 && errs.length === 0) {
      findings.push({ severity: "warning", code: "empty-file", file: relPath, fieldPath: "", message: "File contains no instruction entries." });
    }
    for (const entry of entries) {
      const js = doc.entryJS(entry.uid);
      if (!js || Object.keys(js).length === 0) {
        findings.push({ severity: "warning", code: "empty-entry", file: relPath, entry: entry.name, entryUid: entry.uid, fieldPath: "", message: "Entry has no fields." });
        continue;
      }
      for (const f of validateEntry(js, ctx)) {
        findings.push({ ...f, file: relPath, entry: entry.name, entryUid: entry.uid });
      }
    }
  }

  // Duplicate names across files within the same lookup map.
  for (const dup of ws.findDuplicateNames()) {
    for (const file of dup.files) {
      findings.push({
        severity: "error",
        code: "duplicate-name",
        file,
        entry: dup.name,
        fieldPath: "",
        message: `Instruction '${dup.name}' is declared in ${dup.files.length} ${dup.scope} files: ${dup.files.join(", ")}. Duplicate keys are not a supported override; the last-loaded file silently wins.`,
      });
    }
  }

  const errorCount = findings.filter((f) => f.severity === "error").length;
  return { findings, errorCount, warningCount: findings.length - errorCount };
}
