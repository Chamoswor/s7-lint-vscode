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
const { checkMainSafetyBlockInterface, checkStructCountPerDataBlock } = require("../out/linter/compositionChecks");
const { checkLadWiring } = require("../out/linter/ladWiringChecks");
const { checkSclInstructions } = require("../out/linter/sclInstructionChecks");
const { checkUndeclaredIdentifiers, checkSclConditionTypes } = require("../out/linter/symbolChecks");
const { checkSclExpressionTypes } = require("../out/linter/exprTypeChecks");
const { checkSclSyntaxStructure } = require("../out/linter/synStructureChecks");
const { BlockIndex } = require("../out/analysis/blockIndex");
const { buildDocumentIndex } = require("../out/analysis/documentIndex");
const { buildTypeCache } = require("../out/cache/typeCache");
const { parseUdtText } = require("../out/parser/udtTextParser");
const { calculateStandardUdtLayout, isStandardTypeLayout } = require("../out/analysis/typeLayout");

const ROOT = path.resolve(__dirname, "..", "..");
const ruleSet = loadRuleSet(path.join(__dirname, "..", "resources"));
console.log(
  `Loaded ${Object.keys(ruleSet.instructions).length} instructions, ${Object.keys(ruleSet.baseTypes).length} base types, ${Object.keys(ruleSet.systemTypes).length} system types, ${ruleSet.opaqueSectionNames.size} opaque names.`
);

function readText(p) {
  return fs.readFileSync(p, "utf-8");
}

const safetyCallWithoutMetadata = parseS7dclBlock(`
{ S7_Safety := "TRUE" }
FUNCTION_BLOCK "SafetyHelper"
VAR
  stopInstance : ESTOP1;
END_VAR
{ S7_Language := "FBD" }
NETWORK
  RUNG
    #stopInstance.ESTOP1(E_STOP := TRUE, ACK_NEC := TRUE, ACK := FALSE, TIME_DEL := T#0ms, Q =>, Q_DELAY =>, ACK_REQ =>, DIAG =>)
  END_RUNG
END_NETWORK
END_FUNCTION_BLOCK`);
if (!safetyCallWithoutMetadata) throw new Error("Safety metadata fixture failed to parse");
const safetyMetadataDiags = checkInstructions(safetyCallWithoutMetadata, ruleSet).filter((d) => d.code === "safety-call-metadata-missing");
if (safetyMetadataDiags.length !== 1) throw new Error("Expected missing Safety call metadata diagnostic");

const safetyCallWithEnable = parseS7dclBlock(`
{ S7_Safety := "TRUE" }
FUNCTION_BLOCK "SafetyMain"
VAR
  helper : "SafetyHelper";
END_VAR
{ S7_Language := "FBD" }
NETWORK
  RUNG TRUE
    #helper()
  END_RUNG
END_NETWORK
END_FUNCTION_BLOCK`);
if (!safetyCallWithEnable) throw new Error("Safety CallBox EN fixture failed to parse");
const safetyEnableDiags = checkInstructions(safetyCallWithEnable, ruleSet).filter((d) => d.code === "safety-call-enable-input");
if (safetyEnableDiags.length !== 1 || safetyEnableDiags[0].message.indexOf("RUNG operand: TRUE") < 0) {
  throw new Error("Expected Safety CallBox EN diagnostic on the RUNG operand");
}

const mainSafetyWithParameter = parseS7dclBlock(`
{ S7_BlockNumber := "1"; S7_Safety := "TRUE" }
FUNCTION_BLOCK "SafetyProgram"
VAR_OUTPUT
  Ready : Bool;
  Healthy : Bool;
END_VAR
END_FUNCTION_BLOCK`);
if (!mainSafetyWithParameter) throw new Error("Main-safety interface fixture failed to parse");
const mainSafetyInterfaceDiags = checkMainSafetyBlockInterface(mainSafetyWithParameter, ruleSet);
if (mainSafetyInterfaceDiags.length !== 2 || mainSafetyInterfaceDiags.some((d) => d.code !== "main-safety-block-interface-parameters")) {
  throw new Error("Expected one main-safety interface diagnostic per parameter");
}

