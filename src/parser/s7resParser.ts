// Parses a `.s7res` multilingual-text export -- the companion file next to
// a `.s7dcl` (same directory, same basename) that TIA exports whenever a
// block uses `S7_MLC`/`S7_NetworkTitle`/`S7_NetworkComment`/`S7_BlockTitle`/
// `S7_BlockComment` pragma IDs (see analysis/documentIndex.ts's PRAGMA_DOCS).
// Shape:
//   MultiLingualTexts:
//     - id: MLC_3UP
//       en-US: Some comment text
//       de-DE: 'Ein Kommentartext'
// Values can be a plain scalar, a quoted scalar, or a multi-line block
// scalar (`|`/`|+`/`>`) -- js-yaml already parses all of those correctly, so
// it's used for the TEXT values; only each entry's own source line/column
// (needed for go-to-definition) is recovered separately by a line scan,
// since js-yaml's simple `load()` doesn't expose node positions.
import * as fs from "fs";
import * as yaml from "js-yaml";
import { Lexer, Token, TokenCursor } from "./lexer";

/** Pragma keys whose (quoted) value is an `.s7res` MultiLingualTexts ID,
 * not inline text -- shared by analysis/documentIndex.ts (resolving a
 * `.s7dcl`'s own pragma values) and providers/s7resDefinition.ts +
 * providers/rename.ts (scanning a sibling source file for usages of one
 * specific ID) so the key list can't drift between the two directions. */
export const MLC_ID_PRAGMA_KEYS = new Set(["S7_MLC", "S7_NetworkTitle", "S7_NetworkComment", "S7_BlockTitle", "S7_BlockComment"]);

export interface S7ResText {
  text: string;
  /** 1-based line of this locale's own line in the source file, when found. */
  line?: number;
}

export interface S7ResEntry {
  id: string;
  /** 1-based line/col of the `- id: <ID>` value token -- the jump target
   * used for both directions (`.s7dcl` -> here, and here -> `.s7dcl`). */
  idLine: number;
  idCol: number;
  texts: Map<string, S7ResText>; // locale -> text
}

export interface ParsedS7Res {
  entries: Map<string, S7ResEntry>; // keyed by id
}

export type S7ResIssueKind =
  | "invalid-yaml"
  | "unquoted-comment"
  | "invalid-root"
  | "invalid-entry"
  | "duplicate-id";

/** A parser/schema problem with an exact source anchor. Kept independent of
 * the linter's diagnostic registry so providers can continue using this
 * parser without depending on linter/. */
export interface S7ResIssue {
  kind: S7ResIssueKind;
  line: number;
  col: number;
  reason?: string;
  id?: string;
  retainedText?: string;
}

export interface S7ResAnalysis {
  parsed?: ParsedS7Res;
  issues: S7ResIssue[];
}

export interface ResolvedMlcText {
  text: string;
  locale: string;
  line?: number;
}

const ID_LINE_RE = /^(\s*-\s*id:\s*)(\S+)\s*$/;
const LOCALE_LINE_RE = /^\s+([A-Za-z][A-Za-z-]*):\s?/;

interface EntryPosition {
  line: number;
  col: number;
  idLine: number;
  idCol: number;
  localeLines: Map<string, number>;
}

/** Position scan by sequence index. This retains duplicate IDs and malformed
 * entries so schema diagnostics can point at the offending element. */
function scanEntryPositions(text: string): EntryPosition[] {
  const lines = text.split(/\r\n|\n/);
  const sequenceIndent = lines.reduce<number | undefined>((smallest, line) => {
    const match = /^( *)-\s+/.exec(line);
    if (!match) return smallest;
    return smallest === undefined ? match[1].length : Math.min(smallest, match[1].length);
  }, undefined);
  const result: EntryPosition[] = [];
  let current: EntryPosition | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const entryMatch = /^( *)-\s+/.exec(line);
    // A bullet in an en-US block scalar is more deeply indented than the
    // root sequence and therefore cannot shift the element-to-position map.
    if (entryMatch && entryMatch[1].length === sequenceIndent) {
      const idMatch = /^(\s*-\s*id:\s*)/.exec(line);
      current = {
        line: i + 1,
        col: entryMatch[0].length + 1,
        idLine: i + 1,
        idCol: idMatch ? idMatch[1].length + 1 : entryMatch[0].length + 1,
        localeLines: new Map(),
      };
      result.push(current);
      continue;
    }
    if (!current) continue;
    const idMatch = /^(\s+id:\s*)/.exec(line);
    if (idMatch) {
      current.idLine = i + 1;
      current.idCol = idMatch[1].length + 1;
      continue;
    }
    const locMatch = LOCALE_LINE_RE.exec(line);
    if (locMatch && !current.localeLines.has(locMatch[1])) current.localeLines.set(locMatch[1], i + 1);
  }
  return result;
}

