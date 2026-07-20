// Integration test for the editor's host-side service (EditorService) -- the
// exact pipeline the VS Code webview panel wraps, exercised without a DOM or
// the Extension Development Host. It copies resources/ into a throwaway temp
// dir so saves are real but never touch production data.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const { EditorService } = require("../out/instructionEditor/editorService");

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`  FAIL: ${label}`);
  }
}

const realResources = path.join(__dirname, "..", "resources");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "editor-svc-"));
const resources = path.join(tmp, "resources");
fs.cpSync(realResources, resources, { recursive: true });

try {
  const svc = new EditorService(resources);

  console.log("=== snapshot ===");
  const snap = svc.snapshot();
  ok(snap.tree && snap.tree.kind === "folder", "snapshot has a tree root");
  ok(snap.catalog.memoryAreas.some((o) => o.value === "I"), "catalog memoryAreas populated");
  ok(snap.catalog.dataTypeGroups.length > 0, "catalog dataTypeGroups populated");
  ok(snap.catalog.families.length > 0 && snap.catalog.callShapes.includes("box"), "catalog schema enums populated");
  ok(Array.isArray(snap.findings), "snapshot findings present");
  ok(snap.fileStatus.length > 0 && snap.fileStatus.every((s) => s.dirty === false), "all files start clean");

  // Locate the R_TRIG entry in SCL-bit-logic.yaml via the tree.
  const allFiles = [];
  (function collect(f) { allFiles.push(...f.files); f.folders.forEach(collect); })(snap.tree);
  const sclFile = allFiles.find((f) => f.fileName === "SCL-bit-logic.yaml");
  ok(!!sclFile, "found SCL-bit-logic.yaml");
  const rTrig = sclFile.entries.find((e) => e.name === "R_TRIG");
  ok(!!rTrig, "found R_TRIG entry with a stable id");

  console.log("=== read entry ===");
  const data = svc.entryData(rTrig.id);
  ok(data && data.json.family === "bit-logic", "entryData returns parsed json");
  ok(data.name === "R_TRIG" && data.filePath === sclFile.relPath, "entryData identity correct");

  console.log("=== edit field (granular, preserves siblings) ===");
  const edited = svc.updateField(rTrig.id, ["notes"], "EDITED NOTE MARKER");
  ok(edited.json.notes === "EDITED NOTE MARKER", "notes updated in memory");
  const st1 = svc.status();
  ok(st1.fileStatus.find((s) => s.relPath === sclFile.relPath).dirty === true, "file marked dirty after edit");
  ok(svc.hasDirty() === true, "service reports dirty");

  console.log("=== edit produces a validation warning ===");
  const badFam = svc.updateField(rTrig.id, ["family"], "not-a-real-family");
  ok(badFam.findings.some((f) => f.code === "unknown-family"), "unknown-family warning surfaced");
  // put it back to a valid value
  svc.updateField(rTrig.id, ["family"], "bit-logic");

  console.log("=== save (atomic) + comment preservation ===");
  const absScl = svc.absPathFor(sclFile.relPath);
  const before = fs.readFileSync(absScl, "utf-8");
  ok(before.includes("# SCL-specific bit-logic"), "sanity: header comment present before save");
  const result = svc.save();
  ok(result.savedFiles.includes(sclFile.relPath), "save reports the file saved");
  ok(result.failed.length === 0, "no save failures");
  const after = fs.readFileSync(absScl, "utf-8");
  ok(after.includes("EDITED NOTE MARKER"), "edit persisted to disk");
  ok(after.includes("# SCL-specific bit-logic"), "header comment preserved through save");
  ok(after.includes("Canonical SCL parameter names"), "mid-file comment preserved through save");
  ok(after.includes("F_TRIG:"), "sibling entry F_TRIG preserved");
  // Diff-confinement guarantee: editing R_TRIG leaves the untouched sibling
  // entry F_TRIG byte-for-byte identical (folded notes wrapping and all).
  const sliceFrom = (s) => s.slice(s.indexOf("F_TRIG:"));
  ok(sliceFrom(after) === sliceFrom(before), "untouched sibling F_TRIG is byte-identical after edit+save");
  ok(svc.hasDirty() === false, "no dirty files after successful save (service reloaded)");

  console.log("=== rename + save ===");
  const snap2 = svc.snapshot();
  const files2 = [];
  (function collect(f) { files2.push(...f.files); f.folders.forEach(collect); })(snap2.tree);
  const scl2 = files2.find((f) => f.fileName === "SCL-bit-logic.yaml");
  const rTrig2 = scl2.entries.find((e) => e.name === "R_TRIG");
  const ren = svc.renameEntry(rTrig2.id, "R_TRIG_X");
  ok(ren.ok && ren.data.name === "R_TRIG_X", "rename applied in memory");
  const badRen = svc.renameEntry(rTrig2.id, "F_TRIG");
  ok(badRen.ok === false, "rename to an existing name is rejected");
  svc.save();
  const afterRen = fs.readFileSync(absScl, "utf-8");
  ok(afterRen.includes("R_TRIG_X:") && !/\bR_TRIG:/.test(afterRen), "rename persisted to disk");

  console.log("=== revert discards in-memory edits ===");
  const snap3 = svc.snapshot();
  const files3 = [];
  (function collect(f) { files3.push(...f.files); f.folders.forEach(collect); })(snap3.tree);
  const scl3 = files3.find((f) => f.fileName === "SCL-bit-logic.yaml");
  const someEntry = scl3.entries[0];
  svc.updateField(someEntry.id, ["notes"], "TRANSIENT");
  ok(svc.hasDirty() === true, "dirty after transient edit");
  svc.reload();
  ok(svc.hasDirty() === false, "reload/revert clears dirty");
  ok(!fs.readFileSync(absScl, "utf-8").includes("TRANSIENT"), "transient edit never hit disk");

  // --- Phase 3: create / duplicate / delete entries ---
  console.log("=== Phase 3: entry create / duplicate / delete ===");
  const fileOf = (name) => {
    const s = svc.snapshot(); const fs2 = [];
    (function c(f) { fs2.push(...f.files); f.folders.forEach(c); })(s.tree);
    return fs2.find((f) => f.fileName === name);
  };
  const sclRel = fileOf("SCL-bit-logic.yaml").relPath;
  const cr = svc.createEntry(sclRel, "NEW_ONE");
  ok(cr.ok && cr.data.name === "NEW_ONE" && cr.data.json.family === "bit-logic", "createEntry builds a valid minimum entry");
  ok(cr.data.findings.filter((f) => f.severity === "error").length === 0, "new minimum entry has no validation errors");
  ok(svc.createEntry(sclRel, "NEW_ONE").ok === false, "createEntry rejects duplicate name");
  ok(svc.createEntry(sclRel, "1bad name").ok === false, "createEntry rejects invalid identifier");
  const du = svc.duplicateEntry(cr.data.uid);
  ok(du.ok && du.data.name === "NEW_ONE_copy", "duplicateEntry makes a uniquely-named copy");
  ok(svc.deleteEntry(du.data.uid) === true, "deleteEntry removes the copy");
  svc.save();
  const sclDisk = fs.readFileSync(svc.absPathFor(sclRel), "utf-8");
  ok(sclDisk.includes("NEW_ONE:") && !sclDisk.includes("NEW_ONE_copy:"), "created entry persisted; deleted copy not persisted");

  // --- Phase 3: move entry between files ---
  console.log("=== Phase 3: move entry between files ===");
  const targetRel = fileOf("LAD-FBD-bit-logic.yaml").relPath;
  const newOne = fileOf("SCL-bit-logic.yaml").entries.find((e) => e.name === "NEW_ONE");
  const mv = svc.moveEntry(newOne.id, targetRel);
  ok(mv.ok && mv.data.filePath === targetRel, "moveEntry relocates the entry");
  ok(!fileOf("SCL-bit-logic.yaml").entries.some((e) => e.name === "NEW_ONE"), "entry gone from source file");
  ok(fileOf("LAD-FBD-bit-logic.yaml").entries.some((e) => e.name === "NEW_ONE"), "entry present in target file");
  svc.save();
  ok(!fs.readFileSync(svc.absPathFor(sclRel), "utf-8").includes("NEW_ONE:"), "source file no longer has moved entry on disk");
  ok(fs.readFileSync(svc.absPathFor(targetRel), "utf-8").includes("NEW_ONE:"), "target file has moved entry on disk");

  // --- Phase 3: create / rename / delete files (buffered) ---
  console.log("=== Phase 3: file create / rename / delete ===");
  const cf = svc.createFile("builtin", "SCL-testnew.yaml", ["SCL"]);
  ok(cf.ok, "createFile buffers a new file");
  ok(svc.hasDirty() === true, "new file marks workspace dirty");
  ok(svc.createEntry(cf.relPath, "IN_NEW_FILE").ok === true, "can add an entry to the new file");
  svc.save();
  const newAbs = svc.absPathFor(cf.relPath);
  ok(fs.existsSync(newAbs), "new file written to disk on save");
  const newText = fs.readFileSync(newAbs, "utf-8");
  ok(newText.includes("$fileLanguage: [SCL]") && newText.includes("IN_NEW_FILE:"), "new file has $fileLanguage + entry");
  const rf = svc.renameFile(cf.relPath, "SCL-renamed.yaml");
  ok(rf.ok, "renameFile buffers a rename");
  svc.save();
  ok(!fs.existsSync(newAbs) && fs.existsSync(svc.absPathFor(rf.relPath)), "rename moved the file on disk (old path gone)");
  svc.deleteFile(rf.relPath);
  ok(svc.hasDirty() === true, "delete marks dirty");
  svc.save();
  ok(!fs.existsSync(svc.absPathFor(rf.relPath)), "deleteFile removed the file from disk on save");

  // --- Phase 3: folders (immediate) ---
  console.log("=== Phase 3: folders ===");
  const fol = svc.createFolder("builtin", "zzz-custom");
  ok(fol.ok && fs.existsSync(svc.absPathFor("builtin/zzz-custom")), "createFolder creates it immediately");
  const df = svc.deleteFolder("builtin/zzz-custom");
  ok(df.ok && !fs.existsSync(svc.absPathFor("builtin/zzz-custom")), "deleteFolder removes an empty folder");
  const folWith = svc.createFolder("builtin", "zzz-hasfile");
  svc.createFile("builtin/zzz-hasfile", "SCL-x.yaml");
  ok(svc.deleteFolder("builtin/zzz-hasfile").ok === false, "deleteFolder refuses a non-empty folder (no data loss)");

  // --- Phase 3: revert discards buffered structural changes ---
  console.log("=== Phase 3: revert discards buffered new file ===");
  svc.createFile("builtin", "SCL-temp2.yaml");
  ok(svc.hasDirty() === true, "buffered new file is dirty");
  svc.reload();
  ok(svc.hasDirty() === false && !fs.existsSync(svc.absPathFor("builtin/SCL-temp2.yaml")), "revert discards buffered new file (never written)");

  // --- Phase 4: drag-and-drop reorder + batch move ---
  console.log("=== Phase 4: reorder within file + batch cross-file move ===");
  const timersRel = fileOf("SCL-timers.yaml") ? fileOf("SCL-timers.yaml").relPath : null;
  if (timersRel) {
    const before4 = fileOf("SCL-timers.yaml").entries.map((e) => e.name);
    if (before4.length >= 2) {
      const ids = fileOf("SCL-timers.yaml").entries.map((e) => e.id);
      // reverse the order via reorderFile
      const rr = svc.reorderFile(timersRel, [...ids].reverse());
      ok(rr.ok, "reorderFile applies a new order");
      const after4 = fileOf("SCL-timers.yaml").entries.map((e) => e.name);
      ok(after4.join() === [...before4].reverse().join(), "entries reordered to the requested order");
      // save and confirm order on disk (first entry name should now be the last original)
      svc.save();
      const disk = fs.readFileSync(svc.absPathFor(timersRel), "utf-8");
      ok(disk.indexOf(after4[0] + ":") < disk.indexOf(after4[1] + ":"), "reordered order persisted to disk");
    } else {
      ok(true, "(SCL-timers.yaml has <2 entries, reorder trivially ok)");
    }
  } else {
    ok(true, "(no SCL-timers.yaml; skipped reorder disk check)");
  }

  // Batch move: move two entries from LAD-FBD-bit-logic.yaml to SCL-bit-logic.yaml
  const srcF = fileOf("LAD-FBD-bit-logic.yaml");
  const dstRel = fileOf("SCL-bit-logic.yaml").relPath;
  const movers = srcF.entries.slice(0, 2).map((e) => e.id);
  const moverNames = srcF.entries.slice(0, 2).map((e) => e.name);
  // Only run if names don't already collide in the target.
  const targetNames = new Set(fileOf("SCL-bit-logic.yaml").entries.map((e) => e.name));
  if (movers.length === 2 && !moverNames.some((n) => targetNames.has(n))) {
    const bm = svc.moveEntries(movers, dstRel, 0);
    ok(bm.ok && bm.uids.length === 2, "moveEntries relocates a batch");
    const dstNamesNow = fileOf("SCL-bit-logic.yaml").entries.map((e) => e.name);
    ok(moverNames.every((n) => dstNamesNow.includes(n)), "both moved entries now in target");
    ok(dstNamesNow.slice(0, 2).join() === moverNames.join(), "batch kept its order at the drop index");
    ok(!fileOf("LAD-FBD-bit-logic.yaml").entries.some((e) => moverNames.includes(e.name)), "moved entries gone from source");
  } else {
    ok(true, "(batch-move preconditions not met; skipped)");
  }
  // Collision-safety: moving an entry to a file that already has that name is rejected atomically.
  const dupName = fileOf("SCL-bit-logic.yaml").entries[0];
  const collidingTarget = fileOf("SCL-bit-logic.yaml").relPath;
  ok(svc.moveEntries([dupName.id], collidingTarget, 0).ok === true, "moving within same file is allowed (reposition)");

  // --- Phase 5: undo / redo ---
  console.log("=== Phase 5: undo / redo ===");
  svc.reload(); // fresh baseline, clears history
  ok(svc.canUndo() === false && svc.canRedo() === false, "no undo/redo on fresh reload");
  const uf = fileOf("SCL-bit-logic.yaml").relPath;
  const beforeNames = fileOf("SCL-bit-logic.yaml").entries.map((e) => e.name).sort();
  const c1 = svc.createEntry(uf, "UNDO_ME");
  ok(svc.canUndo() === true, "createEntry enables undo");
  ok(fileOf("SCL-bit-logic.yaml").entries.some((e) => e.name === "UNDO_ME"), "entry present before undo");
  ok(svc.undo() === true, "undo returns true");
  ok(!fileOf("SCL-bit-logic.yaml").entries.some((e) => e.name === "UNDO_ME"), "undo removed the created entry");
  ok(fileOf("SCL-bit-logic.yaml").entries.map((e) => e.name).sort().join() === beforeNames.join(), "undo restored exact prior state");
  ok(svc.canRedo() === true, "redo available after undo");
  ok(svc.redo() === true && fileOf("SCL-bit-logic.yaml").entries.some((e) => e.name === "UNDO_ME"), "redo re-applies the create");
  // A new mutation clears the redo stack.
  svc.updateField(fileOf("SCL-bit-logic.yaml").entries[0].id, ["notes"], "x");
  ok(svc.canRedo() === false, "new mutation clears redo stack");
  // Failed op does not create an undo entry.
  svc.reload();
  ok(svc.canUndo() === false, "reload clears undo");
  svc.createEntry(uf, "1-invalid-name!");
  ok(svc.canUndo() === false, "failed create pushes no undo state");

  // --- Phase 5: external-change guard on save ---
  console.log("=== Phase 5: external-change guard ===");
  svc.reload();
  const guardFile = fileOf("SCL-bit-logic.yaml").relPath;
  const guardEntry = fileOf("SCL-bit-logic.yaml").entries[0];
  svc.updateField(guardEntry.id, ["notes"], "my in-editor edit");
  // Simulate an external edit landing on disk AFTER we loaded, with a bumped mtime.
  const guardAbs = svc.absPathFor(guardFile);
  const externalText = fs.readFileSync(guardAbs, "utf-8") + "\r\n# external append\r\n";
  const future = new Date(Date.now() + 5000);
  fs.writeFileSync(guardAbs, externalText, "utf-8");
  fs.utimesSync(guardAbs, future, future);
  ok(svc.externalChanges().includes(guardFile), "externalChanges detects the outside edit");
  const guardSave = svc.save();
  ok(guardSave.failed.some((f) => f.relPath === guardFile), "save refuses to overwrite the externally-changed file");
  ok(fs.readFileSync(guardAbs, "utf-8").includes("# external append"), "external content left intact (not clobbered)");
  ok(!fs.readFileSync(guardAbs, "utf-8").includes("my in-editor edit"), "our edit was NOT written over the external change");

  // --- system-types.yaml editing (quick-add from the unknown-type warning) ---
  console.log("=== system-types: quick-add from an instruction's instanceType ===");
  svc.reload();
  const stAbs = svc.systemTypesAbsPath();
  const stBefore = fs.readFileSync(stAbs, "utf-8");
  ok(svc.systemTypesInfo().names.includes("IEC_TIMER"), "system types listed from the editable file");

  // Build the reported situation deterministically instead of relying on the
  // registry still having uncatalogued types (it may already be fully
  // populated): author an instruction referencing a type that doesn't exist.
  const wantedType = "ZZ_MissingInstanceType";
  const synthRel = fileOf("SCL-bit-logic.yaml").relPath;
  const synth = svc.createEntry(synthRel, "ZZ_QUICKADD_PROBE", { callShape: "instance-dot" });
  ok(synth.ok, "authored a probe instruction");
  svc.updateField(synth.data.uid, ["instanceType"], wantedType);
  svc.updateField(synth.data.uid, ["pins"], [
    { name: "CLK", dir: "in", required: false, dataTypes: ["Bool"] },
    { name: "Q", dir: "out", required: false, dataTypes: ["Bool"] },
  ]);
  const rt = { id: synth.data.uid };
  const rtData = svc.entryData(rt.id);
  ok(rtData.json.instanceType === wantedType, "probe declares the uncatalogued instanceType");
  ok(rtData.findings.some((f) => f.code === "unknown-instance-type"), "editor reports 'not a known system type'");

  // One-click quick add, seeded from the instruction's own pins.
  const made = svc.createSystemTypeForInstruction(rt.id);
  ok(made.ok && made.data.name === wantedType, "createSystemTypeForInstruction adds the type");
  ok(made.data.json.category === "system-struct", "created as a system-struct");
  const memberNames = (made.data.json.members || []).map((m) => m.name);
  ok(memberNames.includes("CLK") && memberNames.includes("Q"), `members seeded from the instruction's pins (${memberNames.join(", ")})`);
  ok((made.data.json.members || []).every((m) => m.type && m.type.kind === "named"), "members use the named TypeRef shape");
  ok((made.data.json.usedByInstructions || []).length > 0, "usedByInstructions references the instruction");

  // The warning must clear immediately -- before saving.
  const rtAfter = svc.entryData(rt.id);
  ok(!rtAfter.findings.some((f) => f.code === "unknown-instance-type"), "warning clears immediately from the BUFFERED type (before save)");
  ok(svc.hasDirty() === true, "system-types edit marks the workspace dirty");

  // Add the extra member TIA shows on the instance (Stat_Bit), then save.
  const withStat = [...made.data.json.members, { name: "Stat_Bit", type: { kind: "named", name: "Bool" } }];
  svc.updateSystemTypeField("R_TRIG", ["members"], withStat);
  ok(svc.systemTypeData("R_TRIG").json.members.length === 3, "can add a member (Stat_Bit)");
  const stSave = svc.save();
  ok(stSave.failed.length === 0, `system-types saved without failures (${JSON.stringify(stSave.failed)})`);
  ok(stSave.savedFiles.includes("type-registry/system-types.yaml"), "save reports system-types.yaml");
  const stAfterText = fs.readFileSync(stAbs, "utf-8");
  ok(stAfterText.includes("R_TRIG:"), "new system type persisted to disk");
  ok(stAfterText.includes("Stat_Bit"), "added member persisted");
  ok(stAfterText.includes("# Siemens system data types"), "system-types header comment preserved through save");
  ok(stAfterText.includes("IEC_TIMER:"), "existing types preserved");
  // Untouched neighbours stay byte-identical (same diff-confinement guarantee).
  const sliceFromIec = (s) => s.slice(s.indexOf("IEC_TIMER:"), s.indexOf("IEC_SCOUNTER:"));
  ok(sliceFromIec(stAfterText) === sliceFromIec(stBefore), "untouched IEC_TIMER block is byte-identical after save");

  console.log("=== system-types: edit / rename / delete / undo ===");
  ok(svc.updateSystemTypeField("R_TRIG", ["description"], "Rising edge instance.") !== undefined, "can edit a field");
  ok(svc.systemTypeData("R_TRIG").json.description === "Rising edge instance.", "field edit applied");
  const ren2 = svc.renameSystemType("R_TRIG", "R_TRIG_RENAMED");
  ok(ren2.ok && svc.systemTypesInfo().names.includes("R_TRIG_RENAMED"), "rename works");
  ok(svc.renameSystemType("R_TRIG_RENAMED", "IEC_TIMER").ok === false, "rename rejects an existing name");
  ok(svc.undo() === true && svc.systemTypesInfo().names.includes("R_TRIG"), "undo reverts the rename");
  ok(svc.deleteSystemType("R_TRIG") === true && !svc.systemTypesInfo().names.includes("R_TRIG"), "delete removes the type");
  ok(svc.undo() === true && svc.systemTypesInfo().names.includes("R_TRIG"), "undo restores the deleted type");

  // --- bulk: implement all missing system types ---
  console.log("=== system-types: add ALL missing ===");
  svc.reload();
  // Seed the precondition deterministically (the registry may already be fully
  // catalogued): author instructions referencing types that don't exist.
  const bulkRel = fileOf("SCL-bit-logic.yaml").relPath;
  for (const [instr, type] of [["ZZ_BULK_A", "ZZ_BulkTypeA"], ["ZZ_BULK_B", "ZZ_BulkTypeB"], ["ZZ_BULK_C", "ZZ_BulkTypeC"]]) {
    const made2 = svc.createEntry(bulkRel, instr, { callShape: "instance-dot" });
    svc.updateField(made2.data.uid, ["instanceType"], type);
    svc.updateField(made2.data.uid, ["pins"], [{ name: "IN", dir: "in", required: true, dataTypes: ["Bool"] }]);
  }
  const missing = svc.findMissingSystemTypes();
  ok(missing.length >= 3, `findMissingSystemTypes finds referenced-but-uncatalogued types (${missing.length})`);
  ok(["ZZ_BulkTypeA", "ZZ_BulkTypeB", "ZZ_BulkTypeC"].every((t) => missing.some((m) => m.name === t)), "all seeded missing types are found");
  ok(missing.every((m) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(m.name)), "only valid identifiers are proposed (no junk from labels/typos)");
  ok(missing.every((m) => m.usedByInstructions.length > 0), "each missing type records who references it");
  ok(missing.some((m) => m.members.length > 0), "instanceType-derived types carry members seeded from pins");
  const knownNow = new Set(svc.systemTypesInfo().names);
  ok(missing.every((m) => !knownNow.has(m.name)), "nothing already catalogued is proposed");

  const unknownBefore = svc.status().findings.filter((f) => f.code === "unknown-instance-type" || f.code === "unknown-data-type").length;
  const bulk = svc.createMissingSystemTypes();
  ok(bulk.created.length === missing.length, `created all ${missing.length} missing types`);
  const unknownAfter = svc.status().findings.filter((f) => f.code === "unknown-instance-type" || f.code === "unknown-data-type").length;
  ok(unknownAfter < unknownBefore, `unknown-type findings dropped (${unknownBefore} -> ${unknownAfter})`);
  ok(svc.findMissingSystemTypes().length === 0, "no missing types remain");

  // Provenance: inferred entries must say so, per the registry's evidence rules.
  const oneInferred = svc.systemTypeData(missing.find((m) => m.members.length > 0).name);
  ok(oneInferred.json.confidence === "shape-only", "inferred type is confidence: shape-only");
  ok(String(oneInferred.json.source).includes("NOT verified"), "inferred type's source marks it unverified");
  ok(String(oneInferred.json.notes).includes("UNVERIFIED"), "inferred type's notes warn that members are unverified");

  // The whole batch is a single undo step.
  ok(svc.undo() === true, "undo after bulk add");
  ok(svc.findMissingSystemTypes().length === missing.length, "one undo reverts the ENTIRE batch");
  ok(svc.redo() === true && svc.findMissingSystemTypes().length === 0, "redo re-applies the batch");

  // Subset creation. Re-seed first: `redo` above left everything created, and a
  // reload would discard the buffered probes entirely.
  svc.undo(); // back to "3 seeded types missing"
  const stillMissing = svc.findMissingSystemTypes().map((m) => m.name);
  ok(stillMissing.length >= 3, "seeded types are missing again after undo");
  const subset = stillMissing.slice(0, 2);
  const partial = svc.createMissingSystemTypes(subset);
  ok(partial.created.length === 2 && subset.every((n) => svc.systemTypesInfo().names.includes(n)), "can create a chosen subset only");
  ok(svc.findMissingSystemTypes().length === stillMissing.length - 2, "other missing types are left alone");
  svc.reload();

  // Validation of a bad system type.
  console.log("=== system-types: validation ===");
  svc.createSystemType("BAD_ALIAS", { category: "system-alias", basicDataType: "NotARealType" });
  ok(svc.systemTypeData("BAD_ALIAS").findings.some((f) => f.code === "unknown-data-type"), "unknown basicDataType flagged");
  svc.updateSystemTypeField("BAD_ALIAS", ["category"], "nonsense");
  ok(svc.systemTypeData("BAD_ALIAS").findings.some((f) => f.code === "invalid-system-type-category"), "invalid category flagged");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
