// Regression tests for incremental workspace indexing. Every relevant file
// event used to re-read and re-parse every UDT and block source in the
// workspace, once per event, with overlapping rebuilds free to finish out of
// order. WorkspaceSources keeps each file's parse; CacheManager re-reads only
// the files an event names, applies a burst of events as one update, and runs
// updates one at a time.
"use strict";
const assert = require("assert").strict;
const path = require("path");
const Module = require("module");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "vscode") return require.resolve("./vscode-shim.js");
  return originalResolve.call(this, request, ...args);
};

const vscode = require("./vscode-shim.js");
const { loadRuleSet } = require("../out/rules/loadRules");
const { BlockIndex } = require("../out/analysis/blockIndex");
const { lookupType } = require("../out/cache/typeCache");
const { WorkspaceSources, sourceKindOf } = require("../out/cache/workspaceSources");
const { CacheManager } = require("../out/cache/cacheManager");

const ruleSet = loadRuleSet(path.join(__dirname, "..", "resources"));

// --- source texts ------------------------------------------------------------
const udtText = (name, valueType = "Int") =>
  `TYPE "${name}"\nVERSION : 0.1\n   STRUCT\n      Value : ${valueType};\n   END_STRUCT;\nEND_TYPE\n`;
const fbText = (name) => `FUNCTION_BLOCK "${name}"\nVAR_INPUT\n   Start : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n`;
const globalDbText = (name) => `DATA_BLOCK "${name}"\nVAR\n   Count : Int;\nEND_VAR\nBEGIN\nEND_DATA_BLOCK\n`;
const xmlUdt = (name) => `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Types.PlcStruct ID="0">
    <AttributeList>
      <Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">
  <Section Name="None">
    <Member Name="Flag" Datatype="Bool" />
  </Section>
</Sections></Interface>
      <Name>${name}</Name>
    </AttributeList>
  </SW.Types.PlcStruct>
</Document>
`;
const xmlGlobalDb = (name) => `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Blocks.GlobalDB ID="0">
    <AttributeList>
      <Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">
  <Section Name="Static">
    <Member Name="Setpoint" Datatype="Real" />
  </Section>
</Sections></Interface>
      <Name>${name}</Name>
    </AttributeList>
  </SW.Blocks.GlobalDB>
</Document>
`;
const xmlTags = (name) => `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Tags.PlcTagTable ID="0">
    <AttributeList><Name>Tags</Name></AttributeList>
    <ObjectList>
      <SW.Tags.PlcTag ID="1" CompositionName="Tags">
        <AttributeList><DataTypeName>Bool</DataTypeName><LogicalAddress>%I0.0</LogicalAddress><Name>${name}</Name></AttributeList>
      </SW.Tags.PlcTag>
    </ObjectList>
  </SW.Tags.PlcTagTable>
</Document>
`;

const typeNames = (sources) => sources.typeSources().flatMap((file) => file.decls.map((decl) => decl.name));

// --- WorkspaceSources ----------------------------------------------------------
assert.equal(sourceKindOf("C:/proj/Motor.SCL"), "scl");
assert.equal(sourceKindOf("C:/proj.v2/README"), undefined, "a dot in a folder name is not an extension");

const sources = new WorkspaceSources(true);
assert.equal(sources.set("C:/proj/blocks/Motor.s7res", "Texts: {}\n"), false, "an .s7res file feeds no cache");
sources.set("C:/proj/blocks/Motor.scl", udtText("UDT_FromScl") + "\n" + fbText("FB_Motor"));
sources.set("C:/proj/blocks/Shared_DB.db", globalDbText("Shared_DB"));
sources.set("C:/proj/blocks/Type.s7dcl", udtText("UDT_FromS7dcl"));
sources.set("C:/proj/exports/Recipe.xml", xmlUdt("UDT_FromXml"));
sources.set("C:/proj/exports/Shared_DB.xml", xmlGlobalDb("Shared_DB"));
sources.set("C:/proj/exports/Tags.xml", xmlTags("DI_Start"));
sources.set("C:/proj/types/Motor.udt", udtText("UDT_FromUdt"));
assert.equal(sources.size, 7);

assert.deepEqual(
  typeNames(sources),
  ["UDT_FromUdt", "UDT_FromXml", "UDT_FromS7dcl", "UDT_FromScl"],
  "PLC data types come back in full-scan order (.udt, .xml, .s7dcl, .scl), however they were stored"
);
assert.ok(sources.declaresDataTypes("c:\\proj\\EXPORTS\\recipe.xml"), "paths compare without case or separator differences here");
assert.ok(!sources.declaresDataTypes("C:/proj/exports/Tags.xml"));

const scanned = sources.blockSources();
assert.deepEqual(scanned.textBlocks.map((b) => b.name), ["FB_Motor", "Shared_DB"]);
assert.deepEqual(scanned.xmlBlocks.map((b) => b.name), ["Shared_DB"]);
assert.deepEqual(scanned.tags.map((t) => [t.name, t.file]), [["DI_Start", "C:/proj/exports/Tags.xml"]]);

