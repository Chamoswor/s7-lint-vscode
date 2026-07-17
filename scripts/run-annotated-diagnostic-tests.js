// Runs the full SCL lint pipeline (same checks extension.ts's lintDocument
// wires up for an `.scl` document) against every fixture in
// fixtures/scl-diagnostics/annotated/*.scl, and verifies each `// EXPECT-PASS: TT-xxx` /
// `// EXPECT-WARNING: TT-xxx` / `// EXPECT-ERROR: TT-xxx` annotation
// against what the linter ACTUALLY reports on the statement line
// immediately above it. TT-xxx ids are just human-readable labels for this
// test file itself -- they don't correspond to any real diagnostic `code`,
// so this only checks SEVERITY (and count -- see below), never a specific
// code string.
//
// Strict, not "at least one": PASS requires ZERO diagnostics on the
// subject line, WARNING/ERROR require EXACTLY ONE, of the matching
// severity. expression-type-diagnostics.scl's TT-E010 case (a nested-error
// expression) explicitly calls out "the linter should avoid producing
// misleading secondary errors" -- an "at least one" check would silently
// let a doubled-up diagnostic through.
"use strict";
const fs = require("fs");
const path = require("path");

const { loadRuleSet } = require("../out/rules/loadRules");
const { parseS7dclFile } = require("../out/parser/s7dclParser");
const { checkSclInstructions } = require("../out/linter/sclInstructionChecks");
const { checkUndeclaredIdentifiers, checkSclConditionTypes, checkIllegalDotAccess } = require("../out/linter/symbolChecks");
const { checkSclExpressionTypes } = require("../out/linter/exprTypeChecks");
const { checkSclSyntaxStructure } = require("../out/linter/synStructureChecks");
const { BlockIndex } = require("../out/analysis/blockIndex");
const { buildDocumentIndex } = require("../out/analysis/documentIndex");
const { buildTypeCache } = require("../out/cache/typeCache");

const FIXTURES_DIR = path.join(__dirname, "fixtures", "scl-diagnostics", "annotated");
const ruleSet = loadRuleSet(path.join(__dirname, "..", "resources"));

const EXPECT_RE = /\/\/\s*EXPECT-(PASS|WARNING|ERROR):\s*(\S+)/;

function lintFile(fsPath, text, blockIndex, typeCache) {
  // line (1-based) -> diagnostics on that line, mirroring extension.ts's
  // own lintDocument SCL branch exactly (same checks, same order).
  const byLine = new Map();
  const push = (d) => {
    if (!byLine.has(d.line)) byLine.set(d.line, []);
    byLine.get(d.line).push(d);
  };
  for (const block of parseS7dclFile(text)) {
    for (const d of checkSclInstructions(block, ruleSet, blockIndex, typeCache)) push(d);
    for (const d of checkUndeclaredIdentifiers(block, blockIndex, typeCache, ruleSet)) push(d);
    for (const d of checkIllegalDotAccess(block, blockIndex, typeCache, ruleSet)) push(d);
    for (const d of checkSclConditionTypes(block, blockIndex, typeCache, ruleSet)) push(d);
    for (const d of checkSclExpressionTypes(block, ruleSet, blockIndex, typeCache)) push(d);
  }
  for (const d of checkSclSyntaxStructure(text, ruleSet)) push(d);
  for (const d of buildDocumentIndex(text, ruleSet, blockIndex, fsPath).diagnostics) push(d);
  return byLine;
}

/** The 1-based line number of the real statement an `EXPECT-*` comment (at
 * `commentLineIdx`, 0-based) describes -- the nearest line ABOVE it that
 * isn't blank and isn't itself a `//`-only comment line. */
function findSubjectLine(lines, commentLineIdx) {
  for (let i = commentLineIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("//")) continue;
    return i + 1; // 1-based
  }
  return null;
}

let passed = 0;
let failed = 0;
const failures = [];

function check(id, expectKind, subjectLine, diagsOnLine, file) {
  const diags = diagsOnLine ?? [];
  let ok;
  let detail;
  if (expectKind === "PASS") {
    ok = diags.length === 0;
    detail = ok ? "" : `expected 0 diagnostics, got ${diags.length}: ${diags.map((d) => `[${d.severity}] ${d.message}`).join(" | ")}`;
  } else {
    const wantSeverity = expectKind === "WARNING" ? "warning" : "error";
    ok = diags.length === 1 && diags[0].severity === wantSeverity;
    detail = ok
      ? ""
      : `expected exactly 1 ${wantSeverity}, got ${diags.length}: ${diags.map((d) => `[${d.severity}] ${d.message}`).join(" | ") || "(none)"}`;
  }
  if (ok) {
    passed++;
    console.log(`PASS: ${id} (${file}:${subjectLine})`);
  } else {
    failed++;
    console.log(`FAIL: ${id} (${file}:${subjectLine}) -- ${detail}`);
    failures.push({ id, file, subjectLine, detail });
  }
}

const files = fs.existsSync(FIXTURES_DIR) ? fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".scl")) : [];
if (files.length === 0) {
  console.log(`No .scl fixtures found in ${FIXTURES_DIR}.`);
  process.exit(1);
}

const blockIndex = new BlockIndex();
blockIndex.rebuild(files.map((f) => ({ path: path.join(FIXTURES_DIR, f), text: fs.readFileSync(path.join(FIXTURES_DIR, f), "utf-8") })));
const typeCache = buildTypeCache(ruleSet, []);

for (const file of files) {
  const fsPath = path.join(FIXTURES_DIR, file);
  const text = fs.readFileSync(fsPath, "utf-8");
  const lines = text.split(/\r\n|\n/);
  const byLine = lintFile(fsPath, text, blockIndex, typeCache);

  for (let i = 0; i < lines.length; i++) {
    const m = EXPECT_RE.exec(lines[i]);
    if (!m) continue;
    const [, kind, id] = m;
    const subjectLine = findSubjectLine(lines, i);
    if (subjectLine === null) {
      failed++;
      console.log(`FAIL: ${id} (${file}:${i + 1}) -- couldn't find a subject statement line above this annotation`);
      continue;
    }
    check(id, kind, subjectLine, byLine.get(subjectLine), file);
  }
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f.id} (${f.file}:${f.subjectLine}): ${f.detail}`);
  process.exit(1);
}
