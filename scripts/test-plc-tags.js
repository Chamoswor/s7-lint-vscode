// Regression test for TIA `SW.Tags.PlcTagTable` XML indexing. A quoted PLC
// tag in LAD/FBD is an operand whose declared type comes from the tag table;
// without that index it is misread as a WSTRING literal and Bool pins report
// false `literal-type-mismatch` diagnostics.
"use strict";
const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");

const { loadRuleSet } = require("../out/rules/loadRules");
const { BlockIndex } = require("../out/analysis/blockIndex");
const { buildDocumentIndex } = require("../out/analysis/documentIndex");
const { parsePlcTagXml } = require("../out/parser/plcTagXmlParser");
const { parseUdtXml } = require("../out/parser/udtXmlParser");
const { parseUdtText } = require("../out/parser/udtTextParser");
const { parseS7dclBlock, parseS7dclFile } = require("../out/parser/s7dclParser");
const { buildTypeCache } = require("../out/cache/typeCache");
const { checkInstructions } = require("../out/linter/instructionChecks");
const { checkLadWiring } = require("../out/linter/ladWiringChecks");
const { checkUndeclaredIdentifiers, checkIllegalDotAccess } = require("../out/linter/symbolChecks");
const { checkSclConditionTypes } = require("../out/linter/symbolChecks");
const { checkSclInstructions } = require("../out/linter/sclInstructionChecks");
const { checkSclExpressionTypes } = require("../out/linter/exprTypeChecks");
const { checkStructCountPerDataBlock } = require("../out/linter/compositionChecks");

const ruleSet = loadRuleSet(path.join(__dirname, "..", "resources"));

const xml = `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Tags.PlcTagTable ID="0">
    <AttributeList><Name>Safety tags</Name></AttributeList>
    <ObjectList>
      <SW.Tags.PlcTag ID="1" CompositionName="Tags">
        <AttributeList><DataTypeName>Bool</DataTypeName><LogicalAddress>%I8.1</LogicalAddress><Name>FDI_NS2_E_Stop_NC_FB</Name></AttributeList>
        <ObjectList><MultilingualText CompositionName="Comment"><ObjectList>
          <MultilingualTextItem CompositionName="Items"><AttributeList><Culture>en-US</Culture><Text>Emergency stop, NC</Text></AttributeList></MultilingualTextItem>
          <MultilingualTextItem CompositionName="Items"><AttributeList><Culture>nb-NO</Culture><Text>Nødstopp, NC</Text></AttributeList></MultilingualTextItem>
        </ObjectList></MultilingualText></ObjectList>
      </SW.Tags.PlcTag>
      <SW.Tags.PlcTag ID="2" CompositionName="Tags">
        <AttributeList><DataTypeName>Bool</DataTypeName><LogicalAddress>%I8.2</LogicalAddress><Name>DI_ResetAlarm_CMD</Name></AttributeList>
      </SW.Tags.PlcTag>
      <SW.Tags.PlcTag ID="3" CompositionName="Tags">
        <AttributeList><DataTypeName>Bool</DataTypeName><LogicalAddress>%Q8.0</LogicalAddress><Name>FDO_Safety_OK_ST</Name></AttributeList>
      </SW.Tags.PlcTag>
      <SW.Tags.PlcTag ID="4" CompositionName="Tags">
        <AttributeList><DataTypeName>Int</DataTypeName><LogicalAddress>%MW20</LogicalAddress><Name>AI_Safety_Count</Name></AttributeList>
      </SW.Tags.PlcTag>
    </ObjectList>
  </SW.Tags.PlcTagTable>
</Document>`;

const source = `FUNCTION_BLOCK "SafetyConsumer"
  VAR_TEMP
    temp : Bool;
  END_VAR
  NETWORK
    RUNG "FDI_NS2_E_Stop_NC_FB"
      A(in2 := "DI_ResetAlarm_CMD")
      Coil("FDO_Safety_OK_ST")
    END_RUNG
  END_NETWORK
END_FUNCTION_BLOCK
`;

const parsed = parsePlcTagXml(xml);
assert.equal(parsed.length, 4);
assert.equal(parsed[0].name, "FDI_NS2_E_Stop_NC_FB");
assert.equal(parsed[0].dataTypeName, "Bool");
assert.equal(parsed[0].logicalAddress, "%I8.1");
assert.equal(parsed[0].comments.get("nb-NO"), "Nødstopp, NC");

