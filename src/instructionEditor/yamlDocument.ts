// Comment-preserving YAML document model for one instruction-registry file.
//
// The linter loads registry YAML with js-yaml, which is fine for READ-ONLY
// consumption but destroys comments, key order, quote style and formatting on
// dump -- unacceptable for an editor whose files are full of load-bearing
// prose comments (see any real *-bit-logic.yaml header). So the editor uses
// the eemeli `yaml` package's Document/AST API instead, which round-trips
// comments and formatting. js-yaml stays the linter's loader; this is a
// parallel, editor-only path -- the two never share a parsed representation.
//
// Design rules enforced here:
//  * A file is serialized (and later written) ONLY when it has actually been
//    mutated -- `isDirty()` gates that. Untouched files are never rewritten,
//    keeping Git diffs limited to real changes.
//  * Structural operations (add/remove/rename/reorder/move) move the SAME
//    Pair node objects between documents, so each entry carries its own
//    comments and scalar styling with it -- nothing is re-parsed or
//    re-stringified in the process.
//  * Every top-level entry gets a stable synthetic `uid` (never written to
//    disk) so UI state, drag-and-drop and undo/redo can reference an entry
//    across renames and reorders without relying on array indices -- as the
//    task brief requires.
//
// vscode-free on purpose, so it runs under the plain-Node scripts/ harness.
import { Document, Node, parseDocument, Pair, Scalar, YAMLMap, YAMLSeq, isCollection, isMap, isPair, isScalar, isSeq } from "yaml";
import { FILE_LANGUAGE_KEY } from "./registryPaths";

/** eemeli toString options tuned to minimize diff churn on the (only) files
 * that are actually re-serialized:
 *  - `lineWidth: 0` disables the default 80-column wrapping that would
 *    otherwise re-fold long `notes: >-` block scalars into huge diffs;
 *  - `flowCollectionPadding: false` matches these files' dominant flow style
 *    (`[Bool]`, `[I, Q, M]`, `[]`, `{}` -- unpadded), instead of eemeli's
 *    default `[ Bool ]`. The only remaining normalization is non-empty flow
 *    maps (`{ shape: none }` -> `{shape: none}`), which are rare.
 * True byte-for-byte preservation of untouched regions is a save-path
 * refinement (CST-level surgical edits) tracked for the save phase; today the
 * dirty-flag gate already ensures unchanged FILES are never rewritten at all. */
const STRINGIFY_OPTS = { lineWidth: 0, flowCollectionPadding: false } as const;

/** Non-enumerable marker holding a top-level entry Pair's stable uid, so it
 * survives being moved between Documents but never leaks into serialization. */
const UID = Symbol("registryEntryUid");

let uidCounter = 0;
function nextUid(): string {
  uidCounter += 1;
  return `e${uidCounter}`;
}

function pairUid(pair: Pair): string {
  const existing = (pair as unknown as Record<symbol, string>)[UID];
  if (existing) return existing;
  const uid = nextUid();
  Object.defineProperty(pair, UID, { value: uid, enumerable: false, writable: false, configurable: false });
  return uid;
}

/** Match the registry's dominant style for freshly-created nodes: a sequence
 * whose items are all scalars renders in flow form (`[Bool, Word]`), the way
 * every pin `dataTypes`/`memoryAreas` list in these files is written. Nested
 * collections are left block-style (matching how `pins:` is written). */
function styleNode<T extends Node>(node: T): T {
  const isEmptyColl = (n: unknown) => isCollection(n) && (n as YAMLSeq).items.length === 0;
  const visit = (n: unknown): void => {
    if (isSeq(n)) {
      const seq = n as YAMLSeq;
      seq.items.forEach(visit);
      // A list of plain scalars renders inline: `[Bool, Word]`, `[TP, TON]`.
      if (seq.items.every((it) => isScalar(it))) seq.flow = true;
      return;
    }
    if (isMap(n)) {
      const map = n as YAMLMap;
      map.items.forEach((it) => {
        if (isPair(it)) visit(it.value);
      });
      // A small mapping of scalars renders inline, matching the registries'
      // own style for TypeRefs (`{ kind: named, name: Bool }`) and template
      // specs (`{ shape: none, keys: [], extra: {} }`) -- but NOT a big entry
      // body, which stays block-style.
      const values = map.items.filter(isPair).map((p) => p.value);
      if (values.length > 0 && values.length <= 4 && values.every((v) => isScalar(v) || isEmptyColl(v))) {
        map.flow = true;
      }
    }
  };
  visit(node);
  return node;
}

