// Workspace-facing wrapper around the pure caches: finds the UDT and block
// source files, keeps each file's parse in WorkspaceSources, and builds the
// type cache (buildTypeCache) and the block index from those. The workspace
// is scanned in full at activation and on request. After that, file-system
// events re-read only the files they name, and a burst of events (a save, a
// checkout, an export run) updates the caches once.
import * as vscode from "vscode";
import { RuleSet } from "../rules/types";
import { CacheDiagnostic, TypeCacheResult, buildTypeCache } from "./typeCache";
import { BlockIndex } from "../analysis/blockIndex";
import { WorkspaceSources, sourceKindOf } from "./workspaceSources";

const UDT_GLOB = "**/*.udt";
// EVERY XML export, wherever it sits. This was scoped to
// `**/PLC data types/**/*.xml`, on the assumption that TIA files UDT exports
// under that folder -- but a real project export keeps UDT XML alongside the
// code that uses it just as often, and a DATA_BLOCK export always lands next
// to its own block. The narrow glob therefore lost BOTH: instance DBs were
// invisible to the block index (every reference to one reported as an unknown
// block) and a large share of the UDT exports never reached the type cache.
//
// Each file is offered to every XML parser. They key off different root
// elements (`SW.Types.PlcStruct`, `SW.Blocks.*DB`, `SW.Tags.PlcTagTable`) and
// each returns nothing for the others' formats, so this can't misclassify
// anything -- the only cost is one read per XML in the workspace.
const XML_GLOB = "**/*.xml";
const S7DCL_GLOB = "**/*.s7dcl";
// Authored SCL source, as opposed to a TIA `.s7dcl` EXPORT -- often bundles
// several TYPE/FUNCTION_BLOCK/... declarations in one file (unlike a
// `.s7dcl` export's one-declaration-per-file convention), so it feeds BOTH
// the UDT type cache and the block index unconditionally (see
// workspaceSources.ts), rather than picking one based on the file's very
// first keyword the way S7DCL_GLOB's files do.
const SCL_GLOB = "**/*.scl";
// TIA DATA_BLOCK exports (see docs/fbd-knowhow/reference-exports/*.db). These
// declare program blocks, not UDTs, so they feed ONLY the block index -- which
// is what lets a global instance-DB call like `"R_TRIG_DB"();` resolve.
// Without them an instance DB is invisible to the workspace and every such
// call is wrongly reported as `external-symbol-not-found`.
const DB_GLOB = "**/*.db";
// Not part of the type cache itself (analysis/documentIndex.ts reads each
// document's sibling `.s7res` on demand, uncached) -- watched here anyway
// so editing an MLC comment's text triggers a relint + inline-hint refresh
// of whichever `.s7dcl`/`.udt` files reference it.
const S7RES_GLOB = "**/*.s7res";
const EXCLUDE_GLOB = "**/node_modules/**";

/** A full scan's order -- duplicate declarations resolve by it, see
 * workspaceSources.ts. */
const SOURCE_GLOBS = [UDT_GLOB, XML_GLOB, S7DCL_GLOB, SCL_GLOB, DB_GLOB];
/** Every cache source inside one folder, for a folder that appears whole. */
const FOLDER_SOURCES_GLOB = "**/*.{udt,xml,s7dcl,scl,db}";
/** Quiet time a burst of file events gets before the caches are updated once
 * for all of it... */
const UPDATE_DELAY_MS = 200;
/** ...though a steady stream of events never postpones an update longer. */
const MAX_UPDATE_DELAY_MS = 1000;

export class CacheManager {
  private result: TypeCacheResult | undefined;
  private readonly blockIndex = new BlockIndex();
  private sources = new WorkspaceSources();
  private readonly onDidRebuildEmitter = new vscode.EventEmitter<void>();
  readonly onDidRebuild = this.onDidRebuildEmitter.event;

