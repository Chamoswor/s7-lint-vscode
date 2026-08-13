// Standalone Node smoke test -- exercises the pure parser/cache/checker/
// analysis logic (no vscode API) against anonymized fixture files, so the
// core engine can be sanity-checked without launching the Extension
// Development Host.
"use strict";
const fs = require("fs");
const path = require("path");

const { loadRuleSet } = require("../out/rules/loadRules");
const { parseS7dclBlock, parseS7dclFile, detectS7dclKind } = require("../out/parser/s7dclParser");
const { checkInstructions } = require("../out/linter/instructionChecks");
const { checkStructCountPerDataBlock } = require("../out/linter/compositionChecks");
const { checkLadWiring } = require("../out/linter/ladWiringChecks");
const { checkSclInstructions } = require("../out/linter/sclInstructionChecks");
const { checkUndeclaredIdentifiers, checkSclConditionTypes } = require("../out/linter/symbolChecks");
const { checkSclExpressionTypes } = require("../out/linter/exprTypeChecks");
const { checkSclSyntaxStructure } = require("../out/linter/synStructureChecks");
const { BlockIndex } = require("../out/analysis/blockIndex");
const { buildDocumentIndex } = require("../out/analysis/documentIndex");
const { buildTypeCache } = require("../out/cache/typeCache");
const { parseUdtText } = require("../out/parser/udtTextParser");

const ROOT = path.resolve(__dirname, "..", "..");
const ruleSet = loadRuleSet(path.join(__dirname, "..", "resources"));
console.log(
  `Loaded ${Object.keys(ruleSet.instructions).length} instructions, ${Object.keys(ruleSet.baseTypes).length} base types, ${Object.keys(ruleSet.systemTypes).length} system types, ${ruleSet.opaqueSectionNames.size} opaque names.`
);

function readText(p) {
  return fs.readFileSync(p, "utf-8");
}

// This corpus intentionally contains only the twelve anonymized .s7dcl
// exports exercised below. Unrelated project exports are not retained.
console.log("\n=== .s7dcl instruction + literal/operand-type checks (anonymized graphical-control fixtures) ===");
const graphicalFixtureRoot = path.join(__dirname, "fixtures", "smoke", "graphical-control");
const graphicalFiles = [
  "system/CyclicInterrupt.s7dcl",
  "system/Startup.s7dcl",
  "process/FB_PrimaryLoop.s7dcl",
  "process/FB_SecondaryLoop.s7dcl",
  "process/FB_AuxiliaryLoop.s7dcl",
  "system/Main.s7dcl",
  "safety/SafetyController.s7dcl",
  "components/FB_MotorProtection.s7dcl",
  "components/FB_Pump.s7dcl",
  "components/FB_DualPump.s7dcl",
  "components/FB_FlowMonitor.s7dcl",
  "components/FB_ControlValve.s7dcl",
].map((f) => path.join(graphicalFixtureRoot, f));

const blockIndex = new BlockIndex();
blockIndex.rebuild(graphicalFiles.map((p) => ({ path: p, text: readText(p) })));
const graphicalTypeCache = buildTypeCache(ruleSet, []); // no UDT/.udt fixtures in this corpus, see comment above

