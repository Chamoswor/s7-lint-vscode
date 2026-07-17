// Runs the full SCL lint pipeline against every fixture listed in
// fixtures/scl-diagnostics/manifest.yaml and reports actual-vs-expected, per
// that manifest's own "Assertion contract" (README.md):
//   - positive fixture: zero diagnostics anywhere in the file is a hard
//     gate -- any diagnostic at all is a regression.
//   - negative fixture: at least one diagnostic with the manifest's own
//     `severity` appears somewhere in the file (cascades are explicitly
//     tolerated per the manifest's own cascadePolicy -- this is a "did the
//     primary defect get caught at all" baseline check, not exact
//     count/line matching).
// Diagnostic CODE is intentionally NOT compared against the manifest's
// `rule`/EXPECT-marker text -- this project's own diagnostic-registry
// codes (e.g. "unknown-instruction") don't share the manifest's invented
// code namespace ("syntax.missing-semicolon"), and the manifest's own
// README explicitly says not to snapshot exact wording.
"use strict";
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const { loadRuleSet } = require("../out/rules/loadRules");
const { parseS7dclFile, detectS7dclKind } = require("../out/parser/s7dclParser");
const { checkSclInstructions } = require("../out/linter/sclInstructionChecks");
const { checkUndeclaredIdentifiers, checkSclConditionTypes, checkIllegalDotAccess } = require("../out/linter/symbolChecks");
const { checkSclExpressionTypes } = require("../out/linter/exprTypeChecks");
const { checkSclSyntaxStructure } = require("../out/linter/synStructureChecks");
const { BlockIndex } = require("../out/analysis/blockIndex");
const { buildDocumentIndex } = require("../out/analysis/documentIndex");
const { buildTypeCache } = require("../out/cache/typeCache");

const SUITE_DIR = path.join(__dirname, "fixtures", "scl-diagnostics");
const ruleSet = loadRuleSet(path.join(__dirname, "..", "resources"));

function lintFile(fsPath, text, blockIndex, typeCache) {
  const diags = [];
  for (const block of parseS7dclFile(text)) {
    diags.push(...checkSclInstructions(block, ruleSet, blockIndex, typeCache));
    diags.push(...checkUndeclaredIdentifiers(block, blockIndex, typeCache, ruleSet));
    diags.push(...checkIllegalDotAccess(block, blockIndex, typeCache, ruleSet));
    diags.push(...checkSclConditionTypes(block, blockIndex, typeCache, ruleSet));
    diags.push(...checkSclExpressionTypes(block, ruleSet, blockIndex, typeCache));
  }
  diags.push(...checkSclSyntaxStructure(text, ruleSet));
  diags.push(...buildDocumentIndex(text, ruleSet, blockIndex, fsPath).diagnostics);
  return diags;
}

const manifestPath = path.join(SUITE_DIR, "manifest.yaml");
const manifest = yaml.load(fs.readFileSync(manifestPath, "utf-8"));

const allFiles = [...(manifest.positive ?? []), ...(manifest.negative ?? [])].map((e) => path.join(SUITE_DIR, e.file));
const blockIndex = new BlockIndex();
blockIndex.rebuild(
  allFiles.filter((f) => fs.existsSync(f)).map((f) => ({ path: f, text: fs.readFileSync(f, "utf-8") }))
);
const typeCache = buildTypeCache(ruleSet, []);

let passed = 0;
let failed = 0;

function record(id, file, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${id} (${file})${ok ? "" : " -- " + detail}`);
}

for (const entry of manifest.positive ?? []) {
  const fsPath = path.join(SUITE_DIR, entry.file);
  if (!fs.existsSync(fsPath)) {
    record(entry.id, entry.file, false, "fixture file not found");
    continue;
  }
  const text = fs.readFileSync(fsPath, "utf-8");
  const diags = lintFile(fsPath, text, blockIndex, typeCache);
  const ok = diags.length === (entry.expectedDiagnostics ?? 0);
  record(entry.id, entry.file, ok, ok ? "" : `expected ${entry.expectedDiagnostics ?? 0}, got ${diags.length}: ${diags.map((d) => `L${d.line} [${d.severity}] (${d.code}) ${d.message}`).join(" | ")}`);
}

for (const entry of manifest.negative ?? []) {
  const fsPath = path.join(SUITE_DIR, entry.file);
  if (!fs.existsSync(fsPath)) {
    record(entry.id, entry.file, false, "fixture file not found");
    continue;
  }
  const text = fs.readFileSync(fsPath, "utf-8");
  let diags;
  try {
    diags = lintFile(fsPath, text, blockIndex, typeCache);
  } catch (err) {
    record(entry.id, entry.file, false, `linter THREW: ${err.stack.split("\n").slice(0, 3).join(" | ")}`);
    continue;
  }
  const matching = diags.filter((d) => d.severity === entry.severity);
  const ok = matching.length > 0;
  record(
    entry.id,
    entry.file,
    ok,
    ok ? "" : `expected >=1 ${entry.severity}, got 0 matching (${diags.length} total): ${diags.map((d) => `L${d.line} [${d.severity}] (${d.code}) ${d.message}`).join(" | ") || "(none)"}`
  );
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total.`);

if (failed > 0) process.exit(1);