  /** File-system events not applied yet -- see `scheduleUpdate`. */
  private readonly pendingReads = new Map<string, vscode.Uri>();
  private readonly pendingDeletes = new Set<string>();
  private readonly pendingFolders = new Map<string, vscode.Uri>();
  private pendingRelint = false;
  private pendingSince: number | undefined;
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  /** Full scans and incremental updates run one at a time, so a slow earlier
   * one can never finish last and overwrite a newer state. */
  private work: Promise<void> = Promise.resolve();

  constructor(private readonly ruleSet: RuleSet, private readonly output: vscode.OutputChannel) {}

  getDiagnosticsForFile(fsPath: string): CacheDiagnostic[] {
    return this.result?.diagnostics.filter((d) => samePath(d.file, fsPath)) ?? [];
  }

  /** Workspace-wide index of program-block .s7dcl files (FB/FC/OB/DB var
   * sections) -- powers hover/definition cross-file lookups. */
  getBlockIndex(): BlockIndex {
    return this.blockIndex;
  }

  /** The UDT/PLC-data-type dependency cache's own result -- powers
   * analysis/symbolTable.ts's cross-type member resolution (linter/
   * symbolChecks.ts's undeclared-identifier/condition-type checks).
   * Empty before the first `rebuild()` completes (never observed in
   * practice -- `extension.ts`'s `activate()` awaits one before wiring
   * any lint pass), rather than `undefined`, so callers don't need their
   * own null-check. */
  getTypeCacheResult(): TypeCacheResult {
    return this.result ?? { types: new Map(), diagnostics: [], canonicalNames: new Map() };
  }

  /** True if `fsPath` is a UDT/type-declaration source the cache understands
   * (used by extension.ts to decide which files get type-cache diagnostics
   * vs. instruction diagnostics vs. both). An XML export can declare PLC data
   * types wherever it sits (see XML_GLOB), so it counts once the scan has
   * found a declaration in it. */
  isUdtSource(fsPath: string): boolean {
    const kind = sourceKindOf(fsPath);
    return kind === "udt" || (kind === "xml" && this.sources.declaresDataTypes(fsPath));
  }

  /** Scans the whole workspace again, reading and parsing every source. */
  rebuild(): Promise<void> {
    return this.enqueue(async () => {
      // Reading every file covers whatever was still queued.
      this.clearPending();
      const scanned = new WorkspaceSources();
      for (const glob of SOURCE_GLOBS) {
        for (const uri of await vscode.workspace.findFiles(glob, EXCLUDE_GLOB)) {
          const text = await readText(uri);
          if (text !== undefined) scanned.set(uri.fsPath, text);
        }
      }
      this.sources = scanned;
      this.recompute();
    });
  }

  /** Builds the type cache and block index again from the sources already
   * scanned, without reading any file -- enough after a rule-set reload, which
   * changes how declarations resolve but not how they parse. */
  recompute(): void {
    const typeSources = this.sources.typeSources();
    this.result = buildTypeCache(this.ruleSet, typeSources);
    const { xmlBlocks, textBlocks, tags } = this.sources.blockSources();
    this.blockIndex.setScanned(xmlBlocks, textBlocks, tags);
    this.output.appendLine(
      `[S7 Lint] Type cache rebuilt: ${this.result.types.size} known types (${typeSources.length} UDT source file(s) scanned), ${this.result.diagnostics.length} diagnostic(s). ` +
        `Workspace index: ${this.blockIndex.size} block(s), ${this.blockIndex.globalTagSize} PLC tag(s) scanned.`
    );
    this.onDidRebuildEmitter.fire();
  }

