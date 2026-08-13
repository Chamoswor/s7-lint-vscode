// Structural and cross-reference checks for TIA MultiLingualTexts resources.
// Parsing/schema analysis lives in parser/s7resParser.ts so providers and the
// linter share one definition of a valid `.s7res` document.
import { analyzeS7res, findAllMlcPragmaUsages, S7ResIssue } from "../parser/s7resParser";
import { RuleSet } from "../rules/types";
import { formatDiagnostic, LintDiagnostic } from "./diagnostics";

function issueDiagnostic(issue: S7ResIssue, ruleSet: RuleSet): LintDiagnostic {
  switch (issue.kind) {
    case "invalid-yaml":
      return formatDiagnostic(ruleSet, "s7res-invalid-yaml", issue.line, issue.col, { reason: issue.reason ?? "unknown YAML error" });
    case "unquoted-comment":
      return formatDiagnostic(ruleSet, "s7res-unquoted-comment", issue.line, issue.col, {
        retainedText: issue.retainedText ?? "",
      });
    case "invalid-root":
      return formatDiagnostic(ruleSet, "s7res-invalid-root", issue.line, issue.col);
    case "invalid-entry":
      return formatDiagnostic(ruleSet, "s7res-invalid-entry", issue.line, issue.col, { reason: issue.reason ?? "invalid element" });
    case "duplicate-id":
      return formatDiagnostic(ruleSet, "s7res-duplicate-id", issue.line, issue.col, { id: issue.id ?? "" });
  }
}

/** Validates YAML, the TIA resource schema, duplicate IDs, silent comment
 * truncation, and (when sibling source text is available) orphaned entries. */
export function checkS7res(text: string, ruleSet: RuleSet, sourceText?: string): LintDiagnostic[] {
  const analysis = analyzeS7res(text);
  const diagnostics = analysis.issues.map((issue) => issueDiagnostic(issue, ruleSet));
  if (!analysis.parsed || sourceText === undefined) return diagnostics;

  const usedIds = new Set(findAllMlcPragmaUsages(sourceText).map((usage) => usage.id));
  for (const entry of analysis.parsed.entries.values()) {
    if (!usedIds.has(entry.id)) {
      diagnostics.push(formatDiagnostic(ruleSet, "s7res-orphaned-id", entry.idLine, entry.idCol, { id: entry.id }));
    }
  }
  return diagnostics;
}

/** Checks the source-to-resource direction. Unreadable YAML/root data skips
 * this pass entirely rather than producing a misleading "missing ID" cascade
 * for every pragma that depends on it. */
export function checkMlcReferences(sourceText: string, resourceText: string | undefined, ruleSet: RuleSet): LintDiagnostic[] {
  const usages = findAllMlcPragmaUsages(sourceText);
  if (usages.length === 0) return [];
  if (resourceText === undefined) {
    return usages.map((usage) =>
      formatDiagnostic(ruleSet, "mlc-id-not-found", usage.token.line, usage.token.col, { id: usage.id }, { variant: "missing-resource" })
    );
  }

  const analysis = analyzeS7res(resourceText);
  if (!analysis.parsed) return [];
  return usages
    .filter((usage) => !analysis.parsed?.entries.has(usage.id))
    .map((usage) =>
      formatDiagnostic(ruleSet, "mlc-id-not-found", usage.token.line, usage.token.col, { id: usage.id }, { variant: "missing-id" })
    );
}