let totalCalls = 0;
let totalDiags = 0;
let totalLadWiringDiags = 0;
let totalLiteralDiags = 0;
let totalUndeclaredDiags = 0;
let totalStructCountDiags = 0;
let totalFixtureFailures = 0;
for (const file of graphicalFiles) {
  const text = readText(file);
  const kind = detectS7dclKind(text);
  const relName = path.relative(ROOT, file);
  if (kind !== "block") {
    totalFixtureFailures++;
    console.log(`-- ${relName}: kind=${kind}, SKIPPED --`);
    continue;
  }
  const block = parseS7dclBlock(text);
  if (!block) {
    totalFixtureFailures++;
    console.log(`-- ${relName}: FAILED TO PARSE --`);
    continue;
  }
  let callCount = 0;
  for (const net of block.networks) for (const rung of net.rungs) callCount += rung.calls.length;
  const diags = checkInstructions(block, ruleSet);
  const ladWiringDiags = checkLadWiring(block);
  const literalDiags = buildDocumentIndex(text, ruleSet, blockIndex).diagnostics;
  const undeclaredDiags = checkUndeclaredIdentifiers(block, blockIndex, graphicalTypeCache, ruleSet);
  const structCountDiags = checkStructCountPerDataBlock(block, ruleSet);
  totalCalls += callCount;
  totalDiags += diags.length;
  totalLadWiringDiags += ladWiringDiags.length;
  totalLiteralDiags += literalDiags.length;
  totalUndeclaredDiags += undeclaredDiags.length;
  totalStructCountDiags += structCountDiags.length;
  console.log(`-- ${relName}: ${block.blockType} "${block.name}", ${block.networks.length} network(s), ${callCount} call(s), ${diags.length} instruction diagnostic(s), ${ladWiringDiags.length} LAD-wiring diagnostic(s), ${literalDiags.length} literal/operand-type diagnostic(s), ${undeclaredDiags.length} undeclared-identifier diagnostic(s), ${structCountDiags.length} composition diagnostic(s) --`);
  for (const d of [...diags, ...ladWiringDiags, ...literalDiags, ...undeclaredDiags, ...structCountDiags]) {
    console.log(`    [${d.severity}] L${d.line}C${d.col} (${d.code}) ${d.message}`);
  }
}
console.log(`\nTotals across graphical-control fixtures: ${totalCalls} instruction calls, ${totalDiags} instruction diagnostics, ${totalLadWiringDiags} LAD-wiring diagnostics, ${totalLiteralDiags} literal/operand-type diagnostics, ${totalUndeclaredDiags} undeclared-identifier diagnostics, ${totalStructCountDiags} composition diagnostics.`);

// .scl support -- authored SCL source (as opposed to a .s7dcl TIA EXPORT)
// routinely bundles several TYPE/FUNCTION_BLOCK declarations in one file;
// parseS7dclFile handles that (parseS7dclBlock only ever parses the FIRST
// one). Exercises the bare `#Instance(...)` call shape, case-insensitive
// SCL instruction-name lookup, and the BlockIndex fallback for custom FB
// instance calls -- see linter/sclInstructionChecks.ts.
console.log("\n=== .scl instruction checks (anonymized SCL fixtures) ===");
const sclFiles = [
  path.join(__dirname, "fixtures", "smoke", "distributed-process-control.scl"),
  // Regression guard for the split-across-tokens `<prefix>#<value>` literal
  // forms (parser/literalRun.ts) -- see that fixture's own header.
  path.join(__dirname, "fixtures", "smoke", "constant-notations.scl"),
  // Regression guard for quoted names and cross-block references -- see that
  // fixture's own header.
  path.join(__dirname, "fixtures", "smoke", "cross-reference-syntax.scl"),
];
const sclBlockIndex = new BlockIndex();
sclBlockIndex.rebuild(sclFiles.map((p) => ({ path: p, text: readText(p) })));

function expectIndexedBlockShape(condition, description) {
  if (condition) {
    console.log(`-- PASS: ${description} --`);
    return;
  }
  totalFixtureFailures++;
  console.error(`-- FAIL: ${description} --`);
}

const fbUnitDb = sclBlockIndex.get("Fb_Unit_DB");
expectIndexedBlockShape(
  fbUnitDb?.instanceOf?.name === "Fb_Unit" && fbUnitDb.instanceOf.quoted === true,
  "typed DATA_BLOCK indexes its quoted FUNCTION_BLOCK instance type"
);
const storeDb = sclBlockIndex.get("Store");
const storeRec = storeDb?.vars.get("Rec")?.member.typeRef;
expectIndexedBlockShape(storeDb?.instanceOf === undefined, "global DATA_BLOCK outer STRUCT is not mistaken for an instance type");
expectIndexedBlockShape(storeDb?.vars.has("Units") === true && storeDb.vars.has("Rec") === true, "global DATA_BLOCK outer STRUCT indexes direct members");
expectIndexedBlockShape(
  storeRec?.kind === "inline-struct" && storeRec.members.some((member) => member.name === "3_Slave"),
  "quoted nested STRUCT member is stored under its symbolic unquoted name"
);

