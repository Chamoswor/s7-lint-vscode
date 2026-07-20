// Standalone Node test for providers/instanceQuickFix.ts's multi-instance /
// single-instance DATA_BLOCK generation logic -- same "pure logic, no
// Extension Development Host needed" philosophy as scripts/smoke-test.js,
// but assertion-based (pass/fail per case) rather than count-and-diff,
// since these are precise, individually-specified behaviors rather than a
// real-corpus regression surface. Only the `vscode` module itself is
// mocked (scripts/vscode-shim.js) -- BlockIndex/buildTypeCache/loadRuleSet
// are the REAL compiled modules, same as smoke-test.js already uses (none
// of them have a vscode dependency of their own).
"use strict";
const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const Module = require("module");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "vscode") return require.resolve("./vscode-shim.js");
  return originalResolve.call(this, request, ...args);
};

const { Position, EndOfLine } = require("./vscode-shim.js");
const { loadRuleSet } = require("../out/rules/loadRules");
const { BlockIndex } = require("../out/analysis/blockIndex");
const { buildTypeCache } = require("../out/cache/typeCache");
const {
  findInstanceDotEntry,
  instructionInstanceRef,
  fbInstanceRef,
  resolveBlockInstanceContext,
  buildInstanceDeclarationEdit,
  buildSingleInstanceDbEdit,
  identifierRangeAt,
} = require("../out/providers/instanceQuickFix");

const ruleSet = loadRuleSet(path.join(__dirname, "..", "resources"));

function makeDocument(text, eol) {
  const sep = eol === EndOfLine.CRLF ? "\r\n" : "\n";
  const lines = text.split(sep);
  return {
    eol,
    lineCount: lines.length,
    lineAt: (line) => ({ text: lines[line] }),
    getText: (range) => {
      if (!range) return text;
      if (range.start.line === range.end.line) return lines[range.start.line].slice(range.start.character, range.end.character);
      const parts = [lines[range.start.line].slice(range.start.character)];
      for (let l = range.start.line + 1; l < range.end.line; l++) parts.push(lines[l]);
      parts.push(lines[range.end.line].slice(0, range.end.character));
      return parts.join(sep);
    },
  };
}

function emptyBlockIndex() {
  const bi = new BlockIndex();
  bi.rebuild([]);
  return bi;
}