const emptyIndex = new BlockIndex();
emptyIndex.rebuild([]);
const before = buildDocumentIndex(source, ruleSet, emptyIndex, "SafetyConsumer.s7dcl", "nb-NO");
assert.ok(before.diagnostics.some((diagnostic) => diagnostic.code === "literal-type-mismatch"));

const blockIndex = new BlockIndex();
blockIndex.rebuild([], [{ path: "PLC tags/F-DI.xml", text: xml }]);
assert.equal(blockIndex.globalTagSize, 4);
assert.equal(blockIndex.getGlobalTag("di_resetalarm_cmd").name, "DI_ResetAlarm_CMD");

const after = buildDocumentIndex(source, ruleSet, blockIndex, "SafetyConsumer.s7dcl", "nb-NO");
assert.equal(after.diagnostics.filter((diagnostic) => diagnostic.code === "literal-type-mismatch").length, 0);
for (const name of ["FDI_NS2_E_Stop_NC_FB", "DI_ResetAlarm_CMD", "FDO_Safety_OK_ST"]) {
  const span = after.spans.find((candidate) => {
    const line = source.split("\n")[candidate.line - 1] ?? "";
    return line.substr(candidate.startCol - 1, candidate.length) === `"${name}"`;
  });
  assert.ok(span, `${name} should have a semantic span`);
  assert.equal(span.tokenType, "variable");
  assert.equal(span.definition.file, "PLC tags/F-DI.xml");
}
const inputSpan = after.spans.find((span) => span.hoverMarkdown?.includes("FDI_NS2_E_Stop_NC_FB"));
assert.ok(inputSpan.hoverMarkdown.includes("`%I8.1`"));
assert.ok(inputSpan.hoverMarkdown.includes("Nødstopp, NC"));

// The same quoted PLC-tag spelling is legal in authored SCL. It remains
// syntactically ambiguous with a WSTRING literal until BlockIndex resolves
// the name, so cover assignments, expressions and a simple IF condition --
// plus a real unmatched WSTRING that must NOT become an unknown symbol.
const sclSource = `FUNCTION_BLOCK "SclTagConsumer"
  VAR_TEMP
    result : Bool;
    count : Int;
  END_VAR
BEGIN
  #result := "FDI_NS2_E_Stop_NC_FB" AND "DI_ResetAlarm_CMD";
  IF "FDI_NS2_E_Stop_NC_FB" THEN
    #result := "DI_ResetAlarm_CMD";
  END_IF;
  #count := "AI_Safety_Count" + 1;
  #result := "ordinary WSTRING text";
END_FUNCTION_BLOCK
`;
const sclBlock = parseS7dclFile(sclSource)[0];
const emptyTypeCache = buildTypeCache(ruleSet, []);
const sclDiagnostics = [
  ...checkSclInstructions(sclBlock, ruleSet, blockIndex, emptyTypeCache),
  ...checkUndeclaredIdentifiers(sclBlock, blockIndex, emptyTypeCache, ruleSet),
  ...checkIllegalDotAccess(sclBlock, blockIndex, emptyTypeCache, ruleSet),
  ...checkSclConditionTypes(sclBlock, blockIndex, emptyTypeCache, ruleSet),
  ...checkSclExpressionTypes(sclBlock, ruleSet, blockIndex, emptyTypeCache),
  ...buildDocumentIndex(sclSource, ruleSet, blockIndex, "SclTagConsumer.scl", "nb-NO", emptyTypeCache).diagnostics,
];
assert.deepEqual(sclDiagnostics, []);
assert.ok(sclBlock.sclOperandRefs.some((ref) => ref.external && ref.segments[0] === "FDI_NS2_E_Stop_NC_FB"));
assert.ok(sclBlock.sclConditionChecks.some((check) => check.kind === "tag" && check.ref.external));
assert.ok(sclBlock.sclAssignments.some((assignment) => assignment.expr.kind === "binary" && assignment.expr.left.kind === "operand" && assignment.expr.left.ref.external));

const sclIndex = buildDocumentIndex(sclSource, ruleSet, blockIndex, "SclTagConsumer.scl", "nb-NO", emptyTypeCache);
const sclTagSpan = sclIndex.spans.find((span) => span.hoverMarkdown?.includes("AI_Safety_Count"));
assert.equal(sclTagSpan.tokenType, "variable");
assert.equal(sclTagSpan.definition.file, "PLC tags/F-DI.xml");
const wstringSpan = sclIndex.spans.find((span) => {
  const line = sclSource.split("\n")[span.line - 1] ?? "";
  return line.substr(span.startCol - 1, span.length) === '"ordinary WSTRING text"';
});
assert.equal(wstringSpan.tokenType, "string");

