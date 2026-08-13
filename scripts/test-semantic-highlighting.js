// Focused semantic-highlighting regression test for a representative authored
// SCL library. The fixture is intentionally supplied as an argument because
// IPC_Lib.scl is a local integration corpus rather than a redistributable
// package fixture.
"use strict";

const fs = require("fs");
const path = require("path");

const { BlockIndex } = require("../out/analysis/blockIndex");
const { buildDocumentIndex } = require("../out/analysis/documentIndex");
const { buildTypeCache } = require("../out/cache/typeCache");
const { parseUdtText } = require("../out/parser/udtTextParser");
const { loadRuleSet } = require("../out/rules/loadRules");

const repoRoot = path.resolve(__dirname, "..");
const fixturePath = path.resolve(repoRoot, process.argv[2] || "temp/IPC_Lib.scl");
if (!fs.existsSync(fixturePath)) {
  console.error(`Highlight fixture not found: ${fixturePath}`);
  process.exit(1);
}

const text = fs.readFileSync(fixturePath, "utf8");
const lines = text.split(/\r?\n/);
const ruleSet = loadRuleSet(path.join(repoRoot, "resources"));
const blockIndex = new BlockIndex();
blockIndex.rebuild([{ path: fixturePath, text }]);
const typeCache = buildTypeCache(ruleSet, [{ path: fixturePath, decls: parseUdtText(text) }]);
const index = buildDocumentIndex(text, ruleSet, blockIndex, fixturePath, "en-US", typeCache);

let failures = 0;

function lineContaining(fragment, occurrence = 1) {
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(fragment) && ++seen === occurrence) return i + 1;
  }
  throw new Error(`Could not find line containing ${JSON.stringify(fragment)} (occurrence ${occurrence})`);
}

function assertToken(lineFragment, lexeme, expectedType, expectedModifiers = [], occurrence = 1) {
  const line = lineContaining(lineFragment, occurrence);
  const span = index.spans.find(
    (candidate) =>
      candidate.line === line &&
      lines[line - 1].slice(candidate.startCol - 1, candidate.startCol - 1 + candidate.length) === lexeme
  );
  const modifiersMatch = expectedModifiers.every((modifier) => span?.tokenModifiers.includes(modifier));
  if (span?.tokenType === expectedType && modifiersMatch) {
    console.log(`PASS L${line} ${lexeme} -> ${expectedType}${expectedModifiers.length ? `.${expectedModifiers.join(".")}` : ""}`);
    return;
  }
  failures++;
  console.error(
    `FAIL L${line} ${lexeme}: got ${span ? `${span.tokenType}.${span.tokenModifiers.join(".")}` : "no span"}, expected ${expectedType}${expectedModifiers.length ? `.${expectedModifiers.join(".")}` : ""}`
  );
}

const CAPABILITY_MODIFIERS = ["s7Container", "s7Indexable"];
function assertCapabilities(lineFragment, lexeme, expectedCapabilities, occurrence = 1) {
  const line = lineContaining(lineFragment, occurrence);
  const span = index.spans.find(
    (candidate) =>
      candidate.line === line &&
      lines[line - 1].slice(candidate.startCol - 1, candidate.startCol - 1 + candidate.length) === lexeme
  );
  const actual = CAPABILITY_MODIFIERS.filter((modifier) => span?.tokenModifiers.includes(modifier));
  if (JSON.stringify(actual) === JSON.stringify(expectedCapabilities)) {
    console.log(`PASS L${line} ${lexeme} capabilities -> ${actual.join("+") || "leaf"}`);
    return;
  }
  failures++;
  console.error(`FAIL L${line} ${lexeme} capabilities: got ${actual.join("+") || "leaf"}, expected ${expectedCapabilities.join("+") || "leaf"}`);
}