/** Source [start, end) of an entry's `key: value` text (excluding any leading
 * comment/blank lines, which the splice keeps from the original gap). Uses the
 * parsed nodes' ranges; returns undefined if either range is missing. */
function entrySpan(pair: Pair): { start: number; end: number } | undefined {
  const key = pair.key as { range?: [number, number, number] };
  const value = pair.value as { range?: [number, number, number] } | null;
  const start = key?.range?.[0];
  const end = value?.range?.[2] ?? key?.range?.[2];
  if (start == null || end == null) return undefined;
  return { start, end };
}

/** Render a single top-level entry pair as it would appear at column 0, without
 * its leading comment (the splice supplies that from the original source). The
 * pair's own inner comments are preserved. Trailing newline is trimmed so the
 * splice controls separators. */
/** Build the offset map from LF-normalized text back to the raw original.
 * CRLF normalization deletes the `\r` of each `\r\n`, so every offset after
 * one shifts by the number of `\r`s removed before it. Slicing the raw text
 * through this map lets untouched regions be copied byte-for-byte, which
 * matters for files with MIXED endings (a lone `\n` among `\r\n`s) -- blanket
 * re-normalizing those would rewrite every line that follows. */
function buildLfToRawMap(raw: string, lfLength: number): Int32Array {
  const map = new Int32Array(lfLength + 1);
  let li = 0;
  let ri = 0;
  while (ri < raw.length && li < lfLength) {
    if (raw.charCodeAt(ri) === 13 /* \r */ && raw.charCodeAt(ri + 1) === 10 /* \n */) {
      // A normalized `\n` maps to the START of its `\r\n` pair, not to the
      // `\n`. Mapping to the `\n` would make a slice that ends just before a
      // line break keep the orphaned `\r`, emitting a bare CR into the output
      // (invalid YAML) whenever rendered text follows instead of the next
      // contiguous slice. Pointing at the `\r` keeps the pair atomic:
      // contiguous slices still rejoin exactly, and a slice ending at a line
      // break cleanly excludes the whole terminator.
      map[li] = ri;
      li += 1;
      ri += 2;
      continue;
    }
    map[li] = ri;
    li += 1;
    ri += 1;
  }
  map[lfLength] = raw.length;
  return map;
}

/** Strip source ranges from a pair so it is treated as "not from this file's
 * original text" (see insertPair). */
function clearRanges(pair: Pair): void {
  const k = pair.key as { range?: unknown } | null;
  const v = pair.value as { range?: unknown } | null;
  if (k && typeof k === "object") k.range = undefined;
  if (v && typeof v === "object") v.range = undefined;
}

/**
 * Render one top-level entry pair as it appears at column 0.
 *
 * `keepLeadingComment` distinguishes the two splice cases:
 *  - false (an EXISTING entry being re-rendered in place): the splice already
 *    copied that entry's leading comment/blank line from the original source
 *    gap, so re-emitting them here would duplicate them.
 *  - true (a NEW or MOVED-IN entry): there is no source gap to carry them, so
 *    the pair's own comments must be emitted or they'd be lost -- this is what
 *    keeps an entry's comment with it across a cross-file move.
 */
