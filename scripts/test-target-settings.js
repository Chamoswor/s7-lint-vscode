// Regression tests for the settings that state what exported sources don't
// record about the target: tiaLint.targetPlatform (data-type availability per
// CPU family) and tiaLint.iecCheck (the blocks' IEC check property). Both are
// off by default, and then neither check reports anything.
"use strict";
const assert = require("assert").strict;
const path = require("path");

const { loadRuleSet } = require("../out/rules/loadRules");
const { isTargetPlatform, platformSupport } = require("../out/rules/platformAvailability");
const { parseS7dclFile } = require("../out/parser/s7dclParser");
const { BlockIndex } = require("../out/analysis/blockIndex");
const { buildDocumentIndex } = require("../out/analysis/documentIndex");
const { buildTypeCache } = require("../out/cache/typeCache");
const { checkSclExpressionTypes } = require("../out/linter/exprTypeChecks");

const ruleSet = loadRuleSet(path.join(__dirname, "..", "resources"));

// --- registry lookup -----------------------------------------------------------
assert.ok(isTargetPlatform("S7-1200 G2"));
assert.ok(!isTargetPlatform("S7-1200G2"));
assert.ok(!isTargetPlatform(""));
assert.equal(platformSupport(ruleSet, "LReal", "S7-300/400"), false);
assert.equal(platformSupport(ruleSet, "LReal", "S7-1200"), true);
assert.equal(platformSupport(ruleSet, "lint", "S7-1200"), false, "type names match regardless of case");
assert.equal(platformSupport(ruleSet, "TOD", "S7-300/400"), true, "an alias resolves to its type's row");
assert.equal(platformSupport(ruleSet, "S5Time", "S7-1200 G2"), "S7-1500-compatible");
assert.equal(platformSupport(ruleSet, "Reference", "S7-1200"), false, "a REF_TO declaration's type resolves to the References row");
assert.equal(platformSupport(ruleSet, "VREF", "S7-1200 G2"), undefined, "systemDataTypes rows are not linted -- the registry marks them unverified");
assert.equal(platformSupport(ruleSet, "Any", "S7-1200"), undefined, "a row the registry marks unresolved is not linted");
assert.equal(platformSupport(ruleSet, "UDT_Anything", "S7-1200"), undefined);

// --- tiaLint.targetPlatform ----------------------------------------------------
const platformSource = [
  'FUNCTION_BLOCK "PlatformProbe"',
  "VAR",
  "   big : LInt;",
  "   values : Array[0..3] of LReal;",
  "   span : LTime;",
  "   plain : Int;",
  "   legacy : S5Time;",
  "END_VAR",
  "BEGIN",
  "END_FUNCTION_BLOCK",
  "",
  'FUNCTION "WideResult" : LInt',
  "BEGIN",
  "   #WideResult := 0;",
  "END_FUNCTION",
  "",
].join("\n");

const platformIndex = new BlockIndex();
platformIndex.rebuild([{ path: "platform.scl", text: platformSource }]);
const platformDiagnostics = (options) =>
  buildDocumentIndex(platformSource, ruleSet, platformIndex, "platform.scl", "en-US", undefined, options)
    .diagnostics.filter((d) => d.code === "type-unavailable-on-platform" || d.code === "type-requires-s7-1500-compatible-mode")
    .map((d) => [d.code, d.line, d.severity]);

assert.deepEqual(platformDiagnostics(undefined), [], "without a target platform nothing is reported");
assert.deepEqual(platformDiagnostics({ targetPlatform: "S7-1500" }), []);
assert.deepEqual(
  platformDiagnostics({ targetPlatform: "S7-1200" }),
  [
    ["type-unavailable-on-platform", 3, "warning"],
    ["type-unavailable-on-platform", 5, "warning"],
    ["type-unavailable-on-platform", 7, "warning"],
    ["type-unavailable-on-platform", 12, "warning"],
  ],
  "LInt, LTime, S5Time and an LInt return type are unavailable on S7-1200; LReal is available"
);
assert.deepEqual(
  platformDiagnostics({ targetPlatform: "S7-300/400" }).map(([, line]) => line),
  [3, 4, 5, 12],
  "an array's element type is checked too"
);
assert.deepEqual(platformDiagnostics({ targetPlatform: "S7-1200 G2" }), [["type-requires-s7-1500-compatible-mode", 7, "information"]]);

// --- tiaLint.iecCheck ----------------------------------------------------------
const iecSource = [
  'FUNCTION_BLOCK "IecProbe"',
  "VAR",
  "   w : Word;",
  "   n : Int;",
  "END_VAR",
  "BEGIN",
  "   #w := #w + 1;",
  "   #n := #n + 1;",
  "   #w := #w AND #w;",
  "END_FUNCTION_BLOCK",
  "",
].join("\n");

const [iecBlock] = parseS7dclFile(iecSource);
const iecIndex = new BlockIndex();
iecIndex.rebuild([{ path: "iec.scl", text: iecSource }]);
const typeCache = buildTypeCache(ruleSet, []);
const expressionDiagnostics = (options) =>
  checkSclExpressionTypes(iecBlock, ruleSet, iecIndex, typeCache, options).map((d) => [d.code, d.line, d.severity]);

assert.deepEqual(expressionDiagnostics(undefined), [], "with the IEC check assumed off, bit-string arithmetic is accepted");
assert.deepEqual(
  expressionDiagnostics({ iecCheck: true }),
  [["expr-arithmetic-iec-check", 7, "error"]],
  "with the IEC check on, only the bit-string arithmetic is reported"
);

console.log("Target platform and IEC check setting regressions passed.");