function assertHover(lineFragment, lexeme, expectedType, expectedContext, occurrence = 1) {
  const line = lineContaining(lineFragment, occurrence);
  const span = index.spans.find(
    (candidate) =>
      candidate.line === line &&
      lines[line - 1].slice(candidate.startCol - 1, candidate.startCol - 1 + candidate.length) === lexeme
  );
  const hoverMarkdown = span?.hoverMarkdown ?? "";
  const expectedTypeMarkdown = `\`${expectedType}\``.toLowerCase();
  if (hoverMarkdown.toLowerCase().includes(expectedTypeMarkdown) && hoverMarkdown.includes(expectedContext)) {
    console.log(`PASS L${line} ${lexeme} hover -> ${expectedType}`);
    return;
  }
  failures++;
  console.error(`FAIL L${line} ${lexeme} hover: got ${span?.hoverMarkdown ?? "no hover"}, expected member type ${expectedType}`);
}

// TYPE/STRUCT reads like a user object declaration.
assertToken('TYPE "KDT_IPC_Header"', '"KDT_IPC_Header"', "s7UdtType", ["declaration"]);
assertToken("   STRUCT", "STRUCT", "struct", ["defaultLibrary"]);
assertToken('      "Version"       : BYTE;', '"Version"', "property", ["declaration"]);
assertToken('      "Version"       : BYTE;', "BYTE", "s7IntegerType", ["defaultLibrary"]);
assertToken("   END_STRUCT;", "END_STRUCT", "struct", ["defaultLibrary"]);

// A DB is object-like storage: its members are properties and their KDTs are
// project-defined object types.
assertToken('DATA_BLOCK "DB_IPC_Interface"', '"DB_IPC_Interface"', "s7DataBlock", ["declaration"]);
assertToken('    Header  : "KDT_IPC_Header";', "Header", "property", ["declaration"]);
assertToken('    Header  : "KDT_IPC_Header";', '"KDT_IPC_Header"', "s7UdtType");

// Block interfaces behave like parameters; block/instruction instances stay
// variables at declaration/reference sites, their FB/timer types are classes,
// and only a direct invocation occurrence is a function.
assertToken("    Active    : BOOL;", "Active", "parameter", ["declaration"]);
assertToken("    Active    : BOOL;", "BOOL", "s7BooleanType", ["defaultLibrary"]);
assertToken('FUNCTION_BLOCK "IPC_Manager"', '"IPC_Manager"', "s7CallableType", ["declaration"]);
assertToken("    HB_Timer    : TON;", "HB_Timer", "s7CallableInstance", ["declaration"]);
assertToken("    HB_Timer    : TON;", "TON", "s7CallableType", ["defaultLibrary"]);
assertToken('    Heartbeat    : "_IPC_Heartbeat";', "Heartbeat", "s7CallableInstance", ["declaration"]);
assertToken('    Heartbeat    : "_IPC_Heartbeat";', '"_IPC_Heartbeat"', "s7CallableType");
assertToken("    Heartbeat(Enable := TRUE, GW_TimeoutMs := GW_TimeoutMs);", "Heartbeat", "function");
assertToken("    GW_Alive   := Heartbeat.GW_Alive;", "Heartbeat", "s7CallableInstance");

// ARRAY is a list constructor around a separately classified element type.
assertToken("      SensorType : ARRAY[0..15] OF CHAR;", "ARRAY", "s7GenericType", ["defaultLibrary"]);
assertToken("      SensorType : ARRAY[0..15] OF CHAR;", "OF", "s7GenericType", ["defaultLibrary"]);
assertToken("      SensorType : ARRAY[0..15] OF CHAR;", "CHAR", "s7TextType", ["defaultLibrary"]);
assertToken('    SensorSlots   : ARRAY[0..5] OF "KDT_IPC_SensorSlot";', "ARRAY", "s7GenericType", ["defaultLibrary"]);
assertToken('    SensorSlots   : ARRAY[0..5] OF "KDT_IPC_SensorSlot";', '"KDT_IPC_SensorSlot"', "s7UdtType");
assertToken('    "DB_IPC_Comms".NotifRequest.Severity := Severity;', '"DB_IPC_Comms"', "s7DataBlock");
assertToken('FUNCTION "IPC_TriggerNotification" : VOID', '"IPC_TriggerNotification"', "function", ["declaration"]);
assertToken('FUNCTION "IPC_TriggerNotification" : VOID', "VOID", "s7GenericType", ["defaultLibrary"]);
assertToken("      Value      : REAL;", "REAL", "s7FloatType", ["defaultLibrary"]);
assertToken("      TimeOfDay : TIME_OF_DAY;", "TIME_OF_DAY", "s7TemporalType", ["defaultLibrary"]);

