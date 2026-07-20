// Regression test for the instruction-instance-type declaration rule.
//
// A type named as some instruction's `instanceType` (callShape: instance-dot)
// -- R_TRIG, TON_TIME, ... -- is that instruction's own instance structure, so
// it may ONLY be declared in a FUNCTION_BLOCK's VAR sections. Verified against
// TIA Portal: the same declaration in a plain DATA_BLOCK, or as a UDT/STRUCT
// member, is rejected.
//
// This is a per-BLOCK-TYPE axis, deliberately NOT expressed in
// section-legality.yaml (which is sourced per VAR section). Without the rule,
// cataloguing these types in system-types.yaml made the section-legality check
// start firing on them and produced false "not legal in a VAR section" errors
// on real, compiling fixtures -- which is what this test guards against.
"use strict";
const path = require("path");

const { loadRuleSet } = require("../out/rules/loadRules");
const { buildDocumentIndex } = require("../out/analysis/documentIndex");
const { BlockIndex } = require("../out/analysis/blockIndex");

const ruleSet = loadRuleSet(path.join(__dirname, "..", "resources"));

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`  FAIL: ${label}`);
  }
}

function codes(text) {
  return buildDocumentIndex(text, ruleSet, new BlockIndex(), "test.s7dcl", "en-US")
    .diagnostics.filter((d) => d.code === "instance-type-illegal-context" || d.code === "type-illegal-section")
    .map((d) => d.code);
}

// An instance type must be usable as FUNCTION_BLOCK instance data.
const inFb = `FUNCTION_BLOCK "F"\n  VAR\n    edge : R_TRIG;\n    timer : TON_TIME;\n  END_VAR\nEND_FUNCTION_BLOCK\n`;
ok(codes(inFb).length === 0, `instance types are legal in a FUNCTION_BLOCK VAR section (got ${JSON.stringify(codes(inFb))})`);

// ...but not anywhere else.
const inDb = `DATA_BLOCK "D"\n  VAR\n    edge : R_TRIG;\n  END_VAR\nEND_DATA_BLOCK\n`;
ok(codes(inDb).includes("instance-type-illegal-context"), "instance type in a DATA_BLOCK is flagged");

const inStruct = `FUNCTION_BLOCK "F"\n  VAR\n    s : STRUCT\n      edge : R_TRIG;\n    END_STRUCT;\n  END_VAR\nEND_FUNCTION_BLOCK\n`;
ok(codes(inStruct).includes("instance-type-illegal-context"), "instance type as a STRUCT/UDT member is flagged");

// A type section-legality.yaml DOES cover keeps its own, separately-sourced
// handling -- IEC_TIMER is not an instance type and stays legal as an FC
// parameter, so the new rule must not capture it.
const iecInFc = `FUNCTION "C" : Void\n  VAR_INPUT\n    tmr : IEC_TIMER;\n  END_VAR\nEND_FUNCTION\n`;
ok(codes(iecInFc).length === 0, `IEC_TIMER stays legal in a FUNCTION VAR_INPUT (got ${JSON.stringify(codes(iecInFc))})`);

// The ordinary section-legality check must still work (Variant is illegal in
// Static per section-legality.yaml) -- the new branch must not swallow it.
const variantStatic = `FUNCTION_BLOCK "F"\n  VAR\n    v : Variant;\n  END_VAR\nEND_FUNCTION_BLOCK\n`;
ok(codes(variantStatic).includes("type-illegal-section"), "ordinary section-legality violations are still reported");

// --- the instance-DATA_BLOCK exception ---------------------------------
// A global instance DB is the legitimate way to call an `instance-dot`
// instruction from outside a FUNCTION_BLOCK: the DB itself IS the instance
// (`DATA_BLOCK "R_TRIG_DB" {InstructionName := 'R_TRIG'} R_TRIG`), and
// `"R_TRIG_DB"();` calls it. Its type sits in the block's own instance-of
// position, NOT in a VAR section, so the FUNCTION_BLOCK-only rule above must
// not touch it -- and the DB must be indexed so the call resolves.
const { parseS7dclFile } = require("../out/parser/s7dclParser");
const { scanBlockFile } = require("../out/analysis/blockIndex");
const { buildTypeCache } = require("../out/cache/typeCache");
const { checkSclInstructions } = require("../out/linter/sclInstructionChecks");