function renderPair(pair: Pair, keepLeadingComment = false): string {
  const key = pair.key as { commentBefore?: unknown; spaceBefore?: unknown } | null;
  const savedKeyComment = key?.commentBefore;
  const savedKeySpace = key?.spaceBefore;
  const savedPairComment = (pair as { commentBefore?: unknown }).commentBefore;
  if (!keepLeadingComment) {
    if (key && typeof key === "object") {
      key.commentBefore = undefined;
      key.spaceBefore = false;
    }
    (pair as { commentBefore?: unknown }).commentBefore = undefined;
  }
  try {
    const tmp = new Document(null);
    const map = new YAMLMap();
    map.items.push(pair);
    tmp.contents = map;
    // Exactly one trailing newline: a parsed entry's source span ends at the
    // start of the NEXT key (its trailing newline is inside the span), so the
    // splice needs the newline reproduced here to keep entries separated.
    return tmp.toString(STRINGIFY_OPTS).replace(/\n*$/, "\n");
  } finally {
    if (!keepLeadingComment) {
      if (key && typeof key === "object") {
        key.commentBefore = savedKeyComment;
        key.spaceBefore = savedKeySpace;
      }
      (pair as { commentBefore?: unknown }).commentBefore = savedPairComment;
    }
  }
}

function keyString(pair: Pair): string {
  const k = pair.key;
  return isScalarKey(k) ? String(k.value) : String(k);
}

function isScalarKey(k: unknown): k is Scalar {
  return !!k && typeof k === "object" && "value" in (k as object);
}

export interface EntryRef {
  /** Stable synthetic id; safe across renames/reorders/moves within a session. */
  uid: string;
  /** Current instruction name (the top-level mapping key). */
  name: string;
}

/** One editable instruction-registry file, wrapping an eemeli Document. */
export class RegistryDocument {
  // Typed as the mutable Document (not Document.Parsed) because structural
  // edits install fresh YAMLMap/Pair nodes that aren't "Parsed" nodes.
  private doc: Document;
  private dirty = false;
  /** The file's original newline style, reproduced on serialize. eemeli always
   * emits `\n`; without this a CRLF (Windows) file would come back all-LF and
   * every single line would show as changed in Git. */
  private readonly newline: "\r\n" | "\n";
  /** Original on-disk text, in eemeli's internal `\n` form. Parsed node source
   * ranges are offsets into THIS string. */
  private readonly originalLf: string;
  /** The original on-disk text EXACTLY as read (line endings untouched). The
   * splice copies untouched regions from here so files with mixed or unusual
   * line endings survive byte-for-byte -- normalizing them would rewrite every
   * following line. */
  private readonly originalRaw: string;
  /** Maps an offset in `originalLf` to the corresponding offset in
   * `originalRaw` (they diverge by each `\r` that CRLF normalization removed). */
  private readonly lfToRaw: Int32Array;
  /** Set only by operations the splice CANNOT reconstruct: removal and
   * reordering. Both invalidate the "walk entries in source order, copying
   * untouched spans" assumption (a removed entry's bytes would be re-emitted
   * inside the following gap; a reorder would need spans moved around), so
   * those fall back to a full re-render.
   *
   * Field edits, renames and INSERTIONS stay spliceable: an edited/renamed
   * entry re-renders in place, and a brand-new entry (which has no source
   * range) is rendered inline at its position -- leaving every other entry
   * byte-identical. That matters most for big, heavily-commented files like
   * type-registry/system-types.yaml, where adding one type must not reflow
   * the other thousand lines. */
  private structural = false;
  /** uids of entries whose fields were edited (fast-path re-render targets). */
  private readonly dirtyEntries = new Set<string>();

  private constructor(doc: Document, newline: "\r\n" | "\n", originalLf: string, originalRaw: string) {
    this.doc = doc;
    this.newline = newline;
    this.originalLf = originalLf;
    this.originalRaw = originalRaw;
    this.lfToRaw = buildLfToRawMap(originalRaw, originalLf.length);
    // Assign uids up front so identity is stable from first load.
    for (const pair of this.topLevelPairs()) pairUid(pair);
  }

  static parse(text: string): RegistryDocument {
    // Dominant newline, used only for text this editor RENDERS (new/edited
    // entries). Untouched regions keep whatever they had, byte-for-byte.
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    // Parse the LF-normalized text so parsed node source ranges are in the
    // SAME coordinate space as `originalLf`. Parsing the raw CRLF text would
    // put ranges off by one per preceding `\r`, corrupting the splice.
    const lf = text.replace(/\r\n/g, "\n");
    const doc = parseDocument(lf, { keepSourceTokens: true });
    return new RegistryDocument(doc, newline, lf, text);
  }