// Capability modifiers preserve the symbol's root/property/parameter role
// while distinguishing scalar leaves, structured containers, indexable
// values, and ARRAY OF UDT values that have both capabilities.
assertCapabilities('    SensorSlots   : ARRAY[0..5] OF "KDT_IPC_SensorSlot";', "SensorSlots", ["s7Container", "s7Indexable"]);
assertCapabilities('    NotifRequest  : "KDT_IPC_NotifRequest";', "NotifRequest", ["s7Container"]);
assertCapabilities("      Message   : ARRAY[0..79] OF CHAR;", "Message", ["s7Indexable"]);
assertCapabilities('    "DB_IPC_Comms".NotifRequest.Severity := Severity;', '"DB_IPC_Comms"', ["s7Container"]);
assertCapabilities('    "DB_IPC_Comms".NotifRequest.Severity := Severity;', "NotifRequest", ["s7Container"]);
assertCapabilities('    "DB_IPC_Comms".NotifRequest.Severity := Severity;', "Severity", []);
assertCapabilities('            "DB_IPC_Comms".NotifRequest.Message[i] := Message[i + 1];', "Message", ["s7Indexable"]);
assertCapabilities('            IF "DB_IPC_Comms".SensorSlots[i].Status <> 16#00 THEN', "SensorSlots", ["s7Container", "s7Indexable"]);
assertCapabilities('            IF "DB_IPC_Comms".SensorSlots[i].Status <> 16#00 THEN', "Status", []);
assertCapabilities("    ProfileId : STRING;", "ProfileId", ["s7Indexable"]);
assertCapabilities('    Heartbeat    : "_IPC_Heartbeat";', "Heartbeat", ["s7Container"]);
assertCapabilities('"DB_IPC_Comms".ConfigRequest.SeqNum     := "DB_IPC_Comms".ConfigRequest.SeqNum + 1;', "SeqNum", []);
assertCapabilities('"DB_IPC_Comms".ConfigRequest.Flags.%X0 := TRUE;', "Flags", []);
assertToken('"DB_IPC_Comms".ConfigRequest.Flags.%X0 := TRUE;', "%X0", "number");

// Workspace type-cache traversal must also supply navigation metadata for
// members below a DATA_BLOCK's UDT-valued property. These are the exact
// accesses that previously coloured correctly but produced no hover.
assertHover('"DB_IPC_Comms".ConfigRequest.DeviceId[i] := DeviceId[i + 1];', "DeviceId", "ARRAY[0..31] OF CHAR", "PLC data type member");
assertHover('"DB_IPC_Comms".ConfigRequest.SeqNum     := "DB_IPC_Comms".ConfigRequest.SeqNum + 1;', "SeqNum", "BYTE", "PLC data type member");
assertHover('"DB_IPC_Comms".ConfigRequest.Flags.%X0 := TRUE;', "Flags", "BYTE", "PLC data type member");
assertHover('"DB_IPC_Comms".ConfigRequest.Flags.%X0 := TRUE;', "%X0", "BOOL", "bit/byte/word slice");

// The two DATA_BLOCK declaration forms from cross-reference-syntax.scl used
// to fall through the semantic walker: an instance DB's second quoted type
// stayed a string, while a global DB's anonymous outer STRUCT (and every
// member inside it) received no semantic spans at all.
const crossFixturePath = path.join(repoRoot, "scripts", "fixtures", "smoke", "cross-reference-syntax.scl");
const crossText = fs.readFileSync(crossFixturePath, "utf8");
const crossLines = crossText.split(/\r?\n/);
const crossBlockIndex = new BlockIndex();
crossBlockIndex.rebuild([{ path: crossFixturePath, text: crossText }]);
const crossTypeCache = buildTypeCache(ruleSet, [{ path: crossFixturePath, decls: parseUdtText(crossText) }]);
const crossIndex = buildDocumentIndex(crossText, ruleSet, crossBlockIndex, crossFixturePath, "en-US", crossTypeCache);

