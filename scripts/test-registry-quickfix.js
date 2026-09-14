// Regression test for instruction-registry scaffolding from unknown calls.
// In particular, a LAD/FBD .s7dcl instance call has enough information to
// create an instance-dot entry: its VAR declaration supplies instanceType and
// := / => supply the observed input/output directions.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const { BlockIndex } = require("../out/analysis/blockIndex");
const { scaffoldInstruction } = require("../out/instructionEditor/registryQuickFixEdits");
const { checkInstructions, unknownInstructionFix } = require("../out/linter/instructionChecks");
const { parseS7dclBlock } = require("../out/parser/s7dclParser");
const { loadRuleSet } = require("../out/rules/loadRules");
const { EditorService } = require("../out/instructionEditor/editorService");
const { discoverInstructionFiles } = require("../out/instructionEditor/registryPaths");
const { detectLanguage } = require("../out/rules/fileLanguage");

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`  FAIL: ${label}`);
  }
}

const source = [
  'FUNCTION_BLOCK "Safety"',
  "  VAR",
  "    fbEStop : ESTOP1_X;",
  "  END_VAR",
  '  { S7_Language := "FBD" }',
  "  NETWORK",
  "    RUNG",
  "      #fbEStop.ESTOP1_X(",
  "        e_stop := TRUE,",
  "        ack := FALSE,",
  "        q => ,",
  "        diag =>",
  "      )",
  "    END_RUNG",
  "  END_NETWORK",
  "END_FUNCTION_BLOCK",
  "",
].join("\n");

const realResources = path.resolve(__dirname, "..", "resources");
const block = parseS7dclBlock(source);
const initialRules = loadRuleSet(realResources);
const unknown = checkInstructions(block, initialRules, new BlockIndex()).find((d) => d.code === "unknown-instruction");
const fix = unknown && unknown.registryFix;

ok(fix && fix.kind === "unknown-instruction", "unknown instance call carries a registry Quick Fix");
ok(fix && fix.callShape === "instance-dot", "Quick Fix records instance-dot call shape");
ok(fix && fix.instanceType === "ESTOP1_X", "Quick Fix resolves instanceType from the VAR declaration");
ok(
  fix && JSON.stringify(fix.pins) === JSON.stringify([
    { name: "e_stop", dir: "in" },
    { name: "ack", dir: "in" },
    { name: "q", dir: "out" },
    { name: "diag", dir: "out" },
  ]),
  "Quick Fix retains named pins and explicit input/output directions"
);

const unresolved = unknownInstructionFix(block.networks[0].rungs[0].calls[0], false);
ok(unresolved === undefined, "instance Quick Fix is withheld when no declaration type was resolved");

const boxFix = unknownInstructionFix(
  { name: "NEW_BOX", instancePrefix: null, pins: [{ name: "IN", dir: "in" }], line: 1, col: 1 },
  true
);
ok(boxFix && boxFix.callShape === "box" && boxFix.pins[0].name === "IN", "existing plain SCL box scaffold remains supported");

// GitHub issue #7: the SCL conversion file was named `SCL.-conversion.yaml`,
// which rules/fileLanguage.ts doesn't classify as SCL -- so "Add to the
// instruction registry" for an SCL conversion instruction found no SCL file
// to put it in (and the file's entries loaded into the LAD/FBD map). Every
// builtin file must encode its language in its basename.
const registryRoot = path.join(realResources, "instruction-registry");
const unclassified = discoverInstructionFiles(registryRoot).filter((f) => !detectLanguage(f.fileName));
ok(unclassified.length === 0, `every registry file's basename encodes its language (offenders: ${unclassified.map((f) => f.relPath).join(", ") || "none"})`);
const sclConversionTarget = new EditorService(realResources).suggestFileForFamily("conversion", true);
ok(
  sclConversionTarget === "builtin/01-basic-instructions/10-conversion/SCL-conversion.yaml",
  `SCL 'conversion' scaffold has a target file (got ${sclConversionTarget})`
);
ok(loadRuleSet(realResources).sclInstructions.INT_TO_UINT !== undefined, "SCL conversion entries load into the SCL map, not the LAD/FBD one");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "registry-qf-"));
const tempResources = path.join(tempRoot, "resources");
fs.cpSync(realResources, tempResources, { recursive: true });
try {
  const result = scaffoldInstruction(tempResources, {
    instructionName: fix.instructionName,
    family: "bit-logic",
    scl: false,
    callShape: fix.callShape,
    instanceType: fix.instanceType,
    pins: fix.pins,
  });
  ok(result.ok, `instance instruction scaffold saves (${result.reason || result.relPath})`);

  const reloaded = loadRuleSet(tempResources);
  const entry = reloaded.instructions.ESTOP1;
  ok(entry && entry.callShape === "instance-dot", "saved entry has instance-dot callShape");
  ok(entry && entry.instanceType === "ESTOP1", "saved entry has the declared instanceType");
  ok(
    entry && entry.pins.some((p) => p.name?.toLowerCase() === "q" && p.dir === "out"),
    "saved entry retains output direction"
  );
  ok(
    !checkInstructions(block, reloaded, new BlockIndex()).some((d) => d.code === "unknown-instruction"),
    "reloaded scaffold resolves the original unknown-instruction diagnostic"
  );

  // Issue #7 end to end: an SCL conversion instruction the registry doesn't
  // know yet scaffolds into the SCL conversion file and loads as SCL.
  const conversion = scaffoldInstruction(tempResources, {
    instructionName: "MYTYPE_TO_INT",
    family: "conversion",
    scl: true,
    callShape: "box",
    pins: [{ name: "IN", dir: "in" }],
  });
  ok(
    conversion.ok && conversion.relPath === "builtin/01-basic-instructions/10-conversion/SCL-conversion.yaml",
    `SCL conversion scaffold saves into SCL-conversion.yaml (${conversion.reason || conversion.relPath})`
  );
  ok(loadRuleSet(tempResources).sclInstructions.MYTYPE_TO_INT !== undefined, "scaffolded SCL conversion entry loads into the SCL map");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
