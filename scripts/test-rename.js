// Standalone end-to-end checks for providers/rename.ts through the same
// minimal VS Code shim used by the other provider tests. Exercises a PLC
// data type declaration and resolved references across every supported text
// source extension without launching an Extension Development Host.
"use strict";

const assert = require("assert").strict;
const path = require("path");
const Module = require("module");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "vscode") return require.resolve("./vscode-shim.js");
  return originalResolve.call(this, request, ...args);
};

const vscode = require("./vscode-shim.js");
const { BlockIndex } = require("../out/analysis/blockIndex");
const { buildTypeCache } = require("../out/cache/typeCache");
const { parseUdtText } = require("../out/parser/udtTextParser");
const { S7dclRenameProvider } = require("../out/providers/rename");
const { loadRuleSet } = require("../out/rules/loadRules");

const ruleSet = loadRuleSet(path.join(__dirname, "..", "resources"));
const root = "F:\\rename-workspace";
const paths = {
  types: `${root}\\TypeTest.scl`,
  consumer: `${root}\\Consumer.scl`,
  declaration: `${root}\\LegacyConsumer.s7dcl`,
  wrapper: `${root}\\Wrapper.udt`,
  data: `${root}\\NestedData.db`,
};

const texts = new Map([
  [
    paths.types,
    [
      'TYPE "Nested"',
      "VERSION : 0.1",
      "   STRUCT",
      "      Member : Int;",
      "   END_STRUCT;",
      "END_TYPE",
      "",
      'TYPE "Base"',
      "VERSION : 0.1",
      "   STRUCT",
      '      TestNested : "Nested";',
      "   END_STRUCT;",
      "END_TYPE",
      "",
    ].join("\n"),
  ],
  [
    paths.declaration,
    ['FUNCTION_BLOCK "LegacyConsumer"', "VAR", '   Value : "Nested";', "END_VAR", "BEGIN", "END_FUNCTION_BLOCK", ""].join("\n"),
  ],
  [
    paths.consumer,
    [
      'FUNCTION_BLOCK "Consumer"',
      "VAR",
      '   Direct : "nested";', // deliberately different casing
      '   Items : Array[1..4] of "Nested";',
      "END_VAR",
      "BEGIN",
      '   // A comment mentioning "Nested" is not a symbol reference.',
      "END_FUNCTION_BLOCK",
      "",
    ].join("\n"),
  ],
  [
    paths.wrapper,
    ['TYPE "Wrapper"', "VERSION : 0.1", "   STRUCT", '      Value : "Nested";', "   END_STRUCT;", "END_TYPE", ""].join("\n"),
  ],
  [paths.data, ['DATA_BLOCK "NestedData"', '"Nested"', "BEGIN", "END_DATA_BLOCK", ""].join("\n")],
]);

function makeDocument(fsPath, text) {
  const lines = text.split("\n");
  const starts = [0];
  for (const line of lines.slice(0, -1)) starts.push(starts[starts.length - 1] + line.length + 1);
  return {
    languageId: fsPath.toLowerCase().endsWith(".udt") ? "s7udt" : fsPath.toLowerCase().endsWith(".scl") ? "s7scl" : "s7dcl",
    uri: vscode.Uri.file(fsPath),
    getText(range) {
      if (!range) return text;
      return text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
    },
    lineAt(line) {
      return { text: lines[line] ?? "" };
    },
    offsetAt(position) {
      return starts[position.line] + position.character;
    },
    positionAt(offset) {
      let line = 0;
      while (line + 1 < starts.length && starts[line + 1] <= offset) line++;
      return new vscode.Position(line, offset - starts[line]);
    },
  };
}

function positionInside(document, needle, occurrence = 0) {
  let offset = -1;
  for (let i = 0; i <= occurrence; i++) offset = document.getText().indexOf(needle, offset + 1);
  assert.ok(offset >= 0, `missing fixture text ${needle}`);
  return document.positionAt(offset + Math.max(1, Math.floor(needle.length / 2)));
}

function applyEdits(original, document, edits) {
  const replacements = edits
    .map((edit) => ({ start: document.offsetAt(edit.range.start), end: document.offsetAt(edit.range.end), text: edit.newText }))
    .sort((a, b) => b.start - a.start);
  let result = original;
  for (const replacement of replacements) result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  return result;
}