// Blocks scanned per file merge exactly as a whole-workspace rebuild does.
const summarize = (index) => ({
  blocks: index.values().map((b) => [b.name, b.file, b.blockType, b.declLine]),
  tags: index.globalTagValues().map((t) => [t.name, t.file, t.line]),
});
const viaRebuild = new BlockIndex();
viaRebuild.rebuild(
  [
    { path: "C:/proj/blocks/Motor.scl", text: udtText("UDT_FromScl") + "\n" + fbText("FB_Motor") },
    { path: "C:/proj/blocks/Shared_DB.db", text: globalDbText("Shared_DB") },
  ],
  [
    { path: "C:/proj/exports/Recipe.xml", text: xmlUdt("UDT_FromXml") },
    { path: "C:/proj/exports/Shared_DB.xml", text: xmlGlobalDb("Shared_DB") },
    { path: "C:/proj/exports/Tags.xml", text: xmlTags("DI_Start") },
  ]
);
const viaScanned = new BlockIndex();
viaScanned.setScanned(scanned.xmlBlocks, scanned.textBlocks, scanned.tags);
assert.deepEqual(summarize(viaScanned), summarize(viaRebuild));
assert.equal(viaScanned.get("Shared_DB").file, "C:/proj/blocks/Shared_DB.db", "a text block still wins over an XML block of the same name");

sources.set("C:/proj/types/Motor.udt", udtText("UDT_Renamed"));
assert.ok(!typeNames(sources).includes("UDT_FromUdt") && typeNames(sources).includes("UDT_Renamed"), "storing a file again replaces what it declared");

sources.set("C:/proj/exports-old/Recipe.xml", xmlUdt("UDT_OldExport"));
assert.equal(sources.deleteAll(["C:/proj/exports/"]), 3, "deleting a folder removes every source inside it");
assert.ok(typeNames(sources).includes("UDT_OldExport"), "a sibling folder whose name merely starts the same is kept");
assert.equal(sources.deleteAll(["C:/PROJ/BLOCKS/motor.scl"]), 1);
assert.equal(sources.deleteAll([]), 0);

const caseSensitive = new WorkspaceSources(false);
caseSensitive.set("/proj/Types/A.udt", udtText("UDT_A"));
assert.equal(caseSensitive.deleteAll(["/proj/types"]), 0, "on a case-sensitive file system, folders differing only in case stay apart");
assert.equal(caseSensitive.deleteAll(["/proj/Types"]), 1);

// --- CacheManager against an in-memory workspace -------------------------------
const files = new Map();
const watchers = [];
let reads = 0;

function matchesGlob(glob, fsPath) {
  if (glob === "**/*") return true;
  const [, braced, single] = /^\*\*\/\*\.(?:\{(.+)\}|(.+))$/.exec(glob);
  return (braced ?? single).split(",").some((extension) => fsPath.toLowerCase().endsWith(`.${extension}`));
}