  watch(context: vscode.ExtensionContext): void {
    for (const glob of [...SOURCE_GLOBS, S7RES_GLOB]) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      watcher.onDidChange((uri) => this.queueRead(uri));
      watcher.onDidCreate((uri) => this.queueRead(uri));
      watcher.onDidDelete((uri) => this.queueDelete(uri));
      context.subscriptions.push(watcher);
    }
    // A folder deleted, renamed or moved in as a whole matches none of the
    // globs above, and its files aren't necessarily reported one by one. This
    // watcher sees the folder itself; paths the globs above cover stay theirs.
    const folderWatcher = vscode.workspace.createFileSystemWatcher("**/*", false, true, false);
    folderWatcher.onDidCreate((uri) => {
      if (!sourceKindOf(uri.fsPath)) this.queueFolder(uri);
    });
    folderWatcher.onDidDelete((uri) => {
      if (!sourceKindOf(uri.fsPath)) this.queueDelete(uri);
    });
    context.subscriptions.push(folderWatcher, new vscode.Disposable(() => clearTimeout(this.updateTimer)));
  }

  private queueRead(uri: vscode.Uri): void {
    if (isExcluded(uri.fsPath)) return;
    if (sourceKindOf(uri.fsPath) === "s7res") this.pendingRelint = true;
    else this.pendingReads.set(uri.fsPath, uri);
    this.scheduleUpdate();
  }

  private queueDelete(uri: vscode.Uri): void {
    if (isExcluded(uri.fsPath)) return;
    if (sourceKindOf(uri.fsPath) === "s7res") this.pendingRelint = true;
    else this.pendingDeletes.add(uri.fsPath);
    this.scheduleUpdate();
  }

  /** A created path that may be a folder, scanned if it turns out to be one. */
  private queueFolder(uri: vscode.Uri): void {
    if (isExcluded(uri.fsPath)) return;
    this.pendingFolders.set(uri.fsPath, uri);
    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    const now = Date.now();
    this.pendingSince ??= now;
    clearTimeout(this.updateTimer);
    const delay = Math.min(UPDATE_DELAY_MS, Math.max(0, this.pendingSince + MAX_UPDATE_DELAY_MS - now));
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      this.enqueue(() => this.applyPending()).catch(() => undefined); // logged by enqueue
    }, delay);
  }

  /** Applies every queued event in one update. Removals go first, so a file
   * deleted and re-created within the same burst ends up read again. */
  private async applyPending(): Promise<void> {
    const reads = [...this.pendingReads.values()];
    const deletes = [...this.pendingDeletes];
    const folders = [...this.pendingFolders.values()];
    const relint = this.pendingRelint;
    this.clearPending();

    let changed = this.sources.deleteAll(deletes) > 0;
    for (const uri of reads) changed = (await this.readSource(uri)) || changed;
    for (const folder of folders) {
      if (!(await isFolder(folder))) continue;
      for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(folder, FOLDER_SOURCES_GLOB), EXCLUDE_GLOB)) {
        changed = (await this.readSource(uri)) || changed;
      }
    }

    if (changed) this.recompute();
    // An `.s7res` edit changes no cache, but open documents show its texts.
    else if (relint) this.onDidRebuildEmitter.fire();
  }

  /** Reads one source into the index again; one that can no longer be read
   * is dropped from it. Returns whether the index changed. */
  private async readSource(uri: vscode.Uri): Promise<boolean> {
    const text = await readText(uri);
    return text === undefined ? this.sources.deleteAll([uri.fsPath]) > 0 : this.sources.set(uri.fsPath, text);
  }

  private clearPending(): void {
    this.pendingReads.clear();
    this.pendingDeletes.clear();
    this.pendingFolders.clear();
    this.pendingRelint = false;
    this.pendingSince = undefined;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.work.then(task);
    this.work = run.catch((err) => this.output.appendLine(`[S7 Lint] Workspace index update failed: ${String(err)}`));
    return run;
  }
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8");
  } catch {
    return undefined; // deleted, or unreadable, since it was found or reported
  }
}

async function isFolder(uri: vscode.Uri): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

/** Mirrors EXCLUDE_GLOB for paths reported by a watcher, which applies no exclude of its own. */
function isExcluded(fsPath: string): boolean {
  return /[\\/]node_modules([\\/]|$)/i.test(fsPath);
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}