const INSTANCE_DB =
  'DATA_BLOCK "R_TRIG_DB"\n' +
  "{InstructionName := 'R_TRIG';\n S7_Optimized_Access := 'TRUE' }\n" +
  "R_TRIG\n\nBEGIN\n\nEND_DATA_BLOCK\n";

ok(codes(INSTANCE_DB).length === 0, `an instance DATA_BLOCK declaration is not flagged (got ${JSON.stringify(codes(INSTANCE_DB))})`);

const indexed = scanBlockFile("R_TRIG_DB.db", INSTANCE_DB);
ok(indexed.length === 1 && indexed[0].name === "R_TRIG_DB" && indexed[0].blockType === "DATA_BLOCK", "an instance DATA_BLOCK is indexable as a workspace block");

function callDiagnostics(indexFiles) {
  const bi = new BlockIndex();
  bi.rebuild(indexFiles);
  const caller = 'FUNCTION_BLOCK "Caller"\nVAR\nEND_VAR\nBEGIN\n  "R_TRIG_DB"();\nEND_FUNCTION_BLOCK\n';
  const tc = buildTypeCache(ruleSet, []);
  const out = [];
  for (const b of parseS7dclFile(caller)) out.push(...checkSclInstructions(b, ruleSet, bi, tc));
  return out.map((d) => d.code);
}
ok(
  callDiagnostics([{ path: "R_TRIG_DB.db", text: INSTANCE_DB }]).length === 0,
  "calling a global instance DB resolves cleanly once the .db file is indexed"
);
ok(
  callDiagnostics([]).includes("external-symbol-not-found"),
  "sanity: the same call IS reported when the DB isn't indexed (what the .db glob fixes)"
);

// An instance DB may equally be declared inside an authored .scl file, which
// bundles several declarations -- both orders must index, so the call resolves
// regardless of whether the DB appears before or after its caller.
const SCL_WITH_DB =
  INSTANCE_DB + '\nFUNCTION_BLOCK "Caller"\nVAR\nEND_VAR\nBEGIN\n  "R_TRIG_DB"();\nEND_FUNCTION_BLOCK\n';
const SCL_DB_LAST =
  'FUNCTION_BLOCK "Caller"\nVAR\nEND_VAR\nBEGIN\n  "R_TRIG_DB"();\nEND_FUNCTION_BLOCK\n\n' + INSTANCE_DB;
for (const [label, text] of [["DB first", SCL_WITH_DB], ["DB last", SCL_DB_LAST]]) {
  const names = scanBlockFile("bundled.scl", text).map((b) => `${b.blockType}:${b.name}`).sort();
  ok(
    names.includes("DATA_BLOCK:R_TRIG_DB") && names.includes("FUNCTION_BLOCK:Caller"),
    `an instance DB bundled in a .scl file is indexed alongside its caller (${label})`
  );
  ok(callDiagnostics([{ path: "bundled.scl", text }]).length === 0, `the call resolves from a .scl-bundled instance DB (${label})`);
}

