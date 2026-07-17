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

export interface ResolvedMlcText {
  text: string;
  locale: string;
  line?: number;
}

const ID_LINE_RE = /^(\s*-\s*id:\s*)(\S+)\s*$/;
const LOCALE_LINE_RE = /^\s+([A-Za-z][A-Za-z-]*):\s?/;

/** Scans raw text for each entry's `- id: X` line (always a single-line,
 * unquoted scalar in every real export seen) and, best-effort, each
 * locale's own line -- used only to attach source positions to the values
 * js-yaml parses; never used to parse the VALUES themselves (quoting/block
 * scalars are real YAML, not worth re-implementing here). */
function scanPositions(text: string): Map<string, { idLine: number; idCol: number; localeLines: Map<string, number> }> {
  const lines = text.split(/\r\n|\n/);
  const result = new Map<string, { idLine: number; idCol: number; localeLines: Map<string, number> }>();
  let current: { idLine: number; idCol: number; localeLines: Map<string, number> } | undefined;
  let currentId: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idMatch = ID_LINE_RE.exec(line);
    if (idMatch) {
      currentId = idMatch[2];
      current = { idLine: i + 1, idCol: idMatch[1].length + 1, localeLines: new Map() };
      // First declaration wins on a duplicate id -- stay deterministic
      // rather than throwing (shouldn't happen in a real export).
      if (!result.has(currentId)) result.set(currentId, current);
      continue;
    }
    if (current) {
      const locMatch = LOCALE_LINE_RE.exec(line);
      if (locMatch && !current.localeLines.has(locMatch[1])) current.localeLines.set(locMatch[1], i + 1);
    }
  }
  return result;
}

/** Parses `.s7res` text into id -> {locale -> text} entries, or `null` if
 * it isn't a well-formed `MultiLingualTexts` document (malformed YAML, or
 * missing/wrong-shaped top-level key) -- don't guess on a file this parser
 * doesn't recognize. */
export function parseS7res(text: string): ParsedS7Res | null {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const list = (doc as Record<string, unknown>).MultiLingualTexts;
  if (!Array.isArray(list)) return null;

  const positions = scanPositions(text);
  const entries = new Map<string, S7ResEntry>();
  for (const item of list) {
    if (!item || typeof item !== "object" || typeof (item as Record<string, unknown>).id !== "string") continue;
    const id = (item as Record<string, unknown>).id as string;
    const pos = positions.get(id);
    if (!pos) continue; // js-yaml saw it but the line-scan didn't -- don't guess a position
    const texts = new Map<string, S7ResText>();
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (key === "id" || typeof value !== "string") continue;
      texts.set(key, { text: value, line: pos.localeLines.get(key) });
    }
    entries.set(id, { id, idLine: pos.idLine, idCol: pos.idCol, texts });
  }
  return { entries };
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
  const tokens = new Lexer(sourceText).tokenize();
  const cur = new TokenCursor(tokens);
  const hits: Token[] = [];
  while (!cur.atEnd()) {
    const t0 = cur.peek();
    if (t0.kind === "ident" && MLC_ID_PRAGMA_KEYS.has(t0.text) && cur.peek(1).kind === "op" && cur.peek(1).text === ":=") {
      const valueTok = cur.peek(2);
      if (valueTok.kind === "string" && (valueTok.value ?? valueTok.text) === id) hits.push(valueTok);
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