function emptyTypeCache() {
  return buildTypeCache(ruleSet, []);
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL: ${name}`);
    console.log(`  ${err.message}`);
  }
}

const mcPowerEntry = findInstanceDotEntry(ruleSet, "MC_Power");
assert.ok(mcPowerEntry, "fixture precondition: MC_Power must resolve as an instance-dot entry");
// The builders take an InstanceTypeRef (instruction OR user FB), not the
// raw registry entry -- see instanceQuickFix.ts's InstanceTypeRef.
const mcPowerRef = instructionInstanceRef(mcPowerEntry);
assert.ok(mcPowerRef, "fixture precondition: MC_Power must have a confirmed instanceType");

// --- 1. FB without a plain VAR section ---------------------------------
{
  const src = ['FUNCTION_BLOCK "T1"', "VAR_TEMP", "  ok : Bool;", "END_VAR", "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION_BLOCK", ""].join("\n");
  const doc = makeDocument(src, EndOfLine.LF);
  const ctx = resolveBlockInstanceContext(doc, 5);

  test("1a. FB without VAR section -> multi-instance creates a new VAR section", () => {
    assert.ok(ctx);
    const plan = buildInstanceDeclarationEdit(doc, ctx, mcPowerRef);
    assert.ok(plan, "multi-instance plan should be produced inside a FUNCTION_BLOCK");
    assert.ok(plan.edit.newText.startsWith("VAR\n"), "should create a brand-new VAR section");
    assert.ok(plan.edit.newText.includes("END_VAR"));
    assert.ok(plan.edit.newText.includes(`${plan.instanceName} {InstructionName := 'MC_POWER'} : MC_POWER;`));
  });

  test("1b. FB without VAR section -> single-instance DB is available", () => {
    const plan = buildSingleInstanceDbEdit(doc, ctx, mcPowerRef, emptyBlockIndex(), emptyTypeCache());
    assert.ok(plan, "single-instance plan should be produced");
    assert.ok(plan.edit.newText.startsWith(`DATA_BLOCK "${plan.dbName}"`));
  });
}

// --- 2. FB with an existing plain VAR section ---------------------------
{
  const src = ['FUNCTION_BLOCK "T2"', "VAR", "  existingVar : Int;", "END_VAR", "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION_BLOCK", ""].join("\n");
  const doc = makeDocument(src, EndOfLine.LF);
  const ctx = resolveBlockInstanceContext(doc, 5);

  test("2a. FB with existing VAR section -> multi-instance member is appended, not a new section", () => {
    const plan = buildInstanceDeclarationEdit(doc, ctx, mcPowerRef);
    assert.ok(plan);
    assert.ok(!plan.edit.newText.startsWith("VAR"), "must not create a second VAR section");
    assert.strictEqual(plan.edit.position.line, 3, "must insert right before the existing END_VAR line");
  });

  test("2b. FB with existing VAR section -> single-instance remains a separate, available action", () => {
    const plan = buildSingleInstanceDbEdit(doc, ctx, mcPowerRef, emptyBlockIndex(), emptyTypeCache());
    assert.ok(plan);
  });
}

// --- 3. FUNCTION (FC) ----------------------------------------------------
{
  const src = ['FUNCTION "F1" : Void', "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION", ""].join("\n");
  const doc = makeDocument(src, EndOfLine.LF);
  const ctx = resolveBlockInstanceContext(doc, 2);

  test("3a. FC -> multi-instance is NOT available", () => {
    assert.ok(ctx);
    assert.strictEqual(ctx.span.blockType, "FUNCTION");
    const plan = buildInstanceDeclarationEdit(doc, ctx, mcPowerRef);
    assert.strictEqual(plan, undefined, "a FUNCTION has no Static section -- must never offer a multi-instance");
  });

  test("3b. FC -> single-instance DB generation IS available", () => {
    const plan = buildSingleInstanceDbEdit(doc, ctx, mcPowerRef, emptyBlockIndex(), emptyTypeCache());
    assert.ok(plan);
  });
}

// --- 4. ORGANIZATION_BLOCK (OB) -----------------------------------------
{
  const src = ['ORGANIZATION_BLOCK "OB1"', "BEGIN", "  MC_Power(Enable := TRUE);", "END_ORGANIZATION_BLOCK", ""].join("\n");
  const doc = makeDocument(src, EndOfLine.LF);
  const ctx = resolveBlockInstanceContext(doc, 2);

  test("4a. OB -> multi-instance is NOT available", () => {
    assert.ok(ctx);
    assert.strictEqual(ctx.span.blockType, "ORGANIZATION_BLOCK");
    const plan = buildInstanceDeclarationEdit(doc, ctx, mcPowerRef);
    assert.strictEqual(plan, undefined, "an ORGANIZATION_BLOCK has no Static section -- must never offer a multi-instance");
  });

  test("4b. OB -> single-instance DB generation IS available", () => {
    const plan = buildSingleInstanceDbEdit(doc, ctx, mcPowerRef, emptyBlockIndex(), emptyTypeCache());
    assert.ok(plan);
  });
}

// --- 5/6/7/8. S7_Optimized_Access is MIRRORED from the CALLING block's own
// header pragma -- never an instruction-specific or guessed value. Confirmed
// against the single-instance DB fixture: its caller FUNCTION declares `{ S7_Optimized_Access :=
// 'TRUE' }` and the fixture's own generated MC_POWER_DB carries the exact
// same 'TRUE' (see test 15 below for the full round-trip). -----------------
{
  test("5. Enclosing block declares TRUE -> generated DB mirrors TRUE", () => {
    const src = ['FUNCTION_BLOCK "T5"', "{ S7_Optimized_Access := 'TRUE' }", "VAR_TEMP", "  ok : Bool;", "END_VAR", "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION_BLOCK", ""].join(
      "\n"
    );
    const doc = makeDocument(src, EndOfLine.LF);
    const ctx = resolveBlockInstanceContext(doc, 6);
    const plan = buildSingleInstanceDbEdit(doc, ctx, mcPowerRef, emptyBlockIndex(), emptyTypeCache());
    assert.ok(plan);
    assert.ok(plan.edit.newText.includes("S7_Optimized_Access := 'TRUE'"));
  });

  test("6. Enclosing block declares FALSE -> generated DB mirrors FALSE", () => {
    const src = ['FUNCTION_BLOCK "T6"', "{ S7_Optimized_Access := 'FALSE' }", "VAR_TEMP", "  ok : Bool;", "END_VAR", "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION_BLOCK", ""].join(
      "\n"
    );
    const doc = makeDocument(src, EndOfLine.LF);
    const ctx = resolveBlockInstanceContext(doc, 6);
    const plan = buildSingleInstanceDbEdit(doc, ctx, mcPowerRef, emptyBlockIndex(), emptyTypeCache());
    assert.ok(plan);
    assert.ok(plan.edit.newText.includes("S7_Optimized_Access := 'FALSE'"));
    assert.ok(!plan.edit.newText.includes("'TRUE'"), "must not default to TRUE");
  });

  test("7. Enclosing block's pragma is bare ({}, no S7_Optimized_Access property) -> generated DB omits it entirely", () => {
    const src = ['FUNCTION_BLOCK "T7"', "{}", "VAR_TEMP", "  ok : Bool;", "END_VAR", "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION_BLOCK", ""].join("\n");
    const doc = makeDocument(src, EndOfLine.LF);
    const ctx = resolveBlockInstanceContext(doc, 6);
    const plan = buildSingleInstanceDbEdit(doc, ctx, mcPowerRef, emptyBlockIndex(), emptyTypeCache());
    assert.ok(plan);
    assert.ok(!plan.edit.newText.includes("S7_Optimized_Access"));
  });

  test("8. Enclosing block has no pragma line at all -> generated DB omits S7_Optimized_Access entirely", () => {
    const src = ['FUNCTION_BLOCK "T8"', "VAR_TEMP", "  ok : Bool;", "END_VAR", "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION_BLOCK", ""].join("\n");
    const doc = makeDocument(src, EndOfLine.LF);
    const ctx = resolveBlockInstanceContext(doc, 5);
    const plan = buildSingleInstanceDbEdit(doc, ctx, mcPowerRef, emptyBlockIndex(), emptyTypeCache());
    assert.ok(plan);
    assert.ok(!plan.edit.newText.includes("S7_Optimized_Access"));
  });

  test("9. Two different callers with opposite pragmas each produce independently correct output (no cross-call bleed)", () => {
    const srcFalseCaller = ['FUNCTION_BLOCK "T9a"', "{ S7_Optimized_Access := 'FALSE' }", "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION_BLOCK", ""].join("\n");
    const docA = makeDocument(srcFalseCaller, EndOfLine.LF);
    const ctxA = resolveBlockInstanceContext(docA, 3);
    const planA = buildSingleInstanceDbEdit(docA, ctxA, mcPowerRef, emptyBlockIndex(), emptyTypeCache());
    assert.ok(planA.edit.newText.includes("'FALSE'"));
    assert.ok(!planA.edit.newText.includes("'TRUE'"));

    const srcTrueCaller = ['FUNCTION_BLOCK "T9b"', "{ S7_Optimized_Access := 'TRUE' }", "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION_BLOCK", ""].join("\n");
    const docB = makeDocument(srcTrueCaller, EndOfLine.LF);
    const ctxB = resolveBlockInstanceContext(docB, 3);
    const planB = buildSingleInstanceDbEdit(docB, ctxB, mcPowerRef, emptyBlockIndex(), emptyTypeCache());
    assert.ok(planB.edit.newText.includes("'TRUE'"));
    assert.ok(!planB.edit.newText.includes("'FALSE'"));
  });

  test("9b. TITLE line between the block header and its pragma is skipped over correctly (distributed-process-control.scl's own GasAlarms shape)", () => {
    const src = [
      'FUNCTION_BLOCK "T9c"',
      "TITLE = 'Something'",
      "{ S7_Optimized_Access := 'FALSE' }",
      "BEGIN",
      "  MC_Power(Enable := TRUE);",
      "END_FUNCTION_BLOCK",
      "",
    ].join("\n");
    const doc = makeDocument(src, EndOfLine.LF);
    const ctx = resolveBlockInstanceContext(doc, 4);
    const plan = buildSingleInstanceDbEdit(doc, ctx, mcPowerRef, emptyBlockIndex(), emptyTypeCache());
    assert.ok(plan);
    assert.ok(plan.edit.newText.includes("S7_Optimized_Access := 'FALSE'"));
  });
}

// --- 10. Local multi-instance name collision ------------------------------
{
  test("10. Local multi-instance name collision -> falls back to _1", () => {
    const src = ['FUNCTION_BLOCK "T10"', "VAR", "  MC_POWER_Instance : Int;", "END_VAR", "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION_BLOCK", ""].join("\n");
    const doc = makeDocument(src, EndOfLine.LF);
    const ctx = resolveBlockInstanceContext(doc, 5);
    const plan = buildInstanceDeclarationEdit(doc, ctx, mcPowerRef);
    assert.ok(plan);
    assert.strictEqual(plan.instanceName, "MC_POWER_Instance_1");
  });
}

// --- 11. Global DATA_BLOCK name collision --------------------------------
{
  test("11. Global DATA_BLOCK name collision -> falls back to _1", () => {
    const src = ['FUNCTION_BLOCK "T11"', "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION_BLOCK", ""].join("\n");
    const doc = makeDocument(src, EndOfLine.LF);
    const ctx = resolveBlockInstanceContext(doc, 2);
    const blockIndex = new BlockIndex();
    blockIndex.rebuild([{ path: "other.scl", text: 'DATA_BLOCK "MC_POWER_DB"\nBEGIN\nEND_DATA_BLOCK\n' }]);
    const plan = buildSingleInstanceDbEdit(doc, ctx, mcPowerRef, blockIndex, emptyTypeCache());
    assert.ok(plan);
    assert.strictEqual(plan.dbName, "MC_POWER_DB_1");
  });
}

// --- 12. Case-insensitive name collision ---------------------------------
{
  test("12a. Case-insensitive LOCAL multi-instance collision", () => {
    const src = ['FUNCTION_BLOCK "T12"', "VAR", "  mc_power_instance : Int;", "END_VAR", "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION_BLOCK", ""].join("\n");
    const doc = makeDocument(src, EndOfLine.LF);
    const ctx = resolveBlockInstanceContext(doc, 5);
    const plan = buildInstanceDeclarationEdit(doc, ctx, mcPowerRef);
    assert.ok(plan);
    assert.strictEqual(plan.instanceName, "MC_POWER_Instance_1", "must detect the collision despite differing case");
  });

  test("12b. Case-insensitive GLOBAL DATA_BLOCK collision", () => {
    const src = ['FUNCTION_BLOCK "T12b"', "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION_BLOCK", ""].join("\n");
    const doc = makeDocument(src, EndOfLine.LF);
    const ctx = resolveBlockInstanceContext(doc, 2);
    const blockIndex = new BlockIndex();
    blockIndex.rebuild([{ path: "other.scl", text: 'DATA_BLOCK "mc_power_db"\nBEGIN\nEND_DATA_BLOCK\n' }]);
    const plan = buildSingleInstanceDbEdit(doc, ctx, mcPowerRef, blockIndex, emptyTypeCache());
    assert.ok(plan);
    assert.strictEqual(plan.dbName, "MC_POWER_DB_1");
  });
}

// --- 13. LF and CRLF documents --------------------------------------------
{
  const lines = ['FUNCTION_BLOCK "T13"', "VAR_TEMP", "  ok : Bool;", "END_VAR", "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION_BLOCK", ""];

  test("13a. LF document -> generated edit uses LF only", () => {
    const doc = makeDocument(lines.join("\n"), EndOfLine.LF);
    const ctx = resolveBlockInstanceContext(doc, 5);
    const plan = buildInstanceDeclarationEdit(doc, ctx, mcPowerRef);
    assert.ok(plan);
    assert.ok(plan.edit.newText.includes("\n"));
    assert.ok(!plan.edit.newText.includes("\r\n"), "must not introduce CRLF into an LF document");
  });

  test("13b. CRLF document -> generated edit uses CRLF throughout", () => {
    const doc = makeDocument(lines.join("\r\n"), EndOfLine.CRLF);
    const ctx = resolveBlockInstanceContext(doc, 5);
    const plan = buildInstanceDeclarationEdit(doc, ctx, mcPowerRef);
    assert.ok(plan);
    assert.ok(plan.edit.newText.includes("\r\n"));
    assert.ok(!/[^\r]\n/.test(plan.edit.newText), "every newline in the generated text must be preceded by \\r");
  });
}

// --- 14. Missing or incomplete instruction metadata -----------------------
{
  test("14a. Instance-dot entry with no prior fixture-confirmed metadata -> single-instance IS now available (only instanceType gates it)", () => {
    const mcResetEntry = findInstanceDotEntry(ruleSet, "MC_Reset");
    assert.ok(mcResetEntry, "fixture precondition: MC_Reset must resolve as instance-dot");
    assert.ok(mcResetEntry.instanceType, "fixture precondition: MC_Reset must have a confirmed instanceType");

    const src = ['FUNCTION_BLOCK "T14a"', "BEGIN", "  MC_Reset(Execute := TRUE);", "END_FUNCTION_BLOCK", ""].join("\n");
    const doc = makeDocument(src, EndOfLine.LF);
    const ctx = resolveBlockInstanceContext(doc, 2);
    const plan = buildSingleInstanceDbEdit(doc, ctx, mcResetEntry, emptyBlockIndex(), emptyTypeCache());
    assert.ok(plan, "single-instance generation is legal for ANY instance-dot entry with a confirmed instanceType");
  });

  test("14b. Entry with no instanceType -> no instance type to declare, so no action", () => {
    // The "is there an instanceType at all" gate lives in
    // `instructionInstanceRef` now (the builders take an already-resolved
    // InstanceTypeRef, which also serves user FUNCTION_BLOCKs). Both callers
    // -- the Quick Fix provider and the instruction completion -- skip
    // offering anything when it returns undefined.
    const brokenEntry = { ...mcPowerEntry, instanceType: null };
    assert.strictEqual(instructionInstanceRef(brokenEntry), undefined);
  });
}

// --- 14c/d. A user FUNCTION_BLOCK as the instance type ---------------------
// Dotting into a bare FUNCTION_BLOCK (`"FB_Pump".member`) is illegal in TIA;
// the fix is to create an INSTANCE of it. An FB instance differs from an
// instruction instance in exactly two ways: the type is written QUOTED, and
// there is no `InstructionName` pragma (it isn't a catalog instruction).
{
  const fbRef = fbInstanceRef("FB_Pump");

  test("14c. FB multi-instance member is declared with a quoted type and no InstructionName pragma", () => {
    const src = ['FUNCTION_BLOCK "T14c"', "BEGIN", '  "FB_Pump".x;', "END_FUNCTION_BLOCK", ""].join("\n");
    const doc = makeDocument(src, EndOfLine.LF);
    const ctx = resolveBlockInstanceContext(doc, 2);
    const plan = buildInstanceDeclarationEdit(doc, ctx, fbRef);
    assert.ok(plan, "a multi-instance is legal inside a FUNCTION_BLOCK");
    assert.match(plan.edit.newText, /FB_Pump_Instance : "FB_Pump";/);
    assert.ok(!plan.edit.newText.includes("InstructionName"), "an FB member carries no InstructionName pragma");
  });

  test("14d. FB single-instance DB names the FUNCTION_BLOCK quoted, with no InstructionName pragma", () => {
    const src = ['FUNCTION "T14d" : Void', "BEGIN", '  "FB_Pump".x;', "END_FUNCTION", ""].join("\n");
    const doc = makeDocument(src, EndOfLine.LF);
    const ctx = resolveBlockInstanceContext(doc, 2);
    const plan = buildSingleInstanceDbEdit(doc, ctx, fbRef, emptyBlockIndex(), emptyTypeCache());
    assert.ok(plan, "single-instance DB generation is legal from a FUNCTION too");
    assert.strictEqual(plan.dbName, "FB_Pump_DB");
    assert.match(plan.edit.newText, /DATA_BLOCK "FB_Pump_DB"/);
    assert.match(plan.edit.newText, /^"FB_Pump"$/m, "the instance-of line is the quoted FB name");
    assert.ok(!plan.edit.newText.includes("InstructionName"), "an FB instance DB carries no InstructionName pragma");
  });
}

// --- 15. Round-trip fixture: matches TIA's single-instance DB shape -------
{
  test("15. Generated single-instance DB matches the TIA-generated fixture", () => {
    const fixturePath = path.join(__dirname, "fixtures", "quick-fix", "single-instance-db.scl");
    const fixtureLines = fs
      .readFileSync(fixturePath, "utf-8")
      .replace(/^﻿/, "") // strip the file's own UTF-8 BOM -- an encoding artifact, not part of the generated syntax
      .replace(/\r\n/g, "\n")
      .split("\n");
    // The fixture's DATA_BLOCK declaration: "DATA_BLOCK ..." through "END_DATA_BLOCK".
    const expected = fixtureLines.slice(0, 8).join("\n");

    // The fixture's caller declares `{ S7_Optimized_Access
    // := 'TRUE' }` -- reproduced here so the mirrored value matches the fixture.
    const src = ['FUNCTION_BLOCK "Caller"', "{ S7_Optimized_Access := 'TRUE' }", "VAR_TEMP", "  ok : Bool;", "END_VAR", "BEGIN", "  MC_Power(Enable := TRUE);", "END_FUNCTION_BLOCK", ""].join(
      "\n"
    );
    const doc = makeDocument(src, EndOfLine.LF);
    const ctx = resolveBlockInstanceContext(doc, 6);
    const plan = buildSingleInstanceDbEdit(doc, ctx, mcPowerRef, emptyBlockIndex(), emptyTypeCache());
    assert.ok(plan);
    assert.strictEqual(plan.dbName, "MC_POWER_DB", "DB name must match the fixture exactly");

    const generated = plan.edit.newText.split("\n").slice(0, 8).join("\n");
    assert.strictEqual(generated, expected, "generated DB declaration must match the fixture exactly");

    const nameRange = identifierRangeAt(doc, new Position(6, doc.lineAt(6).text.indexOf("MC_Power")));
    assert.ok(nameRange);
    const callRewrite = `"${plan.dbName}"`;
    assert.strictEqual(callRewrite, '"MC_POWER_DB"', "call-site rewrite must match the fixture's quoted call form");
  });
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