vscode.workspace.findFiles = async (include, exclude) => {
  const base = typeof include === "string" ? "" : `${include.base}/`;
  const glob = typeof include === "string" ? include : include.pattern;
  return [...files.keys()]
    .filter((p) => p.startsWith(base) && matchesGlob(glob, p) && !(exclude && /\/node_modules\//.test(p)))
    .map((p) => vscode.Uri.file(p));
};
vscode.workspace.fs.readFile = async (uri) => {
  reads++;
  if (!files.has(uri.fsPath)) throw new Error(`ENOENT: ${uri.fsPath}`);
  return Buffer.from(files.get(uri.fsPath));
};
vscode.workspace.fs.stat = async (uri) => {
  if (files.has(uri.fsPath)) return { type: vscode.FileType.File };
  if ([...files.keys()].some((p) => p.startsWith(`${uri.fsPath}/`))) return { type: vscode.FileType.Directory };
  throw new Error(`ENOENT: ${uri.fsPath}`);
};
vscode.workspace.createFileSystemWatcher = (glob, ignoreCreate = false, ignoreChange = false, ignoreDelete = false) => {
  const watcher = {
    glob,
    ignore: { create: ignoreCreate, change: ignoreChange, delete: ignoreDelete },
    emitters: { create: new vscode.EventEmitter(), change: new vscode.EventEmitter(), delete: new vscode.EventEmitter() },
  };
  watchers.push(watcher);
  return {
    onDidCreate: watcher.emitters.create.event,
    onDidChange: watcher.emitters.change.event,
    onDidDelete: watcher.emitters.delete.event,
    dispose() {},
  };
};

/** Reports a file-system event to every watcher VS Code would report it to. */
function fire(kind, fsPath) {
  for (const watcher of watchers) {
    if (!watcher.ignore[kind] && matchesGlob(watcher.glob, fsPath)) watcher.emitters[kind].fire(vscode.Uri.file(fsPath));
  }
}

/** Waits out the update delay, then for the queued update itself. */
async function settle(manager) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await manager.work;
}

function snapshot(manager) {
  const cache = manager.getTypeCacheResult();
  return {
    types: [...cache.types.values()].filter((t) => t.kind === "udt").map((t) => [t.name, t.sourceFile, t.declLine]).sort(),
    diagnostics: cache.diagnostics.map((d) => [d.file, d.line, d.code]).sort(),
    blocks: manager.getBlockIndex().values().map((b) => [b.name, b.file, b.declLine]).sort(),
    tags: manager.getBlockIndex().globalTagValues().map((t) => [t.name, t.file]).sort(),
  };
}

async function testCacheManager() {
  files.set("C:/ws/types/Motor.udt", udtText("UDT_Motor"));
  files.set("C:/ws/blocks/Pump.scl", fbText("FB_Pump"));
  files.set("C:/ws/exports/Tags.xml", xmlTags("DI_Start"));

  const output = { lines: [], appendLine(line) { this.lines.push(line); } };
  const manager = new CacheManager(ruleSet, output);
  let updates = 0;
  manager.onDidRebuild(() => updates++);
  await manager.rebuild();
  assert.ok(lookupType(manager.getTypeCacheResult(), "UDT_Motor"));
  assert.ok(manager.getBlockIndex().get("FB_Pump"));
  assert.ok(manager.getBlockIndex().getGlobalTag("DI_Start"));

  const context = { subscriptions: [] };
  manager.watch(context);

  reads = 0;
  updates = 0;
  files.set("C:/ws/types/Motor.udt", udtText("UDT_Motor", "Real"));
  fire("change", "C:/ws/types/Motor.udt");
  fire("change", "C:/ws/types/Motor.udt");
  files.set("C:/ws/types/Valve.udt", udtText("UDT_Valve"));
  fire("create", "C:/ws/types/Valve.udt");
  await settle(manager);
  assert.equal(updates, 1, "a burst of events updates the caches once");
  assert.equal(reads, 2, "only the files named by the events are read again");
  assert.equal(lookupType(manager.getTypeCacheResult(), "UDT_Motor").members[0].typeRef.name, "Real");
  assert.ok(lookupType(manager.getTypeCacheResult(), "UDT_Valve"));
  assert.ok(manager.getBlockIndex().get("FB_Pump"), "sources nobody touched stay indexed");

  files.delete("C:/ws/types/Valve.udt");
  fire("delete", "C:/ws/types/Valve.udt");
  await settle(manager);
  assert.equal(lookupType(manager.getTypeCacheResult(), "UDT_Valve"), undefined, "a deleted file's declarations disappear");

  files.delete("C:/ws/blocks/Pump.scl");
  fire("delete", "C:/ws/blocks");
  await settle(manager);
  assert.equal(manager.getBlockIndex().get("FB_Pump"), undefined, "deleting a whole folder, reported only as the folder, removes its sources");

  files.set("C:/ws/moved/Conveyor.scl", fbText("FB_Conveyor"));
  fire("create", "C:/ws/moved");
  await settle(manager);
  assert.ok(manager.getBlockIndex().get("FB_Conveyor"), "a folder moved in whole, reported only as the folder, is scanned");

  files.delete("C:/ws/moved/Conveyor.scl");
  fire("delete", "C:/ws/moved/Conveyor.scl");
  files.set("C:/ws/moved/Conveyor.scl", fbText("FB_ConveyorV2"));
  fire("create", "C:/ws/moved/Conveyor.scl");
  await settle(manager);
  assert.ok(manager.getBlockIndex().get("FB_ConveyorV2"), "a file deleted and re-created in one burst is read again");
  assert.equal(manager.getBlockIndex().get("FB_Conveyor"), undefined);

  reads = 0;
  updates = 0;
  fire("change", "C:/ws/blocks/Pump.s7res");
  await settle(manager);
  assert.equal(reads, 0, "an .s7res edit reads no cache source");
  assert.equal(updates, 1, "an .s7res edit still re-lints open documents");

  files.set("C:/ws/node_modules/vendor/Vendor.udt", udtText("UDT_Vendor"));
  fire("create", "C:/ws/node_modules/vendor/Vendor.udt");
  await settle(manager);
  assert.equal(lookupType(manager.getTypeCacheResult(), "UDT_Vendor"), undefined, "node_modules stays excluded for watcher events too");

  files.set("C:/ws/exports/Recipe.xml", xmlUdt("UDT_Recipe"));
  fire("create", "C:/ws/exports/Recipe.xml");
  await settle(manager);
  assert.ok(manager.isUdtSource("C:/ws/exports/Recipe.xml"), "an XML PLC data type outside a 'PLC data types' folder gets its cache diagnostics");
  assert.ok(!manager.isUdtSource("C:/ws/exports/Tags.xml"), "a tag-table XML export is not a type source");
  assert.ok(manager.isUdtSource("C:/ws/anywhere/New.udt"));

  reads = 0;
  updates = 0;
  manager.recompute();
  assert.equal(reads, 0, "recompute reads no file");
  assert.equal(updates, 1);

  const incremental = snapshot(manager);
  await manager.rebuild();
  assert.deepEqual(snapshot(manager), incremental, "a full rebuild agrees with the incrementally updated caches");

  for (const disposable of context.subscriptions) disposable.dispose();
}

testCacheManager()
  .then(() => console.log("Workspace source store and incremental cache update regressions passed."))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