// Real UDT type cache (analysis/symbolTable.ts's cross-type member
// resolution needs it for checkUndeclaredIdentifiers/checkSclConditionTypes)
// -- same parseUdtText + buildTypeCache pipeline cache/cacheManager.ts uses.
const sclTypeCache = buildTypeCache(
  ruleSet,
  sclFiles.map((p) => ({ path: p, decls: parseUdtText(readText(p)) })).filter((f) => f.decls.length > 0)
);

let totalSclDecls = 0;
let totalSclCalls = 0;
let totalSclDiags = 0;
for (const file of sclFiles) {
  const text = readText(file);
  const relName = path.relative(ROOT, file);
  const decls = parseS7dclFile(text);
  totalSclDecls += decls.length;
  console.log(`-- ${relName}: ${decls.length} program-block declaration(s) --`);
  for (const block of decls) {
    const callCount = block.sclCalls.length;
    const diags = [
      ...checkSclInstructions(block, ruleSet, sclBlockIndex, sclTypeCache),
      ...checkUndeclaredIdentifiers(block, sclBlockIndex, sclTypeCache, ruleSet),
      ...checkSclConditionTypes(block, sclBlockIndex, sclTypeCache, ruleSet),
      ...checkSclExpressionTypes(block, ruleSet, sclBlockIndex, sclTypeCache),
    ];
    totalSclCalls += callCount;
    totalSclDiags += diags.length;
    console.log(`    -- ${block.blockType} "${block.name}": ${callCount} call(s), ${diags.length} diagnostic(s) --`);
    for (const d of diags) {
      console.log(`        [${d.severity}] L${d.line}C${d.col} (${d.code}) ${d.message}`);
    }
  }
  const syntaxDiags = checkSclSyntaxStructure(text, ruleSet);
  totalSclDiags += syntaxDiags.length;
  console.log(`    -- syntax-structure check: ${syntaxDiags.length} diagnostic(s) --`);
  for (const d of syntaxDiags) {
    console.log(`        [${d.severity}] L${d.line}C${d.col} (${d.code}) ${d.message}`);
  }
}
console.log(`\nTotals across .scl files: ${totalSclDecls} declaration(s), ${totalSclCalls} SCL instruction call(s), ${totalSclDiags} diagnostic(s).`);

// --- semantic spans (analysis/documentIndex.ts) ---------------------------
// The span list drives hover, Ctrl+click, rename AND semantic highlighting,
// so a span silently going missing degrades all four at once with no
// diagnostic to notice it by. These assert the classifications that are
// easiest to lose to a walker-recovery bug.
console.log("\n=== semantic spans (hover / definition / highlighting) ===");
const spanFixture = [
  'FUNCTION_BLOCK "SpanProbe"',
  "VERSION : 0.1",
  "VAR_INPUT",
  "    Limit : TIME;",
  "END_VAR",
  "VAR",
  "    T1 : TON;",
  "    A  : WORD;",
  "    B  : WORD;",
  "END_VAR",
  "BEGIN",
  "    T1(IN := (A = B), PT := Limit);",
  "    A.%X0 := TRUE;",
  "END_FUNCTION_BLOCK",
  "",
].join("\n");
const spanIndex = buildDocumentIndex(spanFixture, ruleSet, new BlockIndex(), "spanProbe.scl");
const spanAt = (line, text) =>
  spanIndex.spans.find((s) => s.line === line && spanFixture.split("\n")[line - 1].substr(s.startCol - 1, s.length) === text);

