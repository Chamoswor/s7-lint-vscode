// Workspace-facing wrapper around the pure buildTypeCache() logic: finds
// UDT source files, parses them, rebuilds the cache, and watches for
// changes. Per udt-dependency-cache.md's own "Incremental updates" note,
// these are small text/XML files -- a full rebuild on every relevant
// change is cheap and simpler than the doc's scoped-recompute
// optimization, which this v1 doesn't implement.
import * as vscode from "vscode";
import { parseUdtText } from "../parser/udtTextParser";
import { parseUdtXml } from "../parser/udtXmlParser";
import { detectS7dclKind } from "../parser/s7dclParser";
import { RuleSet } from "../rules/types";
import { CacheDiagnostic, TypeCacheResult, UdtSourceFile, buildTypeCache } from "./typeCache";
import { BlockIndex } from "../analysis/blockIndex";

const UDT_GLOB = "**/*.udt";
// EVERY XML export, wherever it sits. This was scoped to
// `**/PLC data types/**/*.xml`, on the assumption that TIA files UDT exports
// under that folder -- but a real project export keeps UDT XML alongside the
// code that uses it just as often, and a DATA_BLOCK export always lands next
// to its own block. The narrow glob therefore lost BOTH: instance DBs were
// invisible to the block index (every reference to one reported as an unknown
// block) and a large share of the UDT exports never reached the type cache.
//
// Each file is offered to both parsers. They key off different root elements
// (`SW.Types.PlcStruct` vs `SW.Blocks.*DB`) and each returns nothing for the
// other's format, so this can't misclassify anything -- the only cost is one
// read per XML in the workspace.
const XML_GLOB = "**/*.xml";
const S7DCL_GLOB = "**/*.s7dcl";
// Authored SCL source, as opposed to a TIA `.s7dcl` EXPORT -- often bundles
// several TYPE/FUNCTION_BLOCK/... declarations in one file (unlike a
// `.s7dcl` export's one-declaration-per-file convention), so it feeds BOTH
// the UDT type cache and the block index unconditionally (see rebuild()),
// rather than picking one based on the file's very first keyword the way
// S7DCL_GLOB's files do.
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
// of whichever `.s7dcl`/`.udt` files reference it, same as any other
// workspace change this watcher already reacts to.
const S7RES_GLOB = "**/*.s7res";
const EXCLUDE_GLOB = "**/node_modules/**";

export class CacheManager {
  private result: TypeCacheResult | undefined;
  private readonly blockIndex = new BlockIndex();
  private readonly onDidRebuildEmitter = new vscode.EventEmitter<void>();
  readonly onDidRebuild = this.onDidRebuildEmitter.event;

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
    return this.result ?? { types: new Map(), diagnostics: [] };
  }

  /** True if `fsPath` is a UDT/type-declaration source the cache understands
   * (used by extension.ts to decide which files get type-cache diagnostics
   * vs. instruction diagnostics vs. both). */
  isUdtSource(fsPath: string): boolean {
    if (fsPath.toLowerCase().endsWith(".udt")) return true;
    if (fsPath.toLowerCase().endsWith(".xml") && /plc data types/i.test(fsPath)) return true;
    return false;
  }

  async rebuild(): Promise<void> {
    const files: UdtSourceFile[] = [];

    const udtUris = await vscode.workspace.findFiles(UDT_GLOB, EXCLUDE_GLOB);
    for (const uri of udtUris) {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8");
      const decls = parseUdtText(text);
      if (decls.length > 0) files.push({ path: uri.fsPath, decls });
    }

    // One XML export is either a UDT (feeding the type cache) or a block --
    // TIA writes DATA_BLOCKs in this format even when the FUNCTION_BLOCK they
    // instance is exported as text -- so each file is offered to both parsers
    // and whichever recognises it claims it.
    const xmlBlockFiles: { path: string; text: string }[] = [];
    const xmlUris = await vscode.workspace.findFiles(XML_GLOB, EXCLUDE_GLOB);
    for (const uri of xmlUris) {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8");
      const decls = parseUdtXml(text);
      if (decls.length > 0) files.push({ path: uri.fsPath, decls });
      xmlBlockFiles.push({ path: uri.fsPath, text });
    }

    // .s7dcl files are either a TYPE (UDT) declaration or a program block --
    // detectS7dclKind tells them apart. TYPE-kind feeds the UDT type cache
    // (per udt-dependency-cache.md); block-kind feeds the cross-file block
    // index (FB/FC/OB/DB var sections, for hover/definition).
    const s7dclUris = await vscode.workspace.findFiles(S7DCL_GLOB, EXCLUDE_GLOB);
    const blockFiles: { path: string; text: string }[] = [];
    for (const uri of s7dclUris) {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8");
      const kind = detectS7dclKind(text);
      if (kind === "type") {
        const decls = parseUdtText(text);
        if (decls.length > 0) files.push({ path: uri.fsPath, decls });
      } else if (kind === "block") {
        blockFiles.push({ path: uri.fsPath, text });
      }
    }

    const sclUris = await vscode.workspace.findFiles(SCL_GLOB, EXCLUDE_GLOB);
    for (const uri of sclUris) {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8");
      const decls = parseUdtText(text);
      if (decls.length > 0) files.push({ path: uri.fsPath, decls });
      blockFiles.push({ path: uri.fsPath, text });
    }

    // `.db` exports are always program blocks (a DATA_BLOCK declaration),
    // never UDT sources -- so they go straight to the block index without the
    // detectS7dclKind branch `.s7dcl` needs.
    const dbUris = await vscode.workspace.findFiles(DB_GLOB, EXCLUDE_GLOB);
    for (const uri of dbUris) {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8");
      blockFiles.push({ path: uri.fsPath, text });
    }

    this.result = buildTypeCache(this.ruleSet, files);
    this.blockIndex.rebuild(blockFiles, xmlBlockFiles);
    this.output.appendLine(
      `[S7 Lint] Type cache rebuilt: ${this.result.types.size} known types (${files.length} UDT source file(s) scanned), ${this.result.diagnostics.length} diagnostic(s). ` +
        `Block index: ${this.blockIndex.size} block(s) scanned.`
    );
    this.onDidRebuildEmitter.fire();
  }

  watch(context: vscode.ExtensionContext, onChange: () => void): void {
    for (const glob of [UDT_GLOB, XML_GLOB, S7DCL_GLOB, S7RES_GLOB, SCL_GLOB, DB_GLOB]) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      watcher.onDidChange(onChange);
      watcher.onDidCreate(onChange);
      watcher.onDidDelete(onChange);
      context.subscriptions.push(watcher);
    }
  }
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}