const ordinarySafetyBlock = parseS7dclBlock(`
{ S7_BlockNumber := "2"; S7_Safety := "TRUE" }
FUNCTION_BLOCK "SafetyHelper"
VAR_OUTPUT
  Ready : Bool;
END_VAR
END_FUNCTION_BLOCK`);
if (!ordinarySafetyBlock || checkMainSafetyBlockInterface(ordinarySafetyBlock, ruleSet).length !== 0) {
  throw new Error("A non-main safety block must allow interface parameters");
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

// A graphical call names an FB's external instance DB, but its named
// arguments belong to the FUNCTION_BLOCK interface. Regression guard for
// validating against the DB's empty member map (which reported every real
// VAR_INPUT/VAR_OUTPUT pin as unknown).
const externalFbText = [
  'FUNCTION_BLOCK "FB_ExternalProbe"',
  "VAR_INPUT",
  "  i_Enable : Bool;",
  "END_VAR",
  "VAR_OUTPUT",
  "  q_Value : Real;",
  "END_VAR",
  "BEGIN",
  "END_FUNCTION_BLOCK",
].join("\n");
const externalDbText = [
  'DATA_BLOCK "FB_ExternalProbe_DB"',
  "NON_RETAIN",
  '"FB_ExternalProbe"',
  "BEGIN",
  "END_DATA_BLOCK",
].join("\n");
const externalCallText = [
  'ORGANIZATION_BLOCK "ExternalCallProbe"',
  "NETWORK",
  "  RUNG",
  '    "FB_ExternalProbe_DB"(',
  "      i_Enable := TRUE,",
  "      q_Value => ,",
  "      BadPin := TRUE",
  "    )",
  "  END_RUNG",
  "END_NETWORK",
  "END_ORGANIZATION_BLOCK",
].join("\n");
const externalCallBlockIndex = new BlockIndex();
externalCallBlockIndex.rebuild([
  { path: "FB_ExternalProbe.scl", text: externalFbText },
  { path: "FB_ExternalProbe_DB.db", text: externalDbText },
  { path: "ExternalCallProbe.s7dcl", text: externalCallText },
]);
const externalCallDocumentIndex = buildDocumentIndex(externalCallText, ruleSet, externalCallBlockIndex, "ExternalCallProbe.s7dcl");
const externalCallUnknownPins = externalCallDocumentIndex.diagnostics.filter((diagnostic) => diagnostic.code === "unknown-pin");
expectIndexedBlockShape(
  externalCallUnknownPins.length === 1 && externalCallUnknownPins[0].message.includes("BadPin"),
  "external FB instance DB calls validate pins against the instanced FUNCTION_BLOCK interface"
);
const externalOutputLine = externalCallText.split("\n").findIndex((line) => line.includes("q_Value")) + 1;
const externalOutputSpan = externalCallDocumentIndex.spans.find(
  (span) => span.line === externalOutputLine && externalCallText.split("\n")[span.line - 1].substr(span.startCol - 1, span.length) === "q_Value"
);
expectIndexedBlockShape(
  externalOutputSpan?.definition?.file === "FB_ExternalProbe.scl",
  "external FB instance DB pin definitions resolve to the FUNCTION_BLOCK declaration"
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

// Type classification was already case-insensitive, but hover used to index
// the registry by exact source spelling. Canonical, upper, and lower-case
// spellings must all resolve to the same built-in/system type documentation.
const typeCaseFixture = [
  'FUNCTION_BLOCK "TypeCaseProbe"',
  "VAR",
  "    Canonical : Word;",
  "    Upper     : WORD;",
  "    Lower     : word;",
  "    Runtime   : iec_timer;",
  "END_VAR",
  "BEGIN",
  "END_FUNCTION_BLOCK",
  "",
].join("\n");
const typeCaseIndex = buildDocumentIndex(typeCaseFixture, ruleSet, new BlockIndex(), "typeCaseProbe.scl");
const typeCaseLines = typeCaseFixture.split("\n");
function expectTypeCaseHover(line, sourceSpelling, canonicalName) {
  const span = typeCaseIndex.spans.find(
    (candidate) =>
      candidate.line === line &&
      typeCaseLines[line - 1].slice(candidate.startCol - 1, candidate.startCol - 1 + candidate.length) === sourceSpelling
  );
  if (span?.hoverMarkdown?.includes(`**${canonicalName}**`)) {
    console.log(`-- PASS: L${line} '${sourceSpelling}' hover resolves canonical '${canonicalName}' --`);
    return;
  }
  totalFixtureFailures++;
  console.error(`-- FAIL: L${line} '${sourceSpelling}' hover -> ${span?.hoverMarkdown ?? "NO HOVER"}; expected **${canonicalName}** --`);
}
expectTypeCaseHover(3, "Word", "Word");
expectTypeCaseHover(4, "WORD", "Word");
expectTypeCaseHover(5, "word", "Word");
expectTypeCaseHover(6, "iec_timer", "IEC_TIMER");

// Siemens standard/non-optimized layout regression. This includes the
// official padding shape where an odd-length ARRAY follows three BYTEs:
// the ARRAY starts on the next WORD and is padded at its end. String[7]
// additionally proves that the parser retains the declared capacity.
const layoutFixtureLines = [
  'TYPE "WirePayload"',
  "VERSION : 0.1",
  "STRUCT",
  "  A     : Byte;",
  "  B     : Byte;",
  "  C     : Byte;",
  "  Bytes : ARRAY[0..6] OF Byte;",
  "  Tail  : Byte;",
  "  Label : String[7];",
  "END_STRUCT;",
  "END_TYPE",
  'DATA_BLOCK "LayoutStore"',
  "{ S7_Optimized_Access := 'FALSE' }",
  "VAR",
  '  Payload : "WirePayload";',
  "END_VAR",
  "BEGIN",
  "END_DATA_BLOCK",
  'FUNCTION "ReadLayout" : Void',
  "BEGIN",
  '  "LayoutStore".Payload.Tail := 1;',
  "END_FUNCTION",
  "",
];
const layoutFixture = layoutFixtureLines.join("\n");
const layoutTypeCache = buildTypeCache(ruleSet, [{ path: "layoutProbe.scl", decls: parseUdtText(layoutFixture) }]);
const layoutBlockIndex = new BlockIndex();
layoutBlockIndex.rebuild([{ path: "layoutProbe.scl", text: layoutFixture }]);
const wireLayout = calculateStandardUdtLayout("WirePayload", ruleSet, layoutTypeCache);
expectIndexedBlockShape(
  isStandardTypeLayout(wireLayout) && wireLayout.sizeBits === 24 * 8 && wireLayout.paddingBits === 4 * 8,
  "UDT standard layout applies ARRAY/STRING word-boundary padding (24 bytes, including 4 bytes padding)"
);
expectIndexedBlockShape(layoutBlockIndex.get("LayoutStore")?.optimizedAccess === false, "DATA_BLOCK retains S7_Optimized_Access=FALSE metadata");
const layoutDocumentIndex = buildDocumentIndex(layoutFixture, ruleSet, layoutBlockIndex, "layoutProbe.scl", "en-US", layoutTypeCache);
const layoutSpan = (line, text) =>
  layoutDocumentIndex.spans.find(
    (span) => span.line === line && layoutFixtureLines[line - 1].substr(span.startCol - 1, span.length) === text
  );
const wirePayloadHover = layoutSpan(1, '"WirePayload"')?.hoverMarkdown ?? "";
expectIndexedBlockShape(
  wirePayloadHover.includes("24 bytes") &&
    wirePayloadHover.includes(
      "### `WirePayload`\n_PLC data type_\n\n**Storage**\n\n- **Layout:** Siemens standard / non-optimized\n- **Size:** `24 bytes`\n- **Padding included:** `4 bytes`"
    ) &&
    wirePayloadHover.includes("\n---\n**Source**  \n`layoutProbe.scl`"),
  "PLC data type declaration hover shows its calculated standard-layout size"
);
const layoutStoreHover = layoutSpan(21, '"LayoutStore"')?.hoverMarkdown ?? "";
expectIndexedBlockShape(
  layoutStoreHover.includes("24 bytes") && layoutStoreHover.includes('### `"LayoutStore"`\n_data block_\n\n**Storage**'),
  "external DATA_BLOCK hover shows its calculated standard/non-optimized size"
);
const bytesMemberHover = layoutSpan(7, "Bytes")?.hoverMarkdown ?? "";
expectIndexedBlockShape(
  ["_UDT member_", "`Array[0..6] of Byte`", "**Size:** `8 bytes`", "**Offset:** byte `4`"].every((part) =>
    bytesMemberHover.includes(part)
  ),
  "UDT ARRAY member declaration hover shows its padded size and standard byte offset"
);
const labelMemberHover = layoutSpan(9, "Label")?.hoverMarkdown ?? "";
expectIndexedBlockShape(
  ["`String[7]`", "**Size:** `10 bytes`", "**Offset:** byte `14`"].every((part) => labelMemberHover.includes(part)),
  "UDT sized-STRING member declaration hover preserves its capacity, size, and aligned offset"
);
const payloadMemberHover = layoutSpan(15, "Payload")?.hoverMarkdown ?? "";
expectIndexedBlockShape(
  ["_data-block member_", '`"WirePayload"`', "**Size:** `24 bytes`", "**Offset:** byte `0`"].every((part) =>
    payloadMemberHover.includes(part)
  ),
  "DATA_BLOCK VAR member declaration hover shows its contained UDT size and block-relative offset"
);

const bitLayoutLines = [
  'TYPE "BitLayout"',
  "VERSION : 0.1",
  "STRUCT",
  "  A      : Bool;",
  "  B      : Bool;",
  "  Code   : Byte;",
  "  Nested : Struct",
  "    Flag      : Bool;",
  "    WordValue : Word;",
  "  END_STRUCT;",
  "END_STRUCT;",
  "END_TYPE",
  "",
];
const bitLayoutFixture = bitLayoutLines.join("\n");
const bitLayoutCache = buildTypeCache(ruleSet, [{ path: "bitLayoutProbe.scl", decls: parseUdtText(bitLayoutFixture) }]);
const bitLayoutIndex = buildDocumentIndex(bitLayoutFixture, ruleSet, new BlockIndex(), "bitLayoutProbe.scl", "en-US", bitLayoutCache);
const bitLayoutSpan = (line, text) =>
  bitLayoutIndex.spans.find(
    (span) => span.line === line && bitLayoutLines[line - 1].substr(span.startCol - 1, span.length) === text
  );
expectIndexedBlockShape(
  bitLayoutSpan(4, "A")?.hoverMarkdown?.includes("**Offset:** `0.0` (byte.bit)") === true &&
    bitLayoutSpan(5, "B")?.hoverMarkdown?.includes("**Offset:** `0.1` (byte.bit)") === true &&
    bitLayoutSpan(6, "Code")?.hoverMarkdown?.includes("**Offset:** byte `1`") === true,
  "consecutive BOOL declarations use packed byte.bit offsets and the following BYTE starts at the next byte"
);
expectIndexedBlockShape(
  bitLayoutSpan(8, "Flag")?.hoverMarkdown?.includes("**Offset:** `0.0` (byte.bit)") === true &&
    bitLayoutSpan(9, "WordValue")?.hoverMarkdown?.includes("**Offset:** byte `2`") === true &&
    bitLayoutSpan(8, "Flag")?.hoverMarkdown?.includes("relative to this STRUCT") === true,
  "nested inline STRUCT member offsets are relative to their containing STRUCT and apply word alignment"
);

// Unknown system-struct sizes must fail closed even when a partial-looking
// member list exists, and the result must retain every nested declaration
// path so UDT and DATA_BLOCK hover can explain all blockers in one pass.
const unknownSystemRuleSet = {
  ...ruleSet,
  systemTypes: {
    ...ruleSet.systemTypes,
    NullSizedSystem: {
      category: "system-struct",
      sizeBytes: null,
      members: [{ name: "VisibleButPossiblyPartial", type: { kind: "named", name: "Byte" } }],
    },
    MissingSizedSystem: {
      category: "system-struct",
      members: [{ name: "VisibleButPossiblyPartial", type: { kind: "named", name: "Byte" } }],
    },
  },
};
const unknownLayoutLines = [
  'TYPE "NestedUnknown"',
  "VERSION : 0.1",
  "STRUCT",
  "  Y : MissingSizedSystem;",
  "  Z : PID_CompactConfig;",
  "END_STRUCT;",
  "END_TYPE",
  'TYPE "BrokenLayout"',
  "VERSION : 0.1",
  "STRUCT",
  "  X      : NullSizedSystem;",
  '  Nested : "NestedUnknown";',
  "  Items  : ARRAY[0..1] OF MissingSizedSystem;",
  "END_STRUCT;",
  "END_TYPE",
  'DATA_BLOCK "BrokenStore"',
  "{ S7_Optimized_Access := 'FALSE' }",
  "VAR",
  '  Data : "BrokenLayout";',
  "END_VAR",
  "BEGIN",
  "END_DATA_BLOCK",
  'FUNCTION "ReadBroken" : Void',
  "BEGIN",
  '  "BrokenStore".Data.X := 0;',
  "END_FUNCTION",
  "",
];
const unknownLayoutFixture = unknownLayoutLines.join("\n");
const unknownLayoutCache = buildTypeCache(unknownSystemRuleSet, [
  { path: "unknownLayoutProbe.scl", decls: parseUdtText(unknownLayoutFixture) },
]);
const brokenLayout = calculateStandardUdtLayout("BrokenLayout", unknownSystemRuleSet, unknownLayoutCache);
const renderUnknownPath = (pathSegments) =>
  pathSegments.reduce((rendered, segment) => (segment === "[]" ? `${rendered}[]` : rendered ? `${rendered}.${segment}` : segment), "");
const brokenPaths = isStandardTypeLayout(brokenLayout) ? [] : brokenLayout.unknownSizes.map((issue) => renderUnknownPath(issue.path));
expectIndexedBlockShape(
  JSON.stringify(brokenPaths) === JSON.stringify(["X", "Nested.Y", "Nested.Z", "Items[]"]),
  "UDT sizing reports every null/missing system-type size with its full nested/ARRAY path"
);
const unknownBlockIndex = new BlockIndex();
unknownBlockIndex.rebuild([{ path: "unknownLayoutProbe.scl", text: unknownLayoutFixture }]);
const unknownDocumentIndex = buildDocumentIndex(
  unknownLayoutFixture,
  unknownSystemRuleSet,
  unknownBlockIndex,
  "unknownLayoutProbe.scl",
  "en-US",
  unknownLayoutCache
);
const unknownSpan = (line, text) =>
  unknownDocumentIndex.spans.find(
    (span) => span.line === line && unknownLayoutLines[line - 1].substr(span.startCol - 1, span.length) === text
  );
const brokenUdtHover = unknownSpan(8, '"BrokenLayout"')?.hoverMarkdown ?? "";
expectIndexedBlockShape(
  [
    "**Storage**\n\n> Size unavailable",
    "`X`",
    "`Nested.Y`",
    "`Nested.Z`",
    "`Items[]`",
    "sizeBytes: null",
    "does not define sizeBytes",
  ].every((part) =>
    brokenUdtHover.includes(part)
  ),
  "UDT hover lists every unknown-size dependency and distinguishes null from missing sizeBytes"
);
const brokenDbHover = unknownSpan(25, '"BrokenStore"')?.hoverMarkdown ?? "";
expectIndexedBlockShape(
  ["`Data.X`", "`Data.Nested.Y`", "`Data.Nested.Z`", "`Data.Items[]`"].every((part) => brokenDbHover.includes(part)),
  "DATA_BLOCK hover prefixes and lists every unknown-size dependency from its contained UDT"
);

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
