// Standalone Node test for the instruction-registry editor's core layer
// (Phase 1): external-registry option catalog, comment-preserving YAML
// document round-trip, registry indexing, structural edit operations,
// validation, and atomic save. Runs against the tsc-compiled out/ tree, same
// convention as scripts/smoke-test.js -- no test framework, hand-rolled
// pass/fail with a non-zero exit on failure.
//
// It never mutates production data: it loads resources/ read-only, and every
// write goes to a throwaway temp directory that is removed at the end.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadOptionCatalog } = require("../out/instructionEditor/externalRegistries");
const { RegistryDocument } = require("../out/instructionEditor/yamlDocument");
const { RegistryWorkspace, registryRootFor } = require("../out/instructionEditor/registryIndex");
const { makeValidationContext, validateEntry } = require("../out/instructionEditor/validation");
const { contextForWorkspace, validateWorkspace } = require("../out/instructionEditor/validateWorkspace");
const { atomicWriteFile, fileChangedOnDisk, AtomicSaveError } = require("../out/instructionEditor/atomicSave");

const RESOURCES = path.join(__dirname, "..", "resources");
const REGISTRY_ROOT = registryRootFor(RESOURCES);

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${label}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

// --- 1. External-registry option catalog --------------------------------
section("Option catalog from external registries");
const catalog = loadOptionCatalog(RESOURCES);
ok(catalog.memoryAreas.some((o) => o.value === "I"), "memoryAreas include I (from memory.yaml)");
ok(catalog.memoryAreas.some((o) => o.value === "constant"), "memoryAreas include constant");
ok(catalog.declarationSections.some((o) => o.value === "InOut"), "declarationSections include InOut");
ok(catalog.baseTypeNames.has("Bool"), "baseTypeNames include Bool");
ok(catalog.systemTypeNames.has("IEC_TIMER"), "systemTypeNames include IEC_TIMER");
ok(["none", "value", "inferred", "type-expression"].every((k) => catalog.resultKinds.some((o) => o.value === k)), "resultKinds cover all four (from result.yaml)");
ok(catalog.umbrellaLabelNames.has("Integers"), "umbrellaLabels include Integers");
ok(catalog.dataTypeGroups.length > 0 && catalog.dataTypeGroups.some((g) => g.group.startsWith("Base types")), "dataTypeGroups grouped by category");
ok(catalog.validPinDataTypes.has("*") && catalog.validPinDataTypes.has("Bool") && catalog.validPinDataTypes.has("Integers"), "validPinDataTypes union built");
ok(catalog.validTemplateTypeNames.has("BCD16"), "validTemplateTypeNames include BCD formats");
// BCD16/BCD32 are `notAValidDatatype` for VAR/STRUCT DECLARATIONS, but
// bcd-formats.yaml documents them as the format conversion instructions
// read/write -- i.e. legal on a conversion pin's dataTypes (see Convert).
ok(catalog.validPinDataTypes.has("BCD16") && catalog.validPinDataTypes.has("BCD32"), "BCD formats are legal pin dataTypes (conversion instructions)");
ok(catalog.dataTypeGroups.some((g) => g.group.startsWith("BCD formats")), "BCD formats offered in their own dropdown group");

// --- 2. Workspace loads every real file, no parse errors ----------------
section("Workspace load + tree + duplicates");
const ws = RegistryWorkspace.load(REGISTRY_ROOT);
const relPaths = ws.fileRelPaths();
ok(relPaths.length > 20, `loaded many files (${relPaths.length})`);
let parseErrorFiles = 0;
for (const rel of relPaths) if (ws.document(rel).parseErrors().length) parseErrorFiles += 1;
ok(parseErrorFiles === 0, `no real file has YAML parse errors (${parseErrorFiles} bad)`);
ok(ws.entryCount() > 50, `indexed many entries (${ws.entryCount()})`);

