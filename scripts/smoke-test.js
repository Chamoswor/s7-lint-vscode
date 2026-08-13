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

// The pin AFTER a parenthesised argument value. `walkCallArgs` used to end
// its whole argument-list walk at the sub-expression's own `)`, so `PT` got
// no span at all: no hover, no Ctrl+click, no pin/type validation.
expectSpan(12, "PT", "parameter", "a pin following a parenthesised value must still resolve");
expectSpan(12, "IN", "parameter", "the pin before it, as a control");
expectSpan(12, "Limit", "variable", "that pin's own value");
expectSpan(12, "A", "variable", "operands INSIDE the parenthesised value still resolve");
expectSpan(12, "T1", "callable", "an instruction instance reads as callable, not as a plain variable");
expectSpan(7, "TON", "callable", "...and so does its declared type");
expectSpan(4, "TIME", "type", "a Siemens elementary type");

const totalDetectedDiagnostics = totalDiags + totalLadWiringDiags + totalLiteralDiags + totalUndeclaredDiags + totalStructCountDiags + totalSclDiags;
if (totalFixtureFailures > 0 || totalDetectedDiagnostics > 0) {
  console.error(`\nSmoke test failed: ${totalFixtureFailures} fixture failure(s), ${totalDetectedDiagnostics} diagnostic(s).`);
  process.exitCode = 1;
} else {
  console.log("\nSmoke test complete.");
}