function assertCrossToken(lineFragment, lexeme, expectedType, expectedModifiers = [], occurrence = 1) {
  let line = 0;
  let seen = 0;
  for (let i = 0; i < crossLines.length; i++) {
    if (crossLines[i].includes(lineFragment) && ++seen === occurrence) {
      line = i + 1;
      break;
    }
  }
  const span = crossIndex.spans.find(
    (candidate) => candidate.line === line && crossLines[line - 1]?.slice(candidate.startCol - 1, candidate.startCol - 1 + candidate.length) === lexeme
  );
  const modifiersMatch = expectedModifiers.every((modifier) => span?.tokenModifiers.includes(modifier));
  if (span?.tokenType === expectedType && modifiersMatch) {
    console.log(`PASS cross L${line} ${lexeme} -> ${expectedType}${expectedModifiers.length ? `.${expectedModifiers.join(".")}` : ""}`);
    return;
  }
  failures++;
  console.error(
    `FAIL cross L${line} ${lexeme}: got ${span ? `${span.tokenType}.${span.tokenModifiers.join(".")}` : "no span"}, expected ${expectedType}${expectedModifiers.length ? `.${expectedModifiers.join(".")}` : ""}`
  );
}

assertCrossToken('DATA_BLOCK "Fb_Unit_DB" "Fb_Unit"', '"Fb_Unit_DB"', "s7CallableInstance", ["declaration"]);
assertCrossToken('DATA_BLOCK "Fb_Unit_DB" "Fb_Unit"', '"Fb_Unit"', "s7CallableType");
assertCrossToken('DATA_BLOCK "Store"', '"Store"', "s7DataBlock", ["declaration"]);
assertCrossToken("   STRUCT", "STRUCT", "struct", ["defaultLibrary"]);
assertCrossToken('      Units : Array[1..4] of "SlotRecord";', "Units", "property", ["declaration"]);
assertCrossToken('      Units : Array[1..4] of "SlotRecord";', "Array", "s7GenericType", ["defaultLibrary"]);
assertCrossToken('      Units : Array[1..4] of "SlotRecord";', '"SlotRecord"', "s7UdtType");
assertCrossToken("      Rec : Struct", "Rec", "property", ["declaration"]);
assertCrossToken("      Rec : Struct", "Struct", "struct", ["defaultLibrary"]);
assertCrossToken('         "3_Slave" : Int;', '"3_Slave"', "property", ["declaration"]);
assertCrossToken('         "3_Slave" : Int;', "Int", "s7IntegerType", ["defaultLibrary"]);

// Every spelling in the requested datatype families is guarded here, not
// only the representative names that happen to occur in IPC_Lib.scl.
const familyGroups = {
  s7TemporalType: ["S5Time", "Time", "LTime", "Date", "Time_Of_Day", "LTime_Of_Day", "LDT", "Date_And_Time", "DTL"],
  s7IntegerType: ["USInt", "UInt", "UDInt", "ULInt", "SInt", "Int", "DInt", "LInt", "Byte", "Word", "DWord", "LWord"],
  s7BooleanType: ["Bool"],
  s7FloatType: ["Real", "LReal"],
  s7GenericType: ["Void", "Variant", "Any", "Pointer"],
  s7TextType: ["String", "WString", "Char", "WChar"],
};
const familyDecls = Object.entries(familyGroups).flatMap(([expectedType, names]) =>
  names.map((name, i) => ({ lineText: `    ${expectedType}_${i} : ${name};`, lexeme: name, expectedType }))
);
const familySourceLines = [
  'FUNCTION_BLOCK "SemanticTypeFamilies"',
  "VAR",
  ...familyDecls.map((entry) => entry.lineText),
  "    referenceValue : REF_TO Int;",
  "    arrayValue : ARRAY[0..1] OF Int;",
  "END_VAR",
  "BEGIN",
  "END_FUNCTION_BLOCK",
];
const familySource = familySourceLines.join("\n");
const familyBlockIndex = new BlockIndex();
familyBlockIndex.rebuild([{ path: "semantic-type-families.scl", text: familySource }]);
const familyIndex = buildDocumentIndex(familySource, ruleSet, familyBlockIndex, "semantic-type-families.scl");