// Prove the resolved XML datatype participates in SCL validation rather
// than merely suppressing errors: Int is rejected as an IF condition, and
// Bool + Int is rejected as an arithmetic expression.
const invalidSclSource = `FUNCTION_BLOCK "InvalidSclTagConsumer"
  VAR_TEMP
    result : Bool;
  END_VAR
BEGIN
  #result := "FDI_NS2_E_Stop_NC_FB" + 1;
  IF "AI_Safety_Count" THEN
    #result := TRUE;
  END_IF;
END_FUNCTION_BLOCK
`;
const invalidSclBlock = parseS7dclFile(invalidSclSource)[0];
const invalidSclDiagnostics = [
  ...checkSclConditionTypes(invalidSclBlock, blockIndex, emptyTypeCache, ruleSet),
  ...checkSclExpressionTypes(invalidSclBlock, ruleSet, blockIndex, emptyTypeCache),
];
assert.ok(invalidSclDiagnostics.some((diagnostic) => diagnostic.code === "condition-not-bool"));
assert.ok(invalidSclDiagnostics.some((diagnostic) => diagnostic.code === "expr-arithmetic-domain-mismatch"));

console.log("PLC tag XML parser/index regressions passed for .s7dcl and .scl.");

// Optional real-project probe:
//   node scripts/test-plc-tags.js <source.s7dcl> <PLC-tags-directory>
if (process.argv[2] && process.argv[3]) {
  const sourcePath = path.resolve(process.argv[2]);
  const tagDirectory = path.resolve(process.argv[3]);
  const projectRoot = path.dirname(tagDirectory);
  const allPaths = [];
  const collectPaths = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) collectPaths(entryPath);
      else allPaths.push(entryPath);
    }
  };
  collectPaths(projectRoot);
  const readSources = (extensions) =>
    allPaths
      .filter((filePath) => extensions.has(path.extname(filePath).toLowerCase()))
      .map((filePath) => ({ path: filePath, text: fs.readFileSync(filePath, "utf-8") }));
  const xmlFiles = readSources(new Set([".xml"]));
  const blockFiles = readSources(new Set([".s7dcl", ".scl", ".db"]));
  const realIndex = new BlockIndex();
  realIndex.rebuild(blockFiles, xmlFiles);
  const udtFiles = [];
  for (const file of blockFiles) {
    const decls = parseUdtText(file.text);
    if (decls.length > 0) udtFiles.push({ path: file.path, decls });
  }
  for (const file of xmlFiles) {
    const decls = parseUdtXml(file.text);
    if (decls.length > 0) udtFiles.push({ path: file.path, decls });
  }
  const typeCache = buildTypeCache(ruleSet, udtFiles);
  const realSource = fs.readFileSync(sourcePath, "utf-8");
  const diagnostics = [...buildDocumentIndex(realSource, ruleSet, realIndex, sourcePath, "nb-NO", typeCache).diagnostics];
  if (path.extname(sourcePath).toLowerCase() === ".scl") {
    for (const block of parseS7dclFile(realSource)) {
      diagnostics.push(
        ...checkSclInstructions(block, ruleSet, realIndex, typeCache),
        ...checkUndeclaredIdentifiers(block, realIndex, typeCache, ruleSet),
        ...checkIllegalDotAccess(block, realIndex, typeCache, ruleSet),
        ...checkSclConditionTypes(block, realIndex, typeCache, ruleSet),
        ...checkSclExpressionTypes(block, ruleSet, realIndex, typeCache)
      );
    }
  } else {
    const block = parseS7dclBlock(realSource);
    if (block) {
      diagnostics.push(
        ...checkInstructions(block, ruleSet, realIndex),
        ...checkLadWiring(block, ruleSet),
        ...checkUndeclaredIdentifiers(block, realIndex, typeCache, ruleSet),
        ...checkIllegalDotAccess(block, realIndex, typeCache, ruleSet),
        ...checkStructCountPerDataBlock(block, ruleSet)
      );
    }
  }
  console.log(
    `Real-project probe: ${realIndex.globalTagSize} PLC tags, ${realIndex.size} blocks and ${typeCache.types.size} PLC data types indexed; ${diagnostics.length} diagnostic(s).`
  );
  for (const diagnostic of diagnostics) console.log(`${diagnostic.line}:${diagnostic.col} ${diagnostic.code}: ${diagnostic.message}`);
}
