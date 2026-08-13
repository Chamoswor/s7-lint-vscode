"use strict";
const assert = require("assert").strict;
const Module = require("module");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "vscode") return require.resolve("./vscode-shim.js");
  return originalResolve.call(this, request, ...args);
};

const vscode = require("./vscode-shim.js");
const { parseS7res } = require("../out/parser/s7resParser");
const { S7ResQuickFixProvider } = require("../out/providers/s7resQuickFixProvider");

function document(fsPath, text, eol = vscode.EndOfLine.LF) {
  return { uri: vscode.Uri.file(fsPath), eol, getText: () => text };
}

function diagnostic(code, line, col = 0) {
  return { code, message: code, range: new vscode.Range(line, col, line, col + 1) };
}

function replacedText(action) {
  return action.edit.edits.find((edit) => edit.newText)?.newText;
}

(async () => {
  const provider = new S7ResQuickFixProvider();
  const source = [
    '{ S7_BlockTitle := "MLC_TITLE"; }',
    'FUNCTION_BLOCK "FB_Test"',
    '  { S7_MLC := "MLC_BODY" }',
    "END_FUNCTION_BLOCK",
    "",
  ].join("\n");
  const sourceDoc = document("C:\\project\\FB_Test.s7dcl", source);

  vscode.workspace.textDocuments.length = 0;
  vscode.workspace.fs.readFile = async () => {
    throw new Error("missing");
  };
  const createActions = await provider.provideCodeActions(sourceDoc, new vscode.Range(0, 0, 0, 1), {
    diagnostics: [diagnostic("mlc-id-not-found", 0, 19), diagnostic("mlc-id-not-found", 2, 14)],
  });
  assert.equal(createActions.length, 1);
  assert.match(createActions[0].title, /Create sibling \.s7res with 2 referenced MLC IDs/);
  assert.ok(createActions[0].edit.edits.some((edit) => edit.kind === "createFile"));
  const generated = createActions[0].edit.edits.find((edit) => edit.kind === "insert").newText;
  assert.deepEqual([...parseS7res(generated).entries.keys()], ["MLC_TITLE", "MLC_BODY"]);

  const existing = ["MultiLingualTexts:", "  - id: MLC_TITLE", "    en-US: Existing title", ""].join("\n");
  vscode.workspace.fs.readFile = async () => Buffer.from(existing);
  const addActions = await provider.provideCodeActions(sourceDoc, new vscode.Range(2, 0, 2, 1), {
    diagnostics: [diagnostic("mlc-id-not-found", 2, 14)],
  });
  assert.equal(addActions.length, 1);
  assert.match(addActions[0].title, /Add MLC id 'MLC_BODY'/);
  assert.ok(parseS7res(replacedText(addActions[0])).entries.has("MLC_BODY"));

  const hashText = ["MultiLingualTexts:", "  - id: MLC_HASH", "    en-US: Keep # complete", ""].join("\n");
  const hashDoc = document("C:\\project\\FB_Test.s7res", hashText);
  const quoteActions = await provider.provideCodeActions(hashDoc, new vscode.Range(2, 16, 2, 17), {
    diagnostics: [diagnostic("s7res-unquoted-comment", 2, 16)],
  });
  assert.equal(quoteActions.length, 1);
  assert.equal(replacedText(quoteActions[0]), "    en-US: 'Keep # complete'");

  const missingLocale = ["MultiLingualTexts:", "  - id: MLC_NO_EN", "    nb-NO: Norsk", ""].join("\n");
  const localeDoc = document("C:\\project\\FB_Test.s7res", missingLocale);
  const localeActions = await provider.provideCodeActions(localeDoc, new vscode.Range(1, 8, 1, 9), {
    diagnostics: [diagnostic("s7res-invalid-entry", 1, 8)],
  });
  assert.equal(localeActions.length, 1);
  assert.match(localeActions[0].title, /Add missing en-US text/);
  assert.equal(parseS7res(replacedText(localeActions[0])).entries.get("MLC_NO_EN").texts.get("en-US").text, "");

  console.log(".s7res Quick Fix provider actions passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
