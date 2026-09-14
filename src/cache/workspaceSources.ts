// Per-file scan results for every workspace source the type cache and the
// block index are built from. Keeping each file's parse lets a change re-read
// and re-parse only that file: building the type cache and merging the block
// index from the stored results is in-memory work. Pure, no vscode
// dependency -- cache/cacheManager.ts wires it to file discovery and watching.
import { BlockInfo, GlobalTagInfo, scanBlockFile, scanBlockXmlFile } from "../analysis/blockIndex";
import { parsePlcTagXml } from "../parser/plcTagXmlParser";
import { detectS7dclKind } from "../parser/s7dclParser";
import { parseUdtText } from "../parser/udtTextParser";
import { parseUdtXml } from "../parser/udtXmlParser";
import { UdtSourceFile } from "./typeCache";

/** A workspace file the extension watches, by extension. `.s7res` files are
 * watched only to re-lint -- nothing in them feeds a cache, so they are never
 * stored here. */
export type SourceKind = "udt" | "xml" | "s7dcl" | "scl" | "db" | "s7res";

type StoredKind = Exclude<SourceKind, "s7res">;

const KIND_BY_EXTENSION: Record<string, SourceKind> = {
  ".udt": "udt",
  ".xml": "xml",
  ".s7dcl": "s7dcl",
  ".scl": "scl",
  ".db": "db",
  ".s7res": "s7res",
};

/** The order a full workspace scan offers sources in. Duplicate declarations
 * resolve by it -- the first PLC data type of a name wins, a later text block
 * wins over an earlier one -- so reading sources back in this order keeps an
 * incremental update's result the same as a full rebuild's. */
const TYPE_SOURCE_ORDER: StoredKind[] = ["udt", "xml", "s7dcl", "scl"];
const TEXT_BLOCK_ORDER: StoredKind[] = ["s7dcl", "scl", "db"];

export function sourceKindOf(fsPath: string): SourceKind | undefined {
  const extension = /\.[^.\\/]+$/.exec(fsPath);
  return extension ? KIND_BY_EXTENSION[extension[0].toLowerCase()] : undefined;
}

interface SourceEntry {
  path: string;
  kind: StoredKind;
  udtDecls: UdtSourceFile["decls"];
  /** Program blocks from `.s7dcl`, `.scl` and `.db` text. */
  textBlocks: BlockInfo[];
  /** DATA_BLOCKs from XML exports. */
  xmlBlocks: BlockInfo[];
  tags: GlobalTagInfo[];
}

function scanSource(fsPath: string, kind: StoredKind, text: string): SourceEntry {
  const entry: SourceEntry = { path: fsPath, kind, udtDecls: [], textBlocks: [], xmlBlocks: [], tags: [] };
  switch (kind) {
    case "udt":
      entry.udtDecls = parseUdtText(text);
      break;
    case "xml":
      // An XML export is a PLC data type, a DATA_BLOCK or a PLC tag table.
      // Each parser returns nothing for the formats it doesn't own, so the
      // file is offered to all three rather than classified up front.
      entry.udtDecls = parseUdtXml(text);
      entry.xmlBlocks = scanBlockXmlFile(fsPath, text);
      entry.tags = parsePlcTagXml(text).map((tag) => ({ ...tag, file: fsPath }));
      break;
    case "s7dcl": {
      // A `.s7dcl` export holds either one TYPE or one program block.
      const exportKind = detectS7dclKind(text);
      if (exportKind === "type") entry.udtDecls = parseUdtText(text);
      else if (exportKind === "block") entry.textBlocks = scanBlockFile(fsPath, text);
      break;
    }
    case "scl":
      // Authored SCL often bundles TYPEs and program blocks in one file.
      entry.udtDecls = parseUdtText(text);
      entry.textBlocks = scanBlockFile(fsPath, text);
      break;
    case "db":
      entry.textBlocks = scanBlockFile(fsPath, text);
      break;
  }
  return entry;
}

export class WorkspaceSources {
  /** Keyed by `comparable(path)`, in the order sources were first stored. */
  private readonly entries = new Map<string, SourceEntry>();

  /** `caseInsensitive`: whether two spellings of a path that differ only in
   * case name the same file -- true for the default Windows and macOS file
   * systems. */
  constructor(private readonly caseInsensitive = process.platform === "win32" || process.platform === "darwin") {}

  get size(): number {
    return this.entries.size;
  }

  /** Stores `text` as the current content of `fsPath`, replacing everything
   * that file declared before. Returns false for a file no cache reads. */
  set(fsPath: string, text: string): boolean {
    const kind = sourceKindOf(fsPath);
    if (!kind || kind === "s7res") return false;
    this.entries.set(this.comparable(fsPath), scanSource(fsPath, kind, text));
    return true;
  }

  /** Removes every stored source that is one of `paths` or lies inside one of
   * them -- a folder deleted or renamed as a whole is reported as one path.
   * Returns how many sources were removed. */
  deleteAll(paths: Iterable<string>): number {
    const gone = new Set<string>();
    for (const fsPath of paths) gone.add(this.comparable(fsPath));
    if (gone.size === 0) return 0;
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (isAtOrInside(key, gone)) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** True if `fsPath` is stored and declares at least one PLC data type. */
  declaresDataTypes(fsPath: string): boolean {
    return (this.entries.get(this.comparable(fsPath))?.udtDecls.length ?? 0) > 0;
  }

  /** `buildTypeCache`'s input: every source declaring PLC data types. */
  typeSources(): UdtSourceFile[] {
    return this.inScanOrder(TYPE_SOURCE_ORDER)
      .filter((entry) => entry.udtDecls.length > 0)
      .map((entry) => ({ path: entry.path, decls: entry.udtDecls }));
  }

  /** `BlockIndex.setScanned`'s input: every scanned block and PLC tag. */
  blockSources(): { xmlBlocks: BlockInfo[]; textBlocks: BlockInfo[]; tags: GlobalTagInfo[] } {
    const xmlEntries = this.inScanOrder(["xml"]);
    return {
      xmlBlocks: xmlEntries.flatMap((entry) => entry.xmlBlocks),
      textBlocks: this.inScanOrder(TEXT_BLOCK_ORDER).flatMap((entry) => entry.textBlocks),
      tags: xmlEntries.flatMap((entry) => entry.tags),
    };
  }

  private inScanOrder(kinds: StoredKind[]): SourceEntry[] {
    const entries = [...this.entries.values()];
    return kinds.flatMap((kind) => entries.filter((entry) => entry.kind === kind));
  }

  private comparable(fsPath: string): string {
    const normalized = fsPath.replace(/\\/g, "/").replace(/\/+$/, "");
    return this.caseInsensitive ? normalized.toLowerCase() : normalized;
  }
}

/** True if `key`, or a folder containing it, is in `gone`. */
function isAtOrInside(key: string, gone: Set<string>): boolean {
  let candidate = key;
  for (;;) {
    if (gone.has(candidate)) return true;
    const slash = candidate.lastIndexOf("/");
    if (slash <= 0) return false;
    candidate = candidate.slice(0, slash);
  }
}