/** Finds the YAML-valid but lossy plain-scalar case. `js-yaml` quite
 * correctly treats whitespace + `#` as a comment, so parsing alone cannot
 * tell that a human intended the suffix to be resource text. Quoted and
 * block scalar values are deliberately excluded; `T#15M` is also safe
 * because the hash is not preceded by whitespace. */
function findUnquotedCommentIssues(text: string): S7ResIssue[] {
  const issues: S7ResIssue[] = [];
  const lines = text.split(/\r\n|\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s+[A-Za-z][A-Za-z-]*:\s*)(.*)$/.exec(lines[i]);
    if (!match) continue;
    const value = match[2];
    const trimmed = value.trimStart();
    if (!trimmed || trimmed.startsWith("'") || trimmed.startsWith('"') || trimmed.startsWith("|") || trimmed.startsWith(">")) continue;
    const commentAt = value.indexOf(" #");
    if (commentAt < 0) continue;
    issues.push({
      kind: "unquoted-comment",
      line: i + 1,
      col: match[1].length + commentAt + 2,
      retainedText: value.slice(0, commentAt).trimEnd(),
    });
  }
  return issues;
}

function yamlErrorIssue(error: unknown): S7ResIssue {
  const yamlError = error as { reason?: unknown; message?: unknown; mark?: { line?: unknown; column?: unknown } };
  const markedLine = yamlError.mark?.line;
  const markedColumn = yamlError.mark?.column;
  return {
    kind: "invalid-yaml",
    line: typeof markedLine === "number" ? markedLine + 1 : 1,
    col: typeof markedColumn === "number" ? markedColumn + 1 : 1,
    reason: typeof yamlError.reason === "string" ? yamlError.reason : String(yamlError.message ?? error),
  };
}

/** Parses YAML and validates the TIA `.s7res` schema. A valid document has
 * exactly one root key (`MultiLingualTexts`), a sequence of mappings, a
 * non-empty string `id`, a string `en-US`, string values for any additional
 * locales, and unique IDs. */
export function analyzeS7res(text: string): S7ResAnalysis {
  const issues = findUnquotedCommentIssues(text);
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (error) {
    issues.push(yamlErrorIssue(error));
    return { issues };
  }

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    issues.push({ kind: "invalid-root", line: 1, col: 1 });
    return { issues };
  }
  const root = doc as Record<string, unknown>;
  const rootKeys = Object.keys(root);
  const list = root.MultiLingualTexts;
  if (rootKeys.length !== 1 || rootKeys[0] !== "MultiLingualTexts" || !Array.isArray(list)) {
    issues.push({ kind: "invalid-root", line: 1, col: 1 });
    return { issues };
  }

  const positions = scanEntryPositions(text);
  const entries = new Map<string, S7ResEntry>();
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const pos = positions[i] ?? { line: 1, col: 1, idLine: 1, idCol: 1, localeLines: new Map<string, number>() };
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push({ kind: "invalid-entry", line: pos.line, col: pos.col, reason: "the element is not a mapping" });
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || id.length === 0) {
      issues.push({ kind: "invalid-entry", line: pos.idLine, col: pos.idCol, reason: "'id' must be a non-empty string" });
      continue;
    }
    if (typeof record["en-US"] !== "string") {
      issues.push({
        kind: "invalid-entry",
        line: pos.localeLines.get("en-US") ?? pos.idLine,
        col: pos.localeLines.has("en-US") ? 1 : pos.idCol,
        reason: "'en-US' must be present and contain text",
        id,
      });
    }
    const invalidTextField = Object.entries(record).find(
      ([key, value]) => key !== "id" && key !== "en-US" && typeof value !== "string"
    );
    if (invalidTextField) {
      const [key] = invalidTextField;
      issues.push({
        kind: "invalid-entry",
        line: pos.localeLines.get(key) ?? pos.idLine,
        col: 1,
        reason: `'${key}' must contain text`,
        id,
      });
    }
    if (entries.has(id)) {
      issues.push({ kind: "duplicate-id", line: pos.idLine, col: pos.idCol, id });
      continue;
    }
    const texts = new Map<string, S7ResText>();
    for (const [key, value] of Object.entries(record)) {
      if (key !== "id" && typeof value === "string") texts.set(key, { text: value, line: pos.localeLines.get(key) });
    }
    entries.set(id, { id, idLine: pos.idLine, idCol: pos.idCol, texts });
  }

  // `parsed` means the YAML/root was readable, not necessarily schema-clean.
  // Keeping the recoverable ID set lets cross-reference checks run after a
  // rule-2/3 finding. Invalid YAML/root returns earlier without `parsed`, which
  // is the hard gate that prevents a false "every MLC is missing" cascade.
  return { parsed: { entries }, issues };
}

/** Parses `.s7res` text into id -> {locale -> text} entries, or `null` if
 * it isn't a well-formed `MultiLingualTexts` document (malformed YAML, or
 * missing/wrong-shaped top-level key) -- don't guess on a file this parser
 * doesn't recognize. */
