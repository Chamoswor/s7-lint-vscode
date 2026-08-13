"use strict";

const assert = require("assert").strict;
const path = require("path");
const { analyzeS7res, parseS7res } = require("../out/parser/s7resParser");
const { checkMlcReferences, checkS7res } = require("../out/linter/s7resChecks");
const { loadRuleSet } = require("../out/rules/loadRules");

const ruleSet = loadRuleSet(path.join(__dirname, "..", "resources"));

const importFailure = [
  "MultiLingualTexts:",
  "  - id: MLC_BA07",
  "    en-US: Automatisk stopp etter tid (funksjonsbeskrivelsen: 15 min) Felles",
  "",
].join("\n");
const importFailureAnalysis = analyzeS7res(importFailure);
assert.equal(importFailureAnalysis.parsed, undefined);
assert.ok(importFailureAnalysis.issues.some((issue) => issue.kind === "invalid-yaml" && issue.line === 3));

const validResource = [
  "MultiLingualTexts:",
  "  - id: MLC_USED",
  "    en-US: 'Forrigling: høy temperatur'",
  "  - id: MLC_ORPHAN",
  "    en-US: T#15M er en trygg, usitert verdi",
  "",
].join("\n");
assert.ok(parseS7res(validResource));
assert.deepEqual(checkS7res(validResource, ruleSet).map((diagnostic) => diagnostic.code), []);

const silentlyTruncated = ["MultiLingualTexts:", "  - id: MLC_HASH", "    en-US: Behold dette # og dette også", ""].join("\n");
const hashDiagnostics = checkS7res(silentlyTruncated, ruleSet);
assert.deepEqual(hashDiagnostics.map((diagnostic) => diagnostic.code), ["s7res-unquoted-comment"]);
assert.equal(hashDiagnostics[0].line, 3);
assert.match(hashDiagnostics[0].message, /Retained text: 'Behold dette'/);
assert.ok(analyzeS7res(silentlyTruncated).parsed, "valid YAML retains its ID set for cross-reference checks");
assert.equal(parseS7res(silentlyTruncated), null);

const duplicateIds = [
  "MultiLingualTexts:",
  "  - id: MLC_DUP",
  "    en-US: First",
  "  - id: MLC_DUP",
  "    en-US: Second",
  "",
].join("\n");
assert.deepEqual(checkS7res(duplicateIds, ruleSet).map((diagnostic) => diagnostic.code), ["s7res-duplicate-id"]);

const invalidSchema = ["MultiLingualTexts:", "  - id: MLC_NO_TEXT", "    nb-NO: Mangler engelsk tekst", ""].join("\n");
assert.deepEqual(checkS7res(invalidSchema, ruleSet).map((diagnostic) => diagnostic.code), ["s7res-invalid-entry"]);
assert.deepEqual(checkMlcReferences('{ S7_MLC := "MLC_NO_TEXT" }', invalidSchema, ruleSet), []);

const sourceText = [
  '{ S7_BlockTitle := "MLC_USED"; }',
  'FUNCTION_BLOCK "FB_Test"',
  "VAR_INPUT",
  '  { S7_MLC := "MLC_MISSING" }',
  "  i_xValue : Bool;",
  "END_VAR",
  "END_FUNCTION_BLOCK",
  "",
].join("\n");
const sourceDiagnostics = checkMlcReferences(sourceText, validResource, ruleSet);
assert.deepEqual(sourceDiagnostics.map((diagnostic) => diagnostic.code), ["mlc-id-not-found"]);
assert.equal(sourceDiagnostics[0].line, 4);

const resourceDiagnostics = checkS7res(validResource, ruleSet, sourceText);
assert.deepEqual(resourceDiagnostics.map((diagnostic) => diagnostic.code), ["s7res-orphaned-id"]);
assert.equal(resourceDiagnostics[0].line, 4);

assert.deepEqual(checkMlcReferences(sourceText, undefined, ruleSet).map((diagnostic) => diagnostic.code), [
  "mlc-id-not-found",
  "mlc-id-not-found",
]);
assert.deepEqual(checkMlcReferences(sourceText, importFailure, ruleSet), []);

console.log(".s7res YAML, schema, silent-text-loss, duplicate-ID, and MLC cross-reference checks passed.");
