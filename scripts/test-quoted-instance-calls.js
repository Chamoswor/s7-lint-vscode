// Quoted local FB and instruction instances must resolve through the local
// declaration, just like #Instance. TIA exports names with spaces/hyphens as
// #"Instance Name"; splitting off the # used to turn them into external calls.
"use strict";
const assert = require("assert").strict;
const path = require("path");
const { loadRuleSet } = require("../out/rules/loadRules");
const { parseS7dclBlock } = require("../out/parser/s7dclParser");
const { checkInstructions } = require("../out/linter/instructionChecks");
const { checkSclInstructions } = require("../out/linter/sclInstructionChecks");
const { checkUndeclaredIdentifiers } = require("../out/linter/symbolChecks");
const { BlockIndex } = require("../out/analysis/blockIndex");
const { buildDocumentIndex } = require("../out/analysis/documentIndex");
const { buildTypeCache } = require("../out/cache/typeCache");

const ruleSet = loadRuleSet(path.join(__dirname, "..", "resources"));
const typeCache = buildTypeCache(ruleSet, []);
const fbText = [
  'FUNCTION_BLOCK "FB_Measurement"',
  'VAR_INPUT',
  '  "Input-value" : Real;',
  '  Enabled : Bool;',
  'END_VAR',
  'VAR_OUTPUT',
  '  Ready : Bool;',
  'END_VAR',
  'BEGIN',
  'END_FUNCTION_BLOCK',
].join("\n");
const blockIndex = new BlockIndex();
blockIndex.rebuild([{ path: "FB_Measurement.scl", text: fbText }]);

function caller(body, graphical, declaration = '"TS-1304_Instance" : _.FB_Measurement;') {
  return [
    'FUNCTION_BLOCK "Caller"',
    "VAR",
    "  " + declaration,
    "END_VAR",
    "VAR_TEMP",
    "  Value : Real;",
    "  Ready : Bool;",
    "END_VAR",
    graphical ? '{ S7_Language := "LAD" }\nNETWORK\n  RUNG' : "BEGIN",
    body,
    graphical ? "  END_RUNG\nEND_NETWORK" : "",
    "END_FUNCTION_BLOCK",
  ].join("\n");
}

for (const graphical of [true, false]) {
  for (const name of ["TS-1304_Instance", "Sensor 1", "IF"]) {
    const callText = '#"' + name + '"("Input-value" := #Value, Enabled := TRUE, Ready => #Ready)' + (graphical ? "" : ";");
    const text = caller("    " + callText, graphical, '"' + name + '" : _.FB_Measurement;');
    const parsed = parseS7dclBlock(text);
    const calls = graphical ? parsed.networks[0].rungs[0].calls : parsed.sclCalls;
    assert.equal(calls.length, 1, "one local instance call is parsed");
    assert.equal(calls[0].instancePrefix, name, "quoted call retains the local instance name");
    assert.equal(calls[0].name, "", "the declaration supplies the callable type");
    assert.equal(calls[0].externalName, undefined, "a quoted local instance is not an external block");
    assert.equal(calls[0].col, 5, "diagnostics begin at the # prefix");
    assert.deepEqual(calls[0].pins.map((pin) => pin.name), ["Input-value", "Enabled", "Ready"]);
    assert.equal(calls[0].pins[0].operandRefs[0].segments[0], "Value");
    const instructionDiagnostics = graphical
      ? checkInstructions(parsed, ruleSet, blockIndex)
      : checkSclInstructions(parsed, ruleSet, blockIndex, typeCache);
    assert.deepEqual(instructionDiagnostics, [], "valid quoted local calls have no instruction errors");
    assert.deepEqual(checkUndeclaredIdentifiers(parsed, blockIndex, typeCache, ruleSet), []);
    const index = buildDocumentIndex(text, ruleSet, blockIndex, graphical ? "caller.s7dcl" : "caller.scl");
    assert.deepEqual(index.diagnostics, [], "quoted local calls retain valid pin/type checks");
    const target = index.spans.find((span) => span.line === calls[0].line && span.startCol === calls[0].col);
    assert.ok(target && target.definition, "quoted call still navigates to its declaration");
    if (graphical) {
      assert.equal(parsed.networks[0].rungs[0].hasCallBox, true);
      assert.equal(parsed.networks[0].rungs[0].enableInput, undefined, "a quoted call after RUNG is not an EN operand");
    }
  }
}

// Accepting the local call must not hide a real invalid pin or operand.
const badText = caller('    #"TS-1304_Instance"(BadPin := TRUE, "Input-value" := #Missing)', true);
const badIndex = buildDocumentIndex(badText, ruleSet, blockIndex, "bad.s7dcl");
assert.ok(badIndex.diagnostics.some((diag) => diag.code === "unknown-pin" && diag.message.includes("BadPin")));
assert.ok(checkUndeclaredIdentifiers(parseS7dclBlock(badText), blockIndex, typeCache, ruleSet).some((diag) => diag.code === "undeclared-identifier"));

// Both spellings of the local CallBox must be represented alike.
const plain = parseS7dclBlock(caller("    #Sensor()", true, "Sensor : _.FB_Measurement;"));
assert.equal(plain.networks[0].rungs[0].calls[0].instancePrefix, "Sensor");
assert.deepEqual(checkInstructions(plain, ruleSet, blockIndex), []);

// Preserve instruction-dot identity and registry validation for quoted locals.
const dotted = parseS7dclBlock(caller('    #"Edge-1".R_TRIG(clk := TRUE, q => #Ready)', true, '"Edge-1" : R_TRIG;'));
const dotCall = dotted.networks[0].rungs[0].calls[0];
assert.equal(dotCall.name, "R_TRIG");
assert.equal(dotCall.instancePrefix, "Edge-1");
assert.equal(dotCall.externalName, undefined);
assert.deepEqual(checkInstructions(dotted, ruleSet, blockIndex), []);

const sclEdge = parseS7dclBlock(caller('    #"Edge-1"(CLK := TRUE, Q => #Ready);', false, '"Edge-1" : R_TRIG;'));
assert.deepEqual(checkSclInstructions(sclEdge, ruleSet, blockIndex, typeCache), []);
const missingScl = parseS7dclBlock(caller('    #"Missing-instance"();', false));
assert.ok(checkSclInstructions(missingScl, ruleSet, blockIndex, typeCache).some((diag) => diag.code === "scl-instance-not-declared"));

// External calls and unknown instructions keep their existing diagnostics.
for (const body of ['    "Missing-instance"()', "    UnknownInstruction()"]) {
  const parsed = parseS7dclBlock(caller(body, true));
  assert.ok(checkInstructions(parsed, ruleSet, blockIndex).some((diag) => diag.code === "unknown-instruction"));
}

// A quoted local CallBox still participates in the Safety EN restriction.
const enabled = parseS7dclBlock('{ S7_Safety := "TRUE" }\n' + caller('    #"TS-1304_Instance"()', true).replace("  RUNG\n", "  RUNG TRUE\n"));
assert.equal(checkInstructions(enabled, ruleSet, blockIndex).filter((diag) => diag.code === "safety-call-enable-input").length, 1);

console.log("Quoted instance call regressions passed.");