const tree = ws.buildTree();
ok(tree.kind === "folder" && tree.relPath === "", "tree root is registry folder");
ok(tree.folders.length > 0, "tree has subfolders");
const allFiles = [];
(function collect(f) { allFiles.push(...f.files); f.folders.forEach(collect); })(tree);
ok(allFiles.length === relPaths.length, "tree file count matches loaded files");
const sclFile = allFiles.find((f) => f.fileName === "SCL-bit-logic.yaml");
ok(sclFile && sclFile.isScl && sclFile.entries.some((e) => e.name === "R_TRIG"), "SCL-bit-logic.yaml indexed as SCL with R_TRIG entry");
ok(sclFile && Array.isArray(sclFile.fileLanguage) && sclFile.fileLanguage.includes("SCL"), "$fileLanguage read from SCL file");
ok(sclFile.entries.every((e) => typeof e.id === "string" && e.id.length > 0), "every entry has a stable id");

const dups = ws.findDuplicateNames();
console.log(`  (duplicate names across same-scope files: ${dups.length})`);
ok(Array.isArray(dups), "duplicate detection returns a list");

// --- 3. Whole-registry validation ---------------------------------------
section("Whole-registry validation");
const wsCtx = contextForWorkspace(ws, catalog);
const report = validateWorkspace(ws, wsCtx);
console.log(`  findings: ${report.findings.length} (errors ${report.errorCount}, warnings ${report.warningCount})`);
ok(report.findings.every((f) => typeof f.file === "string" && typeof f.fieldPath === "string"), "every finding has file + fieldPath");
ok(report.findings.every((f) => f.severity === "error" || f.severity === "warning"), "findings have valid severity");

// --- 4. validateEntry catches concrete problems -------------------------
section("Single-entry validation catches injected problems");
const entryCtx = makeValidationContext(catalog, ["bit-logic"]);
const bad = {
  family: "not-a-family",
  callShape: "bogus",
  confidence: "confirmed-compiled",
  template: { shape: "none", keys: [], extra: {} },
  pins: [{ name: "IN", dir: "sideways", required: "yes", dataTypes: ["NotAType"], memoryAreas: ["Z"] }],
  totallyUnknownField: 1,
};
const badFindings = validateEntry(bad, entryCtx);
const codes = new Set(badFindings.map((f) => f.code));
ok(codes.has("unknown-family"), "flags unknown family");
ok(codes.has("invalid-call-shape"), "flags invalid callShape");
ok(codes.has("invalid-pin-dir"), "flags invalid pin dir");
ok(codes.has("invalid-pin-required"), "flags non-boolean required");
ok(codes.has("unknown-data-type"), "flags unknown pin dataType");
ok(codes.has("unknown-memory-area"), "flags unknown memory area");
ok(codes.has("unknown-field"), "flags unknown top-level field (preserved)");
const memFinding = badFindings.find((f) => f.code === "unknown-memory-area");
ok(memFinding && Array.isArray(memFinding.allowed) && memFinding.allowed.includes("I"), "unknown-memory-area finding lists allowed values");

// A valid minimal entry should produce no errors.
const good = {
  family: "bit-logic",
  callShape: "box",
  pins: [{ name: "in", dir: "in", required: true, dataTypes: ["Bool"], memoryAreas: ["I", "Q", "M"] }],
  template: { shape: "none", keys: [], extra: {} },
  confidence: "shape-only",
};
const goodErrors = validateEntry(good, entryCtx).filter((f) => f.severity === "error");
ok(goodErrors.length === 0, `valid minimal entry has no errors (${goodErrors.map((f) => f.code).join(",")})`);

// A conversion pin listing BCD formats must NOT be flagged (regression guard:
// these were wrongly reported as unrecognized on the real `Convert` entry).
const conv = {
  family: "conversion",
  callShape: "box",
  pins: [{ name: "in", dir: "in", required: true, dataTypes: ["Integers", "BCD16", "BCD32"] }],
  template: { shape: "bracketed", keys: ["SrcType", "DestType"], extra: {} },
  confidence: "confirmed-compiled",
};
ok(!validateEntry(conv, entryCtx).some((f) => f.code === "unknown-data-type"), "BCD16/BCD32 on a conversion pin are accepted");