const documents = new Map([...texts].map(([fsPath, text]) => [fsPath, makeDocument(fsPath, text)]));
const uris = [...texts.keys()].map((fsPath) => vscode.Uri.file(fsPath));
vscode.workspace.textDocuments = [documents.get(paths.types)];
vscode.workspace.findFiles = async () => uris;
vscode.workspace.fs.readFile = async (uri) => Buffer.from(texts.get(uri.fsPath) ?? "", "utf8");

const udtSources = [paths.types, paths.wrapper].map((fsPath) => ({ path: fsPath, decls: parseUdtText(texts.get(fsPath)) }));
const typeCache = buildTypeCache(ruleSet, udtSources);
const blockIndex = new BlockIndex();
blockIndex.rebuild([
  { path: paths.consumer, text: texts.get(paths.consumer) },
  { path: paths.declaration, text: texts.get(paths.declaration) },
  { path: paths.data, text: texts.get(paths.data) },
]);
const provider = new S7dclRenameProvider(ruleSet, blockIndex, () => typeCache);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL: ${name}\n  ${error.stack || error}`);
  }
}

(async () => {
  await test("TYPE declaration is directly renameable without selecting its quotes", async () => {
    const document = documents.get(paths.types);
    const range = provider.prepareRename(document, positionInside(document, "Nested"));
    assert.equal(document.getText(range), "Nested");
  });

  await test("a case-insensitive quoted UDT reference is also renameable", async () => {
    const document = documents.get(paths.consumer);
    const range = provider.prepareRename(document, positionInside(document, "nested"));
    assert.equal(document.getText(range), "nested");
  });

  await test("renaming a UDT updates declarations and resolved references across supported files", async () => {
    const document = documents.get(paths.types);
    const edit = await provider.provideRenameEdits(document, positionInside(document, "Nested"), "RenamedNested");
    assert.ok(edit instanceof vscode.WorkspaceEdit);

    const byPath = new Map();
    for (const item of edit.edits) {
      const list = byPath.get(item.uri.fsPath) ?? [];
      list.push(item);
      byPath.set(item.uri.fsPath, list);
    }

    assert.equal(edit.edits.length, 7, "declaration + six real references should be edited; the comment must be ignored");
    const renamedTypes = applyEdits(texts.get(paths.types), documents.get(paths.types), byPath.get(paths.types));
    const renamedConsumer = applyEdits(texts.get(paths.consumer), documents.get(paths.consumer), byPath.get(paths.consumer));
    const renamedDeclaration = applyEdits(texts.get(paths.declaration), documents.get(paths.declaration), byPath.get(paths.declaration));
    const renamedWrapper = applyEdits(texts.get(paths.wrapper), documents.get(paths.wrapper), byPath.get(paths.wrapper));
    const renamedData = applyEdits(texts.get(paths.data), documents.get(paths.data), byPath.get(paths.data));

    assert.ok(renamedTypes.includes('TYPE "RenamedNested"'));
    assert.ok(renamedTypes.includes('TestNested : "RenamedNested";'));
    assert.ok(renamedConsumer.includes('Direct : "RenamedNested";'));
    assert.ok(renamedConsumer.includes('Array[1..4] of "RenamedNested";'));
    assert.ok(renamedConsumer.includes('// A comment mentioning "Nested"'));
    assert.ok(renamedDeclaration.includes('Value : "RenamedNested";'));
    assert.ok(renamedWrapper.includes('Value : "RenamedNested";'));
    assert.ok(renamedData.includes('"RenamedNested"'));
  });

  await test("renaming a UDT to a built-in datatype is rejected", async () => {
    const document = documents.get(paths.types);
    await assert.rejects(
      () => provider.provideRenameEdits(document, positionInside(document, "Nested"), "Bool"),
      /elementary type name already exists/
    );
  });

  await test("renaming a UDT to another workspace UDT is rejected", async () => {
    const document = documents.get(paths.types);
    await assert.rejects(
      () => provider.provideRenameEdits(document, positionInside(document, "Nested"), "Base"),
      /PLC data type name already exists/
    );
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
})();