function expectSpan(line, text, tokenType, why) {
  const span = spanAt(line, text);
  if (span && span.tokenType === tokenType) {
    console.log(`-- PASS: L${line} '${text}' -> ${tokenType} --`);
    return;
  }
  totalFixtureFailures++;
  console.error(`-- FAIL: L${line} '${text}' -> ${span ? span.tokenType : "NO SPAN"} (expected ${tokenType}) -- ${why}`);
}

function expectCapabilities(line, text, expected, why) {
  const span = spanAt(line, text);
  const actual = ["s7Container", "s7Indexable"].filter((modifier) => span?.tokenModifiers.includes(modifier));
  if (span && JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`-- PASS: L${line} '${text}' capabilities -> ${actual.join("+") || "leaf"} --`);
    return;
  }
  totalFixtureFailures++;
  console.error(`-- FAIL: L${line} '${text}' capabilities -> ${actual.join("+") || "leaf"} (expected ${expected.join("+") || "leaf"}) -- ${why}`);
}

function expectHover(line, text, expectedText, why) {
  const span = spanAt(line, text);
  if (span?.hoverMarkdown?.includes(expectedText)) {
    console.log(`-- PASS: L${line} '${text}' hover contains '${expectedText}' --`);
    return;
  }
  totalFixtureFailures++;
  console.error(`-- FAIL: L${line} '${text}' hover -> ${span?.hoverMarkdown ?? "NO HOVER"} -- ${why}`);
}

// The pin AFTER a parenthesised argument value. `walkCallArgs` used to end
// its whole argument-list walk at the sub-expression's own `)`, so `PT` got
// no span at all: no hover, no Ctrl+click, no pin/type validation.
expectSpan(12, "PT", "parameter", "a pin following a parenthesised value must still resolve");
expectSpan(12, "IN", "parameter", "the pin before it, as a control");
expectSpan(12, "Limit", "parameter", "an FB input reads like a function parameter at its use site");
expectSpan(12, "A", "variable", "operands INSIDE the parenthesised value still resolve");
expectSpan(12, "T1", "function", "an instruction instance uses the standard callable/function family");
expectSpan(7, "TON", "s7CallableType", "an instruction instance type uses the callable-type subtype");
expectSpan(4, "TIME", "s7TemporalType", "a Siemens temporal value type uses the temporal family");
expectCapabilities(13, "A", [], "a scalar WORD remains a leaf when followed by slice access");
expectSpan(13, "%X0", "number", "a percent-prefixed bit selector is a slice token, not an object property");
expectHover(13, "%X0", "`Bool`", "a WORD bit slice resolves to Bool");

// An FB/FC interface is still the source of a resolved scalar value after
// walking through one or more UDT members. Preserve the parameter role at
// scalar leaves, while UDT/ARRAY path segments retain their structural role.
// A static VAR with the same UDT shape is the control: its leaves stay normal
// properties rather than becoming interface-colored.
const interfaceFixtureLines = [
  'TYPE "Nested"',
  "VERSION : 0.1",
  "STRUCT",
  "  Member : Int;",
  "END_STRUCT;",
  "END_TYPE",
  'TYPE "Base"',
  "VERSION : 0.1",
  "STRUCT",
  "  Test_Bool : Bool;",
  '  TestNested : "Nested";',
  "  Items : ARRAY[0..1] OF Int;",
  "END_STRUCT;",
  "END_TYPE",
  'FUNCTION_BLOCK "InterfacePaths"',
  "VAR_INPUT",
  '  TestInput : "Base";',
  "END_VAR",
  "VAR_OUTPUT",
  '  TestOutput : "Base";',
  "END_VAR",
  "VAR_IN_OUT",
  '  TestInOut : "Base";',
  "END_VAR",
  "VAR",
  '  TestVar : "Base";',
  "END_VAR",
  "BEGIN",
  "  TestOutput.Test_Bool := TestInput.Test_Bool;",
  "  TestInOut.TestNested.Member := 10;",
  "  TestInOut.Items[0] := 1;",
  "  TestVar.Test_Bool := TRUE;",
  "  TestVar.TestNested.Member := 10;",
  "END_FUNCTION_BLOCK",
  "",
];
const interfaceFixture = interfaceFixtureLines.join("\n");
const interfaceBlockIndex = new BlockIndex();
interfaceBlockIndex.rebuild([{ path: "interfacePaths.scl", text: interfaceFixture }]);
const interfaceTypeCache = buildTypeCache(ruleSet, [{ path: "interfacePaths.scl", decls: parseUdtText(interfaceFixture) }]);
const interfaceIndex = buildDocumentIndex(interfaceFixture, ruleSet, interfaceBlockIndex, "interfacePaths.scl", "en-US", interfaceTypeCache);