  /** Slice the ORIGINAL raw text using offsets expressed in LF coordinates. */
  private rawSlice(lfStart: number, lfEnd?: number): string {
    const start = this.lfToRaw[Math.max(0, Math.min(lfStart, this.originalLf.length))];
    if (lfEnd == null) return this.originalRaw.slice(start);
    const end = this.lfToRaw[Math.max(0, Math.min(lfEnd, this.originalLf.length))];
    return this.originalRaw.slice(start, end);
  }

  /** Convert rendered (always-LF) text to this file's dominant newline. */
  private toFileNewlines(lfText: string): string {
    return this.newline === "\r\n" ? lfText.replace(/\n/g, "\r\n") : lfText;
  }

  /** Serialize the current state. Callers should only persist this when
   * `isDirty()` -- see class header.
   *
   * To keep Git diffs minimal, a file whose only changes are field edits
   * (no entry added/removed/renamed/reordered) is rebuilt by splicing the
   * freshly-rendered text of ONLY the edited entries into the original source
   * -- so every untouched entry (and its comments, folded `notes` wrapping,
   * spacing) stays byte-for-byte identical. Structural changes fall back to a
   * full re-render. The file's original newline style is reapplied last. */
  toText(): string {
    // Full render (removal/reorder) inevitably re-emits everything, so it
    // normalizes to the dominant newline. The splice path returns raw text
    // already, preserving untouched bytes exactly.
    if (this.structural) return this.toFileNewlines(this.fullRender());
    return this.spliceRender();
  }

  private fullRender(): string {
    return this.doc.toString(STRINGIFY_OPTS);
  }