// The workspace index is built from files on DISK, so a block declared in the
// buffer currently being edited is invisible to its own lint pass until the
// file is saved and re-scanned. BlockIndex.withOverlay closes that gap --
// without it, a self-contained .scl reports its OWN instance DB as
// `external-symbol-not-found` while you are typing.
{
  const selfContained = SCL_WITH_DB;
  const index = new BlockIndex();
  index.rebuild([]); // nothing indexed yet (unsaved / pre-rebuild)
  const tc = buildTypeCache(ruleSet, []);
  const lint = () => {
    const out = [];
    for (const b of parseS7dclFile(selfContained)) out.push(...checkSclInstructions(b, ruleSet, index, tc));
    return out.map((d) => d.code);
  };
  ok(lint().includes("external-symbol-not-found"), "sanity: a disk-only index misses the buffer's own DB");
  ok(index.get("R_TRIG_DB") === undefined, "sanity: lookup (what hover uses) also misses it");

  index.setDocumentOverlay("buffer.scl", selfContained);
  ok(lint().length === 0, "overlay makes the document's own blocks resolve before save/reindex");
  // Hover/definition/rename/completion all go through `get`/`values` on the
  // SAME shared index -- a lint-only overlay left hover saying "not found in
  // workspace" for a symbol the linter had already accepted.
  ok(index.get("R_TRIG_DB") !== undefined, "hover/definition lookups resolve the overlaid DB");
  ok(index.values().some((b) => b.name === "R_TRIG_DB"), "completion's values() lists the overlaid DB");

  // Re-registering the same path replaces (not duplicates) its blocks.
  index.setDocumentOverlay("buffer.scl", selfContained);
  ok(index.values().filter((b) => b.name === "R_TRIG_DB").length === 1, "re-registering a document replaces its overlay");

  // An open buffer's definition wins over a stale on-disk copy.
  index.rebuild([{ path: "buffer.scl", text: 'FUNCTION_BLOCK "OnlyOnDisk"\nVAR\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n' }]);
  ok(index.get("R_TRIG_DB") !== undefined, "overlay survives a workspace rebuild");
  ok(index.get("OnlyOnDisk") !== undefined, "disk blocks remain visible alongside overlays");

  index.clearDocumentOverlay("buffer.scl");
  ok(index.get("R_TRIG_DB") === undefined, "closing the document drops its overlay");
}