function interfaceSpan(lineFragment, text, occurrence = 1) {
  const line = interfaceFixtureLines.findIndex((candidate) => candidate.includes(lineFragment)) + 1;
  let seen = 0;
  return interfaceIndex.spans.find((span) => {
    if (span.line !== line || interfaceFixtureLines[line - 1].substr(span.startCol - 1, span.length) !== text) return false;
    seen++;
    return seen === occurrence;
  });
}

function expectInterfaceSpan(lineFragment, text, tokenType, modifiers, occurrence, why) {
  const span = interfaceSpan(lineFragment, text, occurrence);
  const hasModifiers = modifiers.every((modifier) => span?.tokenModifiers.includes(modifier));
  if (span?.tokenType === tokenType && hasModifiers) {
    console.log(`-- PASS: interface '${text}' -> ${tokenType}${modifiers.length ? `.${modifiers.join(".")}` : ""} --`);
    return;
  }
  totalFixtureFailures++;
  console.error(
    `-- FAIL: interface '${text}' -> ${span ? `${span.tokenType}.${span.tokenModifiers.join(".")}` : "NO SPAN"} ` +
      `(expected ${tokenType}${modifiers.length ? `.${modifiers.join(".")}` : ""}) -- ${why}`
  );
}

expectInterfaceSpan("TestOutput.Test_Bool", "Test_Bool", "s7InterfaceMember", [], 1, "VAR_OUTPUT scalar leaves inherit the parameter role");
expectInterfaceSpan("TestOutput.Test_Bool", "Test_Bool", "s7InterfaceMember", [], 2, "VAR_INPUT scalar leaves inherit the parameter role");
expectInterfaceSpan("TestInOut.TestNested.Member", "TestNested", "property", ["s7Container"], 1, "an interface-path UDT segment keeps its container color");
expectInterfaceSpan("TestInOut.TestNested.Member", "Member", "s7InterfaceMember", [], 1, "a nested VAR_IN_OUT scalar leaf inherits the parameter role");
expectInterfaceSpan("TestInOut.Items", "Items", "property", ["s7Indexable"], 1, "an interface-path ARRAY keeps its indexable color");
expectInterfaceSpan("TestVar.Test_Bool", "Test_Bool", "property", [], 1, "a static VAR scalar member remains a normal property");
expectInterfaceSpan("TestVar.TestNested.Member", "TestNested", "property", ["s7Container"], 1, "a static VAR UDT segment remains a container property");
expectInterfaceSpan("TestVar.TestNested.Member", "Member", "property", [], 1, "a nested static VAR scalar member remains a normal property");

const totalDetectedDiagnostics = totalDiags + totalLadWiringDiags + totalLiteralDiags + totalUndeclaredDiags + totalStructCountDiags + totalSclDiags;
if (totalFixtureFailures > 0 || totalDetectedDiagnostics > 0) {
  console.error(`\nSmoke test failed: ${totalFixtureFailures} fixture failure(s), ${totalDetectedDiagnostics} diagnostic(s).`);
  process.exitCode = 1;
} else {
  console.log("\nSmoke test complete.");
}