export function parseS7res(text: string): ParsedS7Res | null {
  const analysis = analyzeS7res(text);
  return analysis.issues.length === 0 ? analysis.parsed ?? null : null;
}

/** Resolves one entry's display text for `preferredLocale`, falling back to
 * `en-US`, then to whichever locale happens to be present first -- per the
 * user's own requirement that the preferred locale is configurable and
 * must have a working fallback (TIA exports don't guarantee every locale is
 * present for every ID). Returns `undefined` only when the entry has no
 * locale text at all. */
export function resolveMlcText(entry: S7ResEntry, preferredLocale: string): ResolvedMlcText | undefined {
  const preferred = entry.texts.get(preferredLocale);
  if (preferred) return { text: preferred.text, locale: preferredLocale, line: preferred.line };
  if (preferredLocale !== "en-US") {
    const enUs = entry.texts.get("en-US");
    if (enUs) return { text: enUs.text, locale: "en-US", line: enUs.line };
  }
  const first = entry.texts.entries().next();
  if (!first.done) {
    const [locale, v] = first.value;
    return { text: v.text, locale, line: v.line };
  }
  return undefined;
}

/** Derives a `.s7dcl`/`.udt` file's sibling `.s7res` path (same directory,
 * same basename) -- the export convention this whole feature relies on
 * (confirmed: every real `.s7res` in the workspace has a same-named
 * `.s7dcl`/`.udt` sibling, though not every `.s7dcl` has a `.s7res` -- the
 * companion only exists when the block actually uses an MLC pragma). */
export function siblingS7ResPath(sourcePath: string): string {
  return sourcePath.replace(/\.(s7dcl|udt)$/i, ".s7res");
}

/** Reverse of `siblingS7ResPath`: a `.s7res` path -> whichever of its
 * sibling `.s7dcl`/`.udt` actually exists on disk (returns `undefined` if
 * neither does -- an orphaned `.s7res`, or one for an unsaved new file). */
export function siblingSourcePath(resPath: string): string | undefined {
  const s7dcl = resPath.replace(/\.s7res$/i, ".s7dcl");
  if (fs.existsSync(s7dcl)) return s7dcl;
  const udt = resPath.replace(/\.s7res$/i, ".udt");
  if (fs.existsSync(udt)) return udt;
  return undefined;
}

/** Scans `sourceText` (a `.s7dcl`/`.udt`'s raw text) for every MLC-family
 * pragma value token equal to `id` -- the shared core of both
 * S7ResDefinitionProvider (turns hits into jump targets) and
 * providers/rename.ts (turns hits into edits). */
export function findMlcPragmaUsages(sourceText: string, id: string): Token[] {
  return findAllMlcPragmaUsages(sourceText)
    .filter((usage) => usage.id === id)
    .map((usage) => usage.token);
}

export interface MlcPragmaUsage {
  id: string;
  token: Token;
}

/** Scans all MLC-family pragma values once. Used by cross-reference linting;
 * the id-specific wrapper above remains the provider/rename API. */
export function findAllMlcPragmaUsages(sourceText: string): MlcPragmaUsage[] {
  const tokens = new Lexer(sourceText).tokenize();
  const cur = new TokenCursor(tokens);
  const hits: MlcPragmaUsage[] = [];
  while (!cur.atEnd()) {
    const t0 = cur.peek();
    if (t0.kind === "ident" && MLC_ID_PRAGMA_KEYS.has(t0.text) && cur.peek(1).kind === "op" && cur.peek(1).text === ":=") {
      const valueTok = cur.peek(2);
      if (valueTok.kind === "string") hits.push({ id: valueTok.value ?? valueTok.text, token: valueTok });
    }
    cur.next();
  }
  return hits;
}

/** If `lineText` is a `.s7res` `- id: <ID>` line, returns the ID and its
 * 0-based [start, end) character range on that line -- used by both the
 * DefinitionProvider and RenameProvider to decide "is the cursor actually
 * on the ID token" without duplicating the regex. */
export function idOnLine(lineText: string): { id: string; start: number; end: number } | undefined {
  const m = ID_LINE_RE.exec(lineText);
  if (!m) return undefined;
  return { id: m[2], start: m[1].length, end: m[1].length + m[2].length };
}

/** Reads and parses the sibling `.s7res` for `sourcePath`, or `undefined`
 * if there isn't one / it doesn't parse. Synchronous + uncached: these are
 * small, infrequently-read text files (one read per lint/hover/decoration
 * pass), same cost tradeoff cache/typeCache.ts's own comment makes for UDT
 * sources. */
export function loadSiblingS7Res(sourcePath: string): ParsedS7Res | undefined {
  const resPath = siblingS7ResPath(sourcePath);
  if (resPath === sourcePath) return undefined; // sourcePath wasn't .s7dcl/.udt
  let text: string;
  try {
    text = fs.readFileSync(resPath, "utf8");
  } catch {
    return undefined;
  }
  return parseS7res(text) ?? undefined;
}
