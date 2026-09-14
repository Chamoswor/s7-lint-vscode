// Regression tests for the source lines of workspace declarations. XML
// exports used to report every declaration and member at line 1, so type
// cache diagnostics (an unknown member type, a duplicate PLC data type) and
// Go to Definition landed at the top of the file. Text sources did the same
// for every block after the first one in a multi-block `.scl` file.
"use strict";
const assert = require("assert").strict;
const path = require("path");

const { loadRuleSet } = require("../out/rules/loadRules");
const { parseUdtXml, parseBlockXml } = require("../out/parser/udtXmlParser");
const { parsePlcTagXml } = require("../out/parser/plcTagXmlParser");
const { buildTypeCache } = require("../out/cache/typeCache");
const { BlockIndex, scanBlockFile } = require("../out/analysis/blockIndex");

const ruleSet = loadRuleSet(path.join(__dirname, "..", "resources"));

/** 1-based line of the first occurrence of `needle` in `text`. */
function lineOf(text, needle) {
  const index = text.indexOf(needle);
  assert.ok(index !== -1, `fixture contains ${needle}`);
  return text.slice(0, index).split("\n").length;
}

// --- PLC data type export --------------------------------------------------
const udtXml = `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Types.PlcStruct ID="0">
    <AttributeList>
      <Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">
  <Section Name="None">
    <Member Name="Ready" Datatype="Bool" />
    <Member Name="Nested" Datatype="&quot;UDT_Missing&quot;">
      <Sections>
        <Section Name="None">
          <Member Name="Inner" Datatype="Int" />
        </Section>
      </Sections>
    </Member>
    <Member Name="Count" Datatype="Int">
      <AttributeList>
        <BooleanAttribute Name="ExternalAccessible" SystemDefined="true">true</BooleanAttribute>
      </AttributeList>
    </Member>
  </Section>
</Sections></Interface>
      <Name>UDT_Positions</Name>
    </AttributeList>
  </SW.Types.PlcStruct>
</Document>
`;

const [udt] = parseUdtXml(udtXml);
assert.equal(udt.line, lineOf(udtXml, "<Name>UDT_Positions</Name>"), "a PLC data type is declared on its <Name> line");
assert.deepEqual(
  udt.members.map((m) => [m.name, m.line]),
  [
    ["Ready", lineOf(udtXml, 'Name="Ready"')],
    ["Nested", lineOf(udtXml, 'Name="Nested"')],
    ["Count", lineOf(udtXml, 'Name="Count"')],
  ],
  "each top-level member keeps its own line"
);

const [udtWithBomAndCrlf] = parseUdtXml(String.fromCharCode(0xfeff) + udtXml.replace(/\n/g, "\r\n"));
assert.equal(udtWithBomAndCrlf.line, udt.line, "a byte-order mark and CRLF line endings don't shift the declaration line");
assert.deepEqual(
  udtWithBomAndCrlf.members.map((m) => m.line),
  udt.members.map((m) => m.line),
  "a byte-order mark and CRLF line endings don't shift member lines"
);

const cache = buildTypeCache(ruleSet, [
  { path: "PLC data types/UDT_Positions.xml", decls: parseUdtXml(udtXml) },
  { path: "Copies/UDT_Positions.xml", decls: parseUdtXml(udtXml) },
]);
const unknownType = cache.diagnostics.find((d) => d.code === "unknown-type");
assert.equal(unknownType?.file, "PLC data types/UDT_Positions.xml");
assert.equal(unknownType?.line, lineOf(udtXml, 'Name="Nested"'), "an unknown member type is reported on that member's line");
const duplicates = cache.diagnostics.filter((d) => d.code === "duplicate-declaration");
assert.equal(duplicates.length, 2);
assert.ok(duplicates.every((d) => d.line === udt.line), "a duplicate PLC data type is reported on each copy's <Name> line");

// --- DATA_BLOCK export -----------------------------------------------------
const dbXml = `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Blocks.InstanceDB ID="0">
    <AttributeList>
      <InstanceOfName>FB_Motor</InstanceOfName>
      <InstanceOfType>FB</InstanceOfType>
      <Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">
  <Section Name="Input">
    <Member Name="Start" Datatype="Bool" />
  </Section>
  <Section Name="Static">
    <Member Name="Speed" Datatype="Real" />
  </Section>
</Sections></Interface>
      <Name>Motor_DB</Name>
      <Number>12</Number>
    </AttributeList>
  </SW.Blocks.InstanceDB>
</Document>
`;

const [db] = parseBlockXml(dbXml);
assert.equal(db.line, lineOf(dbXml, "<Name>Motor_DB</Name>"), "an XML DATA_BLOCK is declared on its <Name> line, not <InstanceOfName>");
const xmlIndex = new BlockIndex();
xmlIndex.rebuild([], [{ path: "Motor_DB.xml", text: dbXml }]);
const motorDb = xmlIndex.get("Motor_DB");
assert.equal(motorDb.declLine, db.line);
assert.equal(motorDb.vars.get("Start").member.line, lineOf(dbXml, 'Name="Start"'));
assert.equal(motorDb.vars.get("Speed").member.line, lineOf(dbXml, 'Name="Speed"'));

// --- PLC tag table export --------------------------------------------------
const tagXml = `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Tags.PlcTagTable ID="0">
    <AttributeList><Name>Default tag table</Name></AttributeList>
    <ObjectList>
      <SW.Tags.PlcTag ID="1" CompositionName="Tags">
        <AttributeList>
          <DataTypeName>Bool</DataTypeName>
          <LogicalAddress>%I0.0</LogicalAddress>
          <Name>DI_Start</Name>
        </AttributeList>
      </SW.Tags.PlcTag>
      <SW.Tags.PlcTag ID="2" CompositionName="Tags">
        <AttributeList>
          <DataTypeName>Int</DataTypeName>
          <LogicalAddress>%MW10</LogicalAddress>
          <Name>MW_Count</Name>
        </AttributeList>
      </SW.Tags.PlcTag>
    </ObjectList>
  </SW.Tags.PlcTagTable>
</Document>
`;

assert.deepEqual(
  parsePlcTagXml(tagXml).map((t) => [t.name, t.line]),
  [
    ["DI_Start", lineOf(tagXml, "<Name>DI_Start</Name>")],
    ["MW_Count", lineOf(tagXml, "<Name>MW_Count</Name>")],
  ],
  "each PLC tag is declared on its own <Name> line"
);

// Each XML parser ignores the other formats without failing.
assert.deepEqual(parseUdtXml(dbXml), []);
assert.deepEqual(parseBlockXml(tagXml), []);
assert.deepEqual(parsePlcTagXml(udtXml), []);

// --- multi-block text source -----------------------------------------------
const scl = [
  'FUNCTION_BLOCK "First"',
  "VAR",
  "  a : Int;",
  "END_VAR",
  "BEGIN",
  "END_FUNCTION_BLOCK",
  "",
  'FUNCTION "Second" : Int',
  "BEGIN",
  "  #Second := 1;",
  "END_FUNCTION",
  "",
].join("\n");
assert.deepEqual(
  scanBlockFile("two.scl", scl).map((b) => [b.name, b.declLine]),
  [
    ["First", 1],
    ["Second", 8],
  ],
  "every block in a multi-block source is declared on its own header line"
);

console.log("Source-position regressions passed for XML exports and multi-block sources.");
