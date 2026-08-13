// Pure text transformations behind S7ResQuickFixProvider. Kept free of the
// vscode API so every edit can be regression-tested as complete YAML before
// the provider exposes it as a WorkspaceEdit.

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function yamlId(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : yamlSingleQuoted(value);
}

function entriesText(ids: readonly string[], eol: string): string {
  return uniqueIds(ids)
    .map((id) => `  - id: ${yamlId(id)}${eol}    en-US: ''`)
    .join(eol);
}

export function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** A complete, valid TIA MultiLingualTexts resource with placeholder text. */
export function renderS7res(ids: readonly string[], eol = "\n"): string {
  const unique = uniqueIds(ids);
  return unique.length === 0 ? `MultiLingualTexts: []${eol}` : `MultiLingualTexts:${eol}${entriesText(unique, eol)}${eol}`;
}

/** Appends entries without reserializing or disturbing existing comments,
 * quoting, locale order, or line endings. Handles the valid inline-empty
 * form (`MultiLingualTexts: []`) by expanding it to a normal sequence. */
export function addS7resEntries(text: string, ids: readonly string[]): string {
  const unique = uniqueIds(ids);
  if (unique.length === 0) return text;
  const eol = detectEol(text);
  if (/^\s*MultiLingualTexts:\s*\[\s*\]\s*$/.test(text)) return renderS7res(unique, eol);
  const separator = text.length === 0 || text.endsWith("\n") ? "" : eol;
  return `${text}${separator}${entriesText(unique, eol)}${eol}`;
}

/** Quotes one locale line's COMPLETE raw value, preserving a ` # suffix`
 * that YAML previously interpreted as a comment. */
export function quoteS7resLocaleLine(lineText: string): string | undefined {
  const match = /^(\s+[A-Za-z][A-Za-z-]*:\s*)(.*)$/.exec(lineText);
  if (!match || !match[2].trim()) return undefined;
  const value = match[2].trim();
  if (value.startsWith("'") || value.startsWith('"') || value.startsWith("|") || value.startsWith(">")) return undefined;
  return match[1] + yamlSingleQuoted(value);
}

/** Adds the mandatory en-US field immediately after an entry's id line.
 * `idLine` is 1-based, matching S7ResIssue/S7ResEntry. */
export function addMissingEnUs(text: string, idLine: number): string | undefined {
  const eol = detectEol(text);
  const lines = text.split(/\r\n|\n/);
  const index = idLine - 1;
  const line = lines[index];
  if (line === undefined) return undefined;
  const bullet = /^(\s*)-\s*id\s*:/.exec(line);
  const plain = /^(\s*)id\s*:/.exec(line);
  if (!bullet && !plain) return undefined;
  const indent = bullet ? `${bullet[1]}  ` : plain![1];
  lines.splice(index + 1, 0, `${indent}en-US: ''`);
  return lines.join(eol);
}

/** Converts a scalar/null/number locale value to text. Complex YAML values
 * are deliberately not handled -- quoting a mapping/sequence across lines
 * would require guessing the user's intended text. */
export function quoteInvalidLocaleScalar(text: string, lineNumber: number): string | undefined {
  const eol = detectEol(text);
  const lines = text.split(/\r\n|\n/);
  const index = lineNumber - 1;
  const original = lines[index];
  if (original === undefined) return undefined;
  const empty = /^(\s+[A-Za-z][A-Za-z-]*:\s*)$/.exec(original);
  const replacement = empty ? `${empty[1].trimEnd()} ''` : quoteS7resLocaleLine(original);
  if (!replacement) return undefined;
  lines[index] = replacement;
  return lines.join(eol);
}