// A coil-ref whose instance type is carried by a PIN (PT_Coil-style) must not
// be nagged for a null entry-level instanceType; one with neither still is.
const ctxWithTimer = makeValidationContext(catalog, ["timer"]);
const coilViaPin = {
  family: "timer",
  callShape: "coil-ref",
  instanceType: null,
  pins: [{ name: "timer", dir: "out", required: true, dataTypes: ["IEC_TIMER", "IEC_LTIMER"] }],
  template: { shape: "none", keys: [], extra: {} },
  confidence: "confirmed-compiled",
};
ok(!validateEntry(coilViaPin, ctxWithTimer).some((f) => f.code === "missing-instance-type"), "coil-ref with a pin-carried instance type is not flagged");
const coilNoInstance = { ...coilViaPin, pins: [{ name: "x", dir: "in", required: true, dataTypes: ["Bool"] }] };
ok(validateEntry(coilNoInstance, ctxWithTimer).some((f) => f.code === "missing-instance-type"), "coil-ref with no instance type anywhere is still flagged");

// Missing a required field is flagged.
const missing = { family: "bit-logic", callShape: "box", pins: [], template: { shape: "none", keys: [], extra: {} } };
ok(validateEntry(missing, entryCtx).some((f) => f.code === "missing-required-field" && f.fieldPath === "confidence"), "flags missing required 'confidence'");

// --- 5. Comment/format preservation on round-trip -----------------------
section("Comment + format preservation");
const sclText = fs.readFileSync(path.join(REGISTRY_ROOT, "builtin/01-basic-instructions/01-bit-logic/SCL-bit-logic.yaml"), "utf-8");
const sclDoc = RegistryDocument.parse(sclText);
ok(!sclDoc.isDirty(), "freshly parsed doc is not dirty");
const roundTrip = sclDoc.toText();
ok(roundTrip.includes("# SCL-specific bit-logic instruction registry."), "header comment preserved");
ok(roundTrip.includes("Canonical SCL parameter names use Siemens' uppercase spelling"), "mid-file comment preserved");
ok(roundTrip.includes("$fileLanguage: [SCL]"), "$fileLanguage line preserved");
ok(roundTrip.includes("R_TRIG:") && roundTrip.includes("F_TRIG:"), "both entries preserved in order");

// --- 6. Unknown-field preservation through the document -----------------
section("Unknown-field preservation");
const withUnknown = "Foo:\n  family: bit-logic\n  callShape: box\n  weirdCustomKey: keepme\n  pins: []\n  template: { shape: none, keys: [], extra: {} }\n  confidence: shape-only\n";
const uDoc = RegistryDocument.parse(withUnknown);
const uEntry = uDoc.entries()[0];
const uJS = uDoc.entryJS(uEntry.uid);
ok(uJS.weirdCustomKey === "keepme", "unknown field readable in JS view");
ok(uDoc.toText().includes("weirdCustomKey: keepme"), "unknown field survives serialization");

// --- 7. Structural edit operations (in-memory) --------------------------
section("Structural edit operations");
const opsDoc = RegistryDocument.parse(sclText);
const before = opsDoc.entries().map((e) => e.name);
ok(before.length === 2, "starts with 2 entries");

// add
const addUid = opsDoc.addEntry("NEW_INSTR", { family: "bit-logic", callShape: "box", pins: [], template: { shape: "none", keys: [], extra: {} }, confidence: "shape-only" });
ok(opsDoc.entries().length === 3 && opsDoc.hasName("NEW_INSTR"), "addEntry appended a new entry");
ok(opsDoc.isDirty(), "doc marked dirty after add");

// rename
const first = opsDoc.entries()[0];
ok(opsDoc.renameEntry(first.uid, "R_TRIG_RENAMED"), "renameEntry succeeds");
ok(opsDoc.hasName("R_TRIG_RENAMED") && !opsDoc.hasName("R_TRIG"), "rename applied");
ok(!opsDoc.renameEntry(first.uid, "F_TRIG"), "rename rejects collision with existing name");

