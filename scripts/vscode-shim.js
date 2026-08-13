// Minimal mock of the `vscode` module surface providers/instanceQuickFix.ts
// actually uses at runtime (Position/Range/TextEdit/EndOfLine) -- just
// enough to exercise that module's pure text-position logic as a
// standalone Node script (see scripts/test-instance-quickfix.js), without
// launching the Extension Development Host. Intentionally NOT a general
// vscode mock -- add surface here only as new tests need it.
"use strict";

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
  translate(lineDelta, charDelta) {
    return new Position(this.line + (lineDelta || 0), this.character + (charDelta || 0));
  }
}

class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) {
      this.start = a;
      this.end = b;
    } else {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    }
  }
}

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
  }
  static file(fsPath) {
    return new Uri(fsPath);
  }
  toString() {
    return `file:///${this.fsPath.replace(/\\/g, "/")}`;
  }
}

class WorkspaceEdit {
  constructor() {
    this.edits = [];
  }
  replace(uri, range, newText) {
    this.edits.push({ uri, range, newText });
  }
  insert(uri, position, newText) {
    this.edits.push({ kind: "insert", uri, position, newText });
  }
  createFile(uri, options) {
    this.edits.push({ kind: "createFile", uri, options });
  }
  set(uri, edits) {
    this.edits.push({ kind: "set", uri, edits });
  }
}

const TextEdit = {
  insert: (position, newText) => ({ kind: "insert", position, newText }),
  replace: (range, newText) => ({ kind: "replace", range, newText }),
};

const EndOfLine = { LF: 1, CRLF: 2 };
const CompletionTriggerKind = { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 };
const workspace = {
  textDocuments: [],
  findFiles: async () => [],
  fs: { readFile: async () => Buffer.from("") },
  getConfiguration: () => ({ get: (_key, fallback) => fallback }),
};

// -- providers/completion.ts's own additional surface --------------------
class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
  }
}
class CompletionList {
  constructor(items = [], isIncomplete = false) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}
// Real enum values don't matter for a test (nothing compares against a
// specific number) -- distinct placeholders are enough.
const CompletionItemKind = {
  Text: 0,
  Method: 1,
  Function: 2,
  Constructor: 3,
  Field: 4,
  Variable: 5,
  Class: 6,
  Interface: 7,
  Module: 8,
  Property: 9,
  Struct: 21,
  Snippet: 14,
};
class SnippetString {
  constructor(value) {
    this.value = value;
  }
}
class MarkdownString {
  constructor(value) {
    this.value = value;
  }
}
class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
  }
}
const CodeActionKind = { QuickFix: "quickfix" };

module.exports = {
  Position,
  Range,
  Uri,
  WorkspaceEdit,
  TextEdit,
  EndOfLine,
  workspace,
  CompletionTriggerKind,
  CompletionItem,
  CompletionList,
  CompletionItemKind,
  SnippetString,
  MarkdownString,
  CodeAction,
  CodeActionKind,
};