function assertFamilySpan(lineText, lexeme, expectedType) {
  const line = familySourceLines.indexOf(lineText) + 1;
  const span = familyIndex.spans.find(
    (candidate) => candidate.line === line && familySourceLines[line - 1].slice(candidate.startCol - 1, candidate.startCol - 1 + candidate.length) === lexeme
  );
  if (span?.tokenType === expectedType && span.tokenModifiers.includes("defaultLibrary")) return;
  failures++;
  console.error(`FAIL datatype family ${lexeme}: got ${span ? span.tokenType : "no span"}, expected ${expectedType}.defaultLibrary`);
}

for (const entry of familyDecls) assertFamilySpan(entry.lineText, entry.lexeme, entry.expectedType);
assertFamilySpan("    referenceValue : REF_TO Int;", "REF_TO", "s7GenericType");
assertFamilySpan("    arrayValue : ARRAY[0..1] OF Int;", "ARRAY", "s7GenericType");
assertFamilySpan("    arrayValue : ARRAY[0..1] OF Int;", "OF", "s7GenericType");

// Guard the theme-independent contract. Every custom literal/S7 role must
// inherit a native semantic family and provide TextMate fallbacks, while the
// extension itself must not contribute a colour theme.
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const standardTypes = new Set([
  "namespace", "type", "class", "struct", "function", "variable", "parameter",
  "property", "label", "keyword", "number", "operator", "string", "enumMember",
]);
const customTypes = new Map((manifest.contributes.semanticTokenTypes || []).map((entry) => [entry.id, entry]));
const customModifiers = new Set((manifest.contributes.semanticTokenModifiers || []).map((entry) => entry.id));
const expectedSupertypes = {
  charLiteral: "string",
  timeLiteral: "number",
  dateLiteral: "number",
  pointerLiteral: "number",
  booleanLiteral: "enumMember",
  s7TemporalType: "type",
  s7IntegerType: "type",
  s7BooleanType: "type",
  s7FloatType: "type",
  s7GenericType: "type",
  s7TextType: "type",
  s7UdtType: "struct",
  s7CallableType: "class",
  s7CallableInstance: "variable",
  s7DataBlock: "variable",
  s7PlcTag: "variable",
  s7InterfaceMember: "parameter",
};
for (const [id, expectedSuperType] of Object.entries(expectedSupertypes)) {
  const entry = customTypes.get(id);
  if (!entry || entry.superType !== expectedSuperType || !standardTypes.has(entry.superType)) {
    failures++;
    console.error(`FAIL manifest: ${id} does not inherit ${expectedSuperType}`);
  }
}
for (const modifier of CAPABILITY_MODIFIERS) {
  if (!customModifiers.has(modifier)) {
    failures++;
    console.error(`FAIL manifest: ${modifier} semantic modifier is not contributed`);
  }
}
for (const language of ["s7scl", "s7dcl", "s7udt"]) {
  const scopeMap = (manifest.contributes.semanticTokenScopes || []).find((entry) => entry.language === language)?.scopes;
  for (const id of [
    "s7TemporalType", "s7IntegerType", "s7BooleanType", "s7FloatType", "s7GenericType", "s7TextType",
    "s7UdtType", "s7CallableType", "s7CallableInstance", "s7DataBlock", "s7PlcTag", "s7InterfaceMember",
  ]) {
    if (!scopeMap?.[id]?.length) {
      failures++;
      console.error(`FAIL manifest: ${id} has no TextMate fallback for ${language}`);
    }
  }
}
if (manifest.contributes.themes) {
  failures++;
  console.error("FAIL manifest: highlighting must not require a bundled colour theme");
} else {
  console.log("PASS manifest: normal VS Code themes own all highlighting colours");
}

if (failures > 0) {
  console.error(`Semantic highlighting test failed with ${failures} failure(s).`);
  process.exit(1);
}
console.log(`Semantic highlighting test passed against ${path.relative(repoRoot, fixturePath)} (${index.spans.length} spans).`);