// reorder
const order1 = opsDoc.entries().map((e) => e.name);
ok(opsDoc.moveEntryWithin(addUid, 0), "moveEntryWithin succeeds");
const order2 = opsDoc.entries().map((e) => e.name);
ok(order2[0] === "NEW_INSTR" && order2.join() !== order1.join(), "reorder moved entry to front");

// duplicate
const dupUid = opsDoc.duplicateEntry(addUid, "NEW_INSTR_COPY");
ok(dupUid && opsDoc.hasName("NEW_INSTR_COPY"), "duplicateEntry created a copy");
ok(opsDoc.entryJS(dupUid).family === "bit-logic", "duplicate preserves fields");

// delete
ok(opsDoc.deleteEntry(dupUid) && !opsDoc.hasName("NEW_INSTR_COPY"), "deleteEntry removed the copy");

// --- 8. Cross-file move preserves the entry (and its comments) ----------
section("Cross-file move preserves entry + comments");
const srcText = "# file A header\nAlpha:\n  family: bit-logic\n  callShape: box\n  pins: []\n  template: { shape: none, keys: [], extra: {} }\n  confidence: shape-only\n\n# a note that belongs to Beta\nBeta:\n  family: timer\n  callShape: box\n  pins: []\n  template: { shape: none, keys: [], extra: {} }\n  confidence: shape-only\n";
const dstText = "Gamma:\n  family: math\n  callShape: box\n  pins: []\n  template: { shape: none, keys: [], extra: {} }\n  confidence: shape-only\n";
const srcDoc = RegistryDocument.parse(srcText);
const dstDoc = RegistryDocument.parse(dstText);
const beta = srcDoc.entries().find((e) => e.name === "Beta");
const betaPair = srcDoc.extractPair(beta.uid);
ok(betaPair && !srcDoc.hasName("Beta"), "extractPair removed Beta from source");
const movedUid = dstDoc.insertPair(betaPair);
ok(movedUid === beta.uid, "moved entry keeps its stable uid across files");
ok(dstDoc.hasName("Beta"), "Beta now in destination");
ok(dstDoc.toText().includes("a note that belongs to Beta"), "Beta's comment moved with it");
ok(!srcDoc.toText().includes("a note that belongs to Beta"), "comment removed from source");

// --- 9. Atomic save (success + failure leaves original intact) ----------
section("Atomic save");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instr-editor-test-"));
try {
  const target = path.join(tmpDir, "out.yaml");
  fs.writeFileSync(target, "ORIGINAL\n", "utf-8");
  const originalMtime = fs.statSync(target).mtimeMs;

  // success
  atomicWriteFile(target, "NEWCONTENT\n", () => null);
  ok(fs.readFileSync(target, "utf-8") === "NEWCONTENT\n", "atomic write replaced content when valid");
  ok(fs.readdirSync(tmpDir).filter((f) => f.includes(".tmp")).length === 0, "no temp file left after success");

  // failure: validator rejects -> original NEWCONTENT must remain
  let threw = false;
  try {
    atomicWriteFile(target, "SHOULD_NOT_LAND\n", () => "invalid!");
  } catch (e) {
    threw = e instanceof AtomicSaveError;
  }
  ok(threw, "atomicWriteFile throws when validation fails");
  ok(fs.readFileSync(target, "utf-8") === "NEWCONTENT\n", "original file intact after failed validation");
  ok(fs.readdirSync(tmpDir).filter((f) => f.includes(".tmp")).length === 0, "no temp file left after failure");

  // external-change detection
  ok(!fileChangedOnDisk(target, "NEWCONTENT\n", fs.statSync(target).mtimeMs), "fileChangedOnDisk false when unchanged");
  fs.writeFileSync(target, "EXTERNAL EDIT\n", "utf-8");
  ok(fileChangedOnDisk(target, "NEWCONTENT\n", originalMtime), "fileChangedOnDisk true after external edit");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- summary ------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
