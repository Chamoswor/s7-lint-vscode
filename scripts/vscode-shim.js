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

const TextEdit = {
  insert: (position, newText) => ({ kind: "insert", position, newText }),
  replace: (range, newText) => ({ kind: "replace", range, newText }),
};

const EndOfLine = { LF: 1, CRLF: 2 };

// -- providers/completion.ts's own additional surface --------------------
class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
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

module.exports = { Position, Range, TextEdit, EndOfLine, CompletionItem, CompletionItemKind, SnippetString, MarkdownString };