  /** Rebuild from the original source, re-rendering ONLY the entries that
   * changed and rendering brand-new entries inline; every other entry (and all
   * comments, spacing and folded-scalar wrapping) is copied through verbatim.
   *
   * Walks the current entries in order, keeping a cursor into the original
   * text: an untouched entry flows through with its preceding gap, an edited
   * one has its span replaced, and a new one (no source range) is emitted at
   * its position. Removal/reorder never reach here (they set `structural`). */
  private spliceRender(): string {
    const pairs = this.topLevelPairs();
    const newPairs = pairs.filter((p) => !entrySpan(p));
    // Nothing rendered at all -> the file is byte-identical to what we read.
    if (this.dirtyEntries.size === 0 && newPairs.length === 0) return this.originalRaw;
    const nl = this.newline;
    let out = "";
    let cursor = 0; // in LF coordinates
    for (const pair of pairs) {
      const span = entrySpan(pair);
      if (!span) {
        // Brand-new / moved-in entry: render it here, separated by a blank
        // line to match how entries are spaced in these files.
        const sep = out.endsWith(nl + nl) || (out === "" && cursor === 0) ? "" : out.endsWith(nl) ? nl : nl + nl;
        // keepLeadingComment: no source gap carries its comments, so emit them
        // here -- this is how a moved entry keeps its comment.
        out += sep + this.toFileNewlines(renderPair(pair, true));
        continue;
      }
      out += this.rawSlice(cursor, span.start); // gap: comments/blank lines
      out += this.dirtyEntries.has(pairUid(pair))
        ? this.toFileNewlines(renderPair(pair))
        : this.rawSlice(span.start, span.end); // untouched -> byte-exact
      cursor = span.end;
    }
    out += this.rawSlice(cursor);
    return out;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  markClean(): void {
    this.dirty = false;
  }

  /** Force a re-parsed document to report as dirty (used when restoring an
   * undo/redo snapshot: its text differs from the on-disk baseline, so it must
   * be re-written on the next Save). No `structural` flag: the document was
   * parsed FROM the restored text, so its source ranges are valid and the
   * splice reproduces that text byte-for-byte. */
  markDirty(): void {
    this.dirty = true;
  }

  /** Any YAML parse errors eemeli recorded (malformed source). */
  parseErrors(): string[] {
    return this.doc.errors.map((e) => e.message);
  }

  /** The file-level `$fileLanguage` default, if present. */
  fileLanguage(): string[] | undefined {
    const node = this.doc.get(FILE_LANGUAGE_KEY);
    if (node == null) return undefined;
    const js = (this.doc.get(FILE_LANGUAGE_KEY, true) as { toJSON?: () => unknown })?.toJSON?.();
    return Array.isArray(js) ? (js as string[]) : undefined;
  }

  private contents(): YAMLMap {
    if (!isMap(this.doc.contents)) {
      // An empty or non-mapping file: install an empty map so edits work.
      this.doc.contents = new YAMLMap();
    }
    return this.doc.contents as YAMLMap;
  }

  /** Top-level Pairs that are real instruction entries (excludes the reserved
   * `$fileLanguage` key), in document order. */
  private topLevelPairs(): Pair[] {
    const map = isMap(this.doc.contents) ? (this.doc.contents as YAMLMap) : undefined;
    if (!map) return [];
    return map.items.filter((it): it is Pair => isPair(it) && keyString(it) !== FILE_LANGUAGE_KEY);
  }

  /** Ordered entry refs (uid + current name) for the navigation tree. */
  entries(): EntryRef[] {
    return this.topLevelPairs().map((pair) => ({ uid: pairUid(pair), name: keyString(pair) }));
  }

  private findPair(uid: string): Pair | undefined {
    return this.topLevelPairs().find((p) => pairUid(p) === uid);
  }

  private findPairByName(name: string): Pair | undefined {
    return this.topLevelPairs().find((p) => keyString(p) === name);
  }

  /** Plain-JS view of one entry's value, for validation and the form editor.
   * Preserves unknown fields (they simply appear in the returned object), so
   * nothing the editor doesn't model is lost. */
  entryJS(uid: string): Record<string, unknown> | undefined {
    const pair = this.findPair(uid);
    if (!pair) return undefined;
    const value = pair.value as { toJSON?: () => unknown } | null;
    const js = value?.toJSON?.();
    return js && typeof js === "object" ? (js as Record<string, unknown>) : {};
  }

  hasName(name: string): boolean {
    return !!this.findPairByName(name);
  }

  // --- structural mutations (each sets dirty) ---------------------------

  /** Rename an entry in place, preserving its value node and all comments.
   * Returns false if the new name collides with a different existing entry. */
  renameEntry(uid: string, newName: string): boolean {
    const pair = this.findPair(uid);
    if (!pair) return false;
    const clash = this.findPairByName(newName);
    if (clash && pairUid(clash) !== uid) return false;
    if (isScalarKey(pair.key)) {
      (pair.key as Scalar).value = newName;
    } else {
      pair.key = new Scalar(newName);
    }
    this.dirty = true;
    // Spliceable: only this entry re-renders (with its new key).
    this.dirtyEntries.add(uid);
    return true;
  }

  /** Insert an already-built entry Pair at `index` (default: append). Keeps
   * the pair's own uid if it has one (used by cross-file moves), else assigns
   * a fresh one. */
  insertPair(pair: Pair, index?: number): string {
    const uid = pairUid(pair);
    const map = this.contents();
    // Compute the splice position among ALL top-level items, translating an
    // entry-relative index (which skips $fileLanguage) to an items index.
    const items = map.items;
    const entryPairs = this.topLevelPairs();
    let insertAt = items.length;
    if (index != null && index < entryPairs.length) {
      const target = entryPairs[index];
      insertAt = items.indexOf(target);
    }
    // Drop any source ranges the pair carries: either it is brand-new (none),
    // or it came from ANOTHER document, whose offsets are meaningless here --
    // leaving them would make spliceRender slice THIS file's text at the other
    // file's coordinates. Range-less pairs are rendered inline instead.
    clearRanges(pair);
    items.splice(insertAt, 0, pair);
    this.dirty = true;
    // NOT structural: a range-less pair renders inline, so every existing
    // entry in this file stays byte-identical.
    return uid;
  }

  /** Remove and return an entry Pair (for cross-file moves), or undefined. */
  extractPair(uid: string): Pair | undefined {
    const map = this.contents();
    const idx = map.items.findIndex((it) => isPair(it) && pairUid(it) === uid);
    if (idx < 0) return undefined;
    const [pair] = map.items.splice(idx, 1);
    this.dirty = true;
    this.structural = true;
    return pair as Pair;
  }

  deleteEntry(uid: string): boolean {
    return !!this.extractPair(uid);
  }

  /** Reorder an entry to a new entry-relative position within this file. */
  moveEntryWithin(uid: string, toIndex: number): boolean {
    const pair = this.extractPair(uid);
    if (!pair) return false;
    this.insertPair(pair, toIndex);
    return true;
  }

  /** Reorder this file's entries to match `orderedUids` exactly (a full
   * permutation of the current entries). Entries whose uid is omitted keep
   * their relative order, appended after the listed ones. Used by
   * within-file drag-and-drop, which computes the whole new order up front to
   * avoid index-shift bugs. Non-entry items ($fileLanguage) stay in place. */
  reorderEntries(orderedUids: string[]): boolean {
    if (!isMap(this.doc.contents)) return false;
    const map = this.doc.contents as YAMLMap;
    const entryPairs = this.topLevelPairs();
    const byUid = new Map(entryPairs.map((p) => [pairUid(p), p]));
    const ordered: Pair[] = [];
    for (const uid of orderedUids) {
      const p = byUid.get(uid);
      if (p && !ordered.includes(p)) ordered.push(p);
    }
    for (const p of entryPairs) if (!ordered.includes(p)) ordered.push(p);
    // Rebuild items: keep non-entry items ($fileLanguage) at their positions,
    // fill entry slots with the new order.
    const entrySet = new Set<unknown>(entryPairs);
    let i = 0;
    map.items = map.items.map((it) => (entrySet.has(it) ? ordered[i++] : it));
    this.dirty = true;
    this.structural = true;
    return true;
  }

  /** Set a field at `path` within an entry (path relative to the entry's
   * value map, e.g. `["family"]` or `["pins", 0, "dir"]`). Untouched
   * sibling nodes -- and their comments -- are preserved: only the addressed
   * node is replaced. Intermediate maps/seqs are created as needed. */
  setEntryField(uid: string, path: (string | number)[], value: unknown): boolean {
    const pair = this.findPair(uid);
    if (!pair) return false;
    const node = styleNode(this.doc.createNode(value));
    if (path.length === 0) {
      pair.value = node;
    } else {
      if (!isCollection(pair.value)) return false;
      (pair.value as YAMLMap).setIn(path, node);
    }
    this.dirty = true;
    this.dirtyEntries.add(uid);
    return true;
  }

  /** Remove a field at `path` within an entry. Returns whether it existed. */
  deleteEntryField(uid: string, path: (string | number)[]): boolean {
    const pair = this.findPair(uid);
    if (!pair || path.length === 0 || !isCollection(pair.value)) return false;
    const ok = (pair.value as YAMLMap).deleteIn(path);
    if (ok) {
      this.dirty = true;
      this.dirtyEntries.add(uid);
    }
    return ok;
  }

  /** Build a new entry Pair from a plain-JS value and add it. The value object
   * is turned into properly-styled YAML nodes by eemeli. Returns its uid. */
  addEntry(name: string, value: unknown, index?: number): string {
    // styleNode gives freshly-created nodes the registries' own flow/block
    // conventions, so a new entry doesn't stand out from hand-written ones.
    const valueNode = styleNode(this.doc.createNode(value));
    const pair = new Pair(new Scalar(name), valueNode);
    return this.insertPair(pair, index);
  }

  /** Deep-clone an existing entry's value into a new named entry (duplicate).
   * Cloning via JS round-trips the value but drops comments on the copy --
   * acceptable for a duplicate, whose comments would otherwise be misleading. */
  duplicateEntry(uid: string, newName: string, index?: number): string | undefined {
    const js = this.entryJS(uid);
    if (js === undefined) return undefined;
    return this.addEntry(newName, js, index);
  }

  /** Raw access to the underlying Pair for a cross-document move -- callers in
   * the ops layer use extractPair/insertPair; exposed for tests. */
  _pairForTest(uid: string): Pair | undefined {
    return this.findPair(uid);
  }
}