// --- instance-DB hover enrichment --------------------------------------
// Hovering `"R_TRIG_DB"()` should show WHAT the DB is an instance of, not just
// "(data block)": an instruction instance DB resolves through the instruction
// registry, an FB single-instance DB through the workspace index.
{
  const FB_INSTANCE_DB =
    'DATA_BLOCK "Pump_DB"\n' +
    "{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\nNON_RETAIN\n" +
    '"FB_Pump"\n\nBEGIN\n\nEND_DATA_BLOCK\n';
  const FB_PUMP = 'FUNCTION_BLOCK "FB_Pump"\nVAR_INPUT\n  i_x : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n';
  const GLOBAL_DB =
    'DATA_BLOCK "Plain_DB"\n' + "{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\nNON_RETAIN\n   VAR\n      a : Bool;\n   END_VAR\n\nBEGIN\n\nEND_DATA_BLOCK\n";

  // The parser must tell the shapes apart (see ParsedBlockFile.instanceOf).
  const shapeOf = (text) => {
    const b = parseS7dclFile(text)[0];
    return { instanceOf: b.instanceOf, instructionName: b.instructionName };
  };
  const instrShape = shapeOf(INSTANCE_DB);
  ok(instrShape.instructionName === "R_TRIG", "InstructionName pragma is captured");
  ok(instrShape.instanceOf && instrShape.instanceOf.name === "R_TRIG" && instrShape.instanceOf.quoted === false, "an instruction instance-of line is unquoted");
  const fbShape = shapeOf(FB_INSTANCE_DB);
  ok(fbShape.instanceOf && fbShape.instanceOf.name === "FB_Pump" && fbShape.instanceOf.quoted === true, "an FB instance-of line is quoted");
  ok(fbShape.instructionName === undefined, "an FB instance DB has no InstructionName pragma");
  ok(shapeOf(GLOBAL_DB).instanceOf === undefined, "a global DB (VAR section) has no instance-of");
  ok(shapeOf(FB_PUMP).instanceOf === undefined, "a FUNCTION_BLOCK has no instance-of");

  const bi = new BlockIndex();
  bi.rebuild([
    { path: "instr.scl", text: INSTANCE_DB },
    { path: "fbdb.scl", text: FB_INSTANCE_DB },
    { path: "fb.scl", text: FB_PUMP },
    { path: "plain.scl", text: GLOBAL_DB },
  ]);
  const caller =
    'FUNCTION_BLOCK "C"\nVAR\nEND_VAR\nBEGIN\n  "R_TRIG_DB"();\n  "Pump_DB"();\n  "Plain_DB"();\n  "Nope_DB"();\nEND_FUNCTION_BLOCK\n';
  const hovers = buildDocumentIndex(caller, ruleSet, bi, "caller.scl", "en-US").spans
    .map((s) => s.hoverMarkdown)
    .filter(Boolean);
  const hoverFor = (name) => hovers.find((h) => h.includes(`"${name}"`)) ?? "";

  const instrHover = hoverFor("R_TRIG_DB");
  ok(instrHover.includes("(data block)"), "instance DB hover still identifies the block kind");
  ok(instrHover.includes("instance of instruction"), "instruction instance DB hover names what it instances");
  ok(instrHover.includes("bit-logic") && instrHover.includes("| CLK |"), "instruction instance DB hover renders the registry entry (family + pins)");

  const fbHover = hoverFor("Pump_DB");
  ok(fbHover.includes("single instance of") && fbHover.includes("FB_Pump"), "FB single-instance DB hover names the FUNCTION_BLOCK");
  ok(fbHover.includes("fb.scl"), "FB single-instance DB hover points at the FB's file");

  ok(!hoverFor("Plain_DB").includes("instance of"), "a global DB hover gains no instance-of section");
  ok(hoverFor("Nope_DB").includes("not found in workspace"), "an unknown reference still reports not-found");

  // --- dotted access through an instance DB ---
  // An instance DB owns no VAR members, so `"R_TRIG_DB".Q` must resolve
  // through to what it instances (instruction pins / the FB's interface)
  // rather than reporting every member as "not found on" the DB.
  const TON_DB = 'DATA_BLOCK "TON_DB"\n' + "{InstructionName := 'TON_TIME' }\nTON_TIME\nBEGIN\nEND_DATA_BLOCK\n";
  const bi2 = new BlockIndex();
  bi2.rebuild([
    { path: "instr.scl", text: INSTANCE_DB },
    { path: "ton.scl", text: TON_DB },
    { path: "fbdb.scl", text: FB_INSTANCE_DB },
    { path: "fb.scl", text: FB_PUMP },
    { path: "plain.scl", text: GLOBAL_DB },
  ]);
  const dotted =
    'FUNCTION_BLOCK "C"\nVAR\n  o : Bool;\nEND_VAR\nBEGIN\n' +
    '  #o := "R_TRIG_DB".Q;\n  #o := "TON_DB".ET;\n  #o := "Pump_DB".i_x;\n  #o := "Plain_DB".a;\n  #o := "R_TRIG_DB".Nonsense;\nEND_FUNCTION_BLOCK\n';
  const dotIdx = buildDocumentIndex(dotted, ruleSet, bi2, "caller.scl", "en-US");
  const memberSpans = dotIdx.spans.filter((s) => s.hoverMarkdown && s.hoverMarkdown.startsWith("**."));
  const member = (name) => memberSpans.find((s) => s.hoverMarkdown.startsWith(`**.${name}**`));

  ok(dotIdx.diagnostics.length === 0, "dotted access through instance DBs emits no diagnostics");
  ok(member("Q") && member("Q").hoverMarkdown.includes("`Bool`"), "instruction instance DB member resolves its type (.Q -> Bool)");
  ok(member("Q").hoverMarkdown.includes("R_TRIG"), "instruction instance DB member names the source instruction");
  // Pin casing differs between the graphical (`q`) and SCL (`Q`) registries --
  // resolution is case-insensitive so either spelling works.
  ok(member("ET") && member("ET").hoverMarkdown.includes("Time"), "a multi-type instance member lists its types (.ET)");
  ok(member("i_x") && member("i_x").hoverMarkdown.includes("VAR_INPUT of FB_Pump"), "FB instance DB member resolves via the FUNCTION_BLOCK's interface");
  ok(member("i_x").definition && String(member("i_x").definition.file).includes("fb.scl"), "FB instance DB member's definition points at the FB's file");
  ok(member("a") && member("a").hoverMarkdown.includes("`Bool`"), "a global DB's own VAR member still resolves");
  ok(member("Nonsense") && member("Nonsense").hoverMarkdown.includes("not found on"), "an unknown member is still reported as not found");
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
