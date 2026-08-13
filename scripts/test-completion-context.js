// Standalone Node test for the SCL section-aware completion behavior:
// analysis/sclCompletionContext.ts's own context resolver (pure, no vscode
// needed) plus providers/completion.ts's `S7dclCompletionProvider` end to
// end via scripts/vscode-shim.js (same "mock just the vscode surface
// actually touched" approach scripts/test-instance-quickfix.js already
// uses). Covers the validation cases from the completion-behavior request
// this was built against: declaration-section datatype completion (bare +
// quoted UDT + array), and the executable-body/declaration-section
// suggestion gating.
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
const { loadRuleSet } = require("../out/rules/loadRules");
const { BlockIndex } = require("../out/analysis/blockIndex");
const { buildTypeCache } = require("../out/cache/typeCache");
const { resolveSclCompletionContext } = require("../out/analysis/sclCompletionContext");
const { S7dclCompletionProvider } = require("../out/providers/completion");

const ruleSet = loadRuleSet(path.join(__dirname, "..", "resources"));
const blockIndex = new BlockIndex();
blockIndex.rebuild([]);
const typeCache = buildTypeCache(ruleSet, [{ path: "test.udt", decls: [{ name: "UserDefined", members: [], line: 1 }] }]);
const provider = new S7dclCompletionProvider(ruleSet, blockIndex, () => typeCache);

function makeDocument(text, languageId) {
  const lines = text.split("\n");
  const lineStartOffsets = [0];
  for (const line of lines.slice(0, -1)) lineStartOffsets.push(lineStartOffsets[lineStartOffsets.length - 1] + line.length + 1);
  return {
    languageId,
    uri: "file:///completion-test.scl",
    eol: vscode.EndOfLine.LF,
    lineCount: lines.length,
    getText: (range) => {
      if (!range) return text;
      const startOff = lineStartOffsets[range.start.line] + range.start.character;
      const endOff = lineStartOffsets[range.end.line] + range.end.character;
      return text.slice(startOff, endOff);
    },
    lineAt: (line) => ({ text: lines[line] }),
    offsetAt: (position) => lineStartOffsets[position.line] + position.character,
    positionAt: (offset) => {
      let line = 0;
      while (line + 1 < lineStartOffsets.length && lineStartOffsets[line + 1] <= offset) line++;
      return new vscode.Position(line, offset - lineStartOffsets[line]);
    },
  };
}

/** Builds a document from `text` containing a single `|` cursor marker
 * (removed before use), and returns `{document, position}`. */
function withCursor(text, languageId) {
  const idx = text.indexOf("|");
  assert.ok(idx >= 0, "test fixture must contain a | cursor marker");
  const clean = text.slice(0, idx) + text.slice(idx + 1);
  const document = makeDocument(clean, languageId);
  const position = document.positionAt(idx);
  return { document, position };
}

/** Simulates accepting a completion item whose `insertText` is a
 * (possibly multi-line) `vscode.SnippetString` -- replaces `item.range`
 * with `item.insertText`'s own `.value`, but ALSO reproduces a real VS
 * Code editor's own behavior of prepending the FIRST line's indentation
 * to every OTHER line of a multi-line snippet before insertion (this
 * project's own completion.ts relies on exactly that -- see its
 * `indentInfo`'s own comment -- so a naive plain-text concatenation here
 * would not match what a real editor actually produces). */
function simulateAccept(document, item) {
  const startOff = document.offsetAt(item.range.start);
  const endOff = document.offsetAt(item.range.end);
  const full = document.getText();
  const raw = item.insertText instanceof vscode.SnippetString ? item.insertText.value : item.insertText;
  const baseIndent = /^[ \t]*/.exec(document.lineAt(item.range.start.line).text)[0];
  const withBaseline = raw
    .split("\n")
    .map((l, i) => (i === 0 ? l : baseIndent + l))
    .join("\n");
  return full.slice(0, startOff) + withBaseline + full.slice(endOff);
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
    console.log(`FAIL: ${name}\n  ${err.stack || err}`);
  }
}

// A CompletionItem's `label` is either a plain string or a
// CompletionItemLabel ({ label, detail, description }) -- the executable-body
// lists use the latter so each row can say WHICH plane it came from (local
// tag / workspace block / TIA instruction) without that note becoming part
// of the inserted text. Everything here matches on the label TEXT either way.
function labelText(item) {
  return typeof item.label === "string" ? item.label : item.label.label;
}

function labelDescription(item) {
  return typeof item.label === "string" ? undefined : item.label.description;
}

function labels(items) {
  return (items || []).map(labelText);
}

// --- analysis/sclCompletionContext.ts direct tests -----------------------

test("context: inside VAR_INPUT, nothing after colon -> bare-type, empty partial", () => {
  const text = "FUNCTION_BLOCK \"X\"\nVAR_INPUT\n   inputValue :\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n";
  const offset = text.indexOf(":") + 1;
  const ctx = resolveSclCompletionContext(text, offset);
  assert.equal(ctx.kind, "declaration");
  assert.equal(ctx.section, "VAR_INPUT");
  assert.equal(ctx.decl.kind, "bare-type");
  assert.equal(ctx.decl.identStart, null);
});

test("context: still typing the member name -> 'name' (before colon)", () => {
  const text = "FUNCTION_BLOCK \"X\"\nVAR_INPUT\n   inputVal\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n";
  const offset = text.indexOf("inputVal") + "inputVal".length;
  const ctx = resolveSclCompletionContext(text, offset);
  assert.equal(ctx.kind, "declaration");
  assert.equal(ctx.decl.kind, "name");
});

test("context: inside Array[...] bounds -> array-bounds", () => {
  const text = "FUNCTION_BLOCK \"X\"\nVAR\n   v : Array[1..\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n";
  const offset = text.indexOf("Array[1..") + "Array[1..".length;
  const ctx = resolveSclCompletionContext(text, offset);
  assert.equal(ctx.kind, "declaration");
  assert.equal(ctx.decl.kind, "array-bounds");
});

test("context: after 'of', bare partial -> bare-type, afterArrayOf true", () => {
  const text = "FUNCTION_BLOCK \"X\"\nVAR\n   v : Array[1..4] of R\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n";
  const offset = text.indexOf("of R") + "of R".length;
  const ctx = resolveSclCompletionContext(text, offset);
  assert.equal(ctx.kind, "declaration");
  assert.equal(ctx.decl.kind, "bare-type");
  assert.equal(ctx.decl.afterArrayOf, true);
});

test("context: after 'of \"' -> quoted-type, afterArrayOf true", () => {
  const text = "FUNCTION_BLOCK \"X\"\nVAR\n   v : Array[1..4] of \"\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n";
  const offset = text.indexOf('of "') + 'of "'.length;
  const ctx = resolveSclCompletionContext(text, offset);
  assert.equal(ctx.kind, "declaration");
  assert.equal(ctx.decl.kind, "quoted-type");
  assert.equal(ctx.decl.afterArrayOf, true);
});

test("context: inside BEGIN body -> executable", () => {
  const text = "FUNCTION_BLOCK \"X\"\nVAR\nEND_VAR\nBEGIN\n   my\nEND_FUNCTION_BLOCK\n";
  const offset = text.indexOf("my") + 2;
  const ctx = resolveSclCompletionContext(text, offset);
  assert.equal(ctx.kind, "executable");
});

// Regression: statement closers share the `END_` prefix with the real
// top-level closers. Treating one as a block closer ended the block early, so
// everything after the first `END_IF;` in a body was misread as the source-file
// ROOT -- offering FUNCTION_BLOCK/DATA_BLOCK/TYPE templates mid-code and
// suppressing the body's own instruction/tag completions.
for (const [closer, body] of [
  ["END_IF", "IF #a THEN\n      #b := 1;\n   END_IF;"],
  ["END_CASE", "CASE #a OF\n      1: #b := 1;\n   END_CASE;"],
  ["END_FOR", "FOR #i := 1 TO 3 DO\n      #b := 1;\n   END_FOR;"],
  ["END_WHILE", "WHILE #a DO\n      #b := 1;\n   END_WHILE;"],
  ["END_REPEAT", "REPEAT\n      #b := 1;\n   UNTIL #a END_REPEAT;"],
]) {
  test(`context: still executable after a ${closer} statement closer`, () => {
    const text = `FUNCTION_BLOCK "X"\nVAR\nEND_VAR\nBEGIN\n   ${body}\n   D\nEND_FUNCTION_BLOCK\n`;
    const offset = text.indexOf("\n   D") + "\n   D".length;
    const ctx = resolveSclCompletionContext(text, offset);
    assert.equal(ctx.kind, "executable");
  });
}

// Member completion after a QUOTED external base (`"R_TRIG_DB".`). Only
// `#tag.` chains were handled before, so a global instance DB -- the one way
// to reach an instance-dot instruction's members from outside a
// FUNCTION_BLOCK -- offered nothing at all.
{
  const q = "'";
  const dbBlockIndex = new BlockIndex();
  dbBlockIndex.rebuild([
    { path: "rt.scl", text: `DATA_BLOCK "R_TRIG_DB"\n{InstructionName := ${q}R_TRIG${q} }\nR_TRIG\nBEGIN\nEND_DATA_BLOCK\n` },
    { path: "ton.scl", text: `DATA_BLOCK "TON_DB"\n{InstructionName := ${q}TON_TIME${q} }\nTON_TIME\nBEGIN\nEND_DATA_BLOCK\n` },
    { path: "pdb.scl", text: `DATA_BLOCK "Pump_DB"\n{ }\nNON_RETAIN\n"FB_Pump"\nBEGIN\nEND_DATA_BLOCK\n` },
    { path: "fb.scl", text: 'FUNCTION_BLOCK "FB_Pump"\nVAR_INPUT\n  i_x : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n' },
  ]);
  const dbProvider = new S7dclCompletionProvider(ruleSet, dbBlockIndex, () => typeCache);
  const labelsAfter = (base) => {
    const body = `  ${base}`;
    const { document, position } = withCursor(`FUNCTION_BLOCK "C"\nVAR\nEND_VAR\nBEGIN\n${body}|\nEND_FUNCTION_BLOCK\n`, "s7scl");
    const items = dbProvider.provideCompletionItems(document, position);
    return (items ?? []).map((i) => i.label);
  };

  test("completion: instruction instance DB offers the instruction's members", () => {
    const labels = labelsAfter('"R_TRIG_DB".');
    // SCL spelling (CLK/Q), not the graphical registry's clk/q -- a quoted
    // instance-DB reference is SCL-only syntax.
    assert.deepEqual(labels, ["CLK", "Q"]);
  });

  test("completion: instance DB members use the SCL registry's parameter names", () => {
    assert.deepEqual(labelsAfter('"TON_DB".').sort(), ["ET", "IN", "PT", "Q"]);
  });

  test("completion: FB single-instance DB offers the FUNCTION_BLOCK's interface", () => {
    assert.deepEqual(labelsAfter('"Pump_DB".'), ["i_x"]);
  });

  test("completion: an unknown quoted base offers nothing", () => {
    assert.deepEqual(labelsAfter('"Nope_DB".'), []);
  });

  // Dotting into a BARE FUNCTION_BLOCK is illegal (dot-access-needs-instance).
  // Members are still offered, but accepting one must ALSO create an instance
  // and repoint the reference -- otherwise completion would hand the user code
  // TIA rejects.
  {
    const fbBase = '  "FB_Pump".';
    const src = `FUNCTION_BLOCK "Caller"\n{ S7_Optimized_Access := 'TRUE' }\nVAR\nEND_VAR\nBEGIN\n${fbBase}|\nEND_FUNCTION_BLOCK\n`;
    const { document, position } = withCursor(src, "s7scl");
    const items = dbProvider.provideCompletionItems(document, position) ?? [];

    test("completion: a bare FUNCTION_BLOCK still lists its members", () => {
      assert.deepEqual(items.map((i) => i.label), ["i_x"]);
    });

    test("completion: accepting a bare-FB member also generates a single-instance DB", () => {
      const edits = items[0].additionalTextEdits ?? [];
      assert.strictEqual(edits.length, 2, "one DB insertion + one base rewrite");
      assert.match(edits[0].newText, /DATA_BLOCK "FB_Pump_DB"/);
      assert.match(edits[0].newText, /^"FB_Pump"$/m, "the instance-of line is the quoted FB name");
      assert.ok(!edits[0].newText.includes("InstructionName"), "an FB instance DB has no InstructionName pragma");
      // S7_Optimized_Access mirrors the CALLING block's own header.
      assert.match(edits[0].newText, /S7_Optimized_Access := 'TRUE'/);
    });

    test("completion: the base reference is rewritten to the generated instance DB", () => {
      const rewrite = (items[0].additionalTextEdits ?? [])[1];
      assert.strictEqual(rewrite.newText, '"FB_Pump_DB"');
      // The replaced range must cover exactly the `"FB_Pump"` token.
      const replaced = document.getText(rewrite.range);
      assert.strictEqual(replaced, '"FB_Pump"');
    });

    test("completion: an instance DB base needs no auto-create edits", () => {
      const { document: d2, position: p2 } = withCursor(
        `FUNCTION_BLOCK "Caller"\nVAR\nEND_VAR\nBEGIN\n  "Pump_DB".|\nEND_FUNCTION_BLOCK\n`,
        "s7scl"
      );
      const dbItems = dbProvider.provideCompletionItems(d2, p2) ?? [];
      assert.ok(dbItems.length > 0, "an instance DB still offers members");
      assert.ok(!dbItems[0].additionalTextEdits, "already an instance -- nothing to create");
    });
  }
}

// `.member` completion off a LOCAL declaration, for both the `#tag.` and the
// bare `tag.` spelling TIA's importer accepts, across all four stores a
// member list can come from: a workspace FUNCTION_BLOCK, a UDT (type cache),
// a system-struct (system-types.yaml), an inline STRUCT, and an instruction
// instance (registry pins).
{
  const memberBlockIndex = new BlockIndex();
  memberBlockIndex.rebuild([
    { path: "inner.scl", text: 'FUNCTION_BLOCK "Inner"\nVAR_INPUT\n  InEnable : Bool;\nEND_VAR\nVAR_OUTPUT\n  OutDone : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n' },
  ]);
  const memberTypeCache = buildTypeCache(ruleSet, [
    {
      path: "hdr.udt",
      decls: [
        {
          name: "KDT_Header",
          line: 1,
          members: [
            { name: "Version", typeRef: { kind: "named", name: "BYTE", quoted: false, namespace: null }, line: 2 },
            { name: "Counter", typeRef: { kind: "named", name: "WORD", quoted: false, namespace: null }, line: 3 },
          ],
        },
      ],
    },
  ]);
  const memberProvider = new S7dclCompletionProvider(ruleSet, memberBlockIndex, () => memberTypeCache);

  const VARS = [
    "FUNCTION_BLOCK \"DotProbe\"",
    "VAR",
    "   SeqEdge : R_TRIG;",
    "   Tick    : TON;",
    '   Sub     : "Inner";',
    '   Hdr     : "KDT_Header";',
    "   Timer   : IEC_TIMER;",
    "   Local   : STRUCT",
    "                Alpha : Real;",
    "                Beta  : Int;",
    "             END_STRUCT;",
    "END_VAR",
    "BEGIN",
  ].join("\n");

  const labelsAfter = (base, languageId = "s7scl") => {
    const { document, position } = withCursor(`${VARS}\n   ${base}|\nEND_FUNCTION_BLOCK\n`, languageId);
    return (memberProvider.provideCompletionItems(document, position) ?? []).map(labelText);
  };

  test("completion: bare `tag.` offers the same members as `#tag.` for an instruction instance", () => {
    // The user-facing case: `SeqEdge.Q` must complete exactly like `#SeqEdge.Q`.
    // SCL parameter casing (CLK/Q), not the graphical registry's clk/q.
    assert.deepEqual(labelsAfter("SeqEdge."), ["CLK", "Q"]);
    assert.deepEqual(labelsAfter("#SeqEdge."), ["CLK", "Q"]);
  });

  test("completion: an instruction instance's own registry pins win over its same-named system-struct layout", () => {
    // R_TRIG is BOTH an instance-dot instruction and a system-struct whose
    // members are the raw layout (clk/q). Code addresses it as an instance.
    assert.deepEqual(labelsAfter("Tick.").sort(), ["ET", "IN", "PT", "Q"]);
  });

  test("completion: bare `tag.` on a local FUNCTION_BLOCK instance offers its interface", () => {
    assert.deepEqual(labelsAfter("Sub."), ["InEnable", "OutDone"]);
    assert.deepEqual(labelsAfter("#Sub."), ["InEnable", "OutDone"]);
  });

  test("completion: bare `tag.` on a UDT-typed tag offers the UDT's fields", () => {
    assert.deepEqual(labelsAfter("Hdr."), ["Version", "Counter"]);
    assert.deepEqual(labelsAfter("#Hdr."), ["Version", "Counter"]);
  });

  test("completion: bare `tag.` on a system-struct-typed tag offers its members", () => {
    assert.deepEqual(labelsAfter("Timer.").sort(), ["ET", "IN", "PT", "Q"]);
  });

  test("completion: bare `tag.` on an inline STRUCT offers the fields declared right there", () => {
    assert.deepEqual(labelsAfter("Local."), ["Alpha", "Beta"]);
    assert.deepEqual(labelsAfter("#Local."), ["Alpha", "Beta"]);
  });

  test("completion: a bare base that isn't declared offers nothing", () => {
    assert.deepEqual(labelsAfter("NotDeclaredAnywhere."), []);
  });

  test("completion: the bare `tag.` trigger is SCL-only", () => {
    // A `.s7dcl` RUNG is full of bare identifiers that are not tag references,
    // so the `#`-less spelling must not fire there.
    assert.deepEqual(labelsAfter("Sub.", "s7dcl"), []);
  });
}

// SCL scopes tags HARD between block declarations, and an authored `.scl`
// routinely bundles several in one file. A tag is only addressable inside the
// block that declares it, so completion must never offer (or dot into) a
// sibling declaration's tags -- that would complete code TIA rejects, and with
// two blocks declaring the same name could resolve the member list against the
// wrong declaration entirely.
{
  const scopeSrc = [
    'FUNCTION_BLOCK "First"',
    "VAR",
    "   OnlyInFirst : R_TRIG;",
    "   Shared      : Int;",
    "END_VAR",
    "BEGIN",
    "   /*FIRST*/",
    "END_FUNCTION_BLOCK",
    "",
    'FUNCTION_BLOCK "Second"',
    "VAR",
    "   OnlyInSecond : TON;",
    "   Shared       : Bool;",
    "END_VAR",
    "BEGIN",
    "   /*SECOND*/",
    "END_FUNCTION_BLOCK",
    "",
  ].join("\n");

  const at = (marker, typed) => {
    const { document, position } = withCursor(scopeSrc.replace(marker, `${typed}|`), "s7scl");
    return (provider.provideCompletionItems(document, position) ?? []).map(labelText);
  };

  test("scope: `#` lists only the enclosing block's own declarations", () => {
    assert.deepEqual(at("/*FIRST*/", "#"), ["OnlyInFirst", "Shared"]);
    assert.deepEqual(at("/*SECOND*/", "#"), ["OnlyInSecond", "Shared"]);
  });

  test("scope: dot access into a SIBLING block's tag offers nothing", () => {
    // `OnlyInSecond` is declared three lines further down, in another block --
    // referencing it here is an undeclared identifier, so there is nothing
    // legal to complete.
    assert.deepEqual(at("/*FIRST*/", "OnlyInSecond."), []);
    assert.deepEqual(at("/*FIRST*/", "#OnlyInSecond."), []);
    assert.deepEqual(at("/*SECOND*/", "OnlyInFirst."), []);
    assert.deepEqual(at("/*SECOND*/", "#OnlyInFirst."), []);
  });

  test("scope: dot access into the enclosing block's own tag still works", () => {
    assert.deepEqual(at("/*FIRST*/", "OnlyInFirst."), ["CLK", "Q"]);
    assert.deepEqual(at("/*SECOND*/", "OnlyInSecond.").sort(), ["ET", "IN", "PT", "Q"]);
  });

  test("scope: a name declared in BOTH blocks resolves against the enclosing one", () => {
    // `Shared` is Int in First and Bool in Second. The flat, whole-file map
    // can only hold one of them, so the type shown here is the check that
    // completion really is reading the enclosing block's own declaration.
    const { document: d1, position: p1 } = withCursor(scopeSrc.replace("/*FIRST*/", "#|"), "s7scl");
    const { document: d2, position: p2 } = withCursor(scopeSrc.replace("/*SECOND*/", "#|"), "s7scl");
    const detailOf = (doc, pos) =>
      (provider.provideCompletionItems(doc, pos) ?? []).find((i) => labelText(i) === "Shared").detail;
    assert.equal(detailOf(d1, p1), "Int");
    assert.equal(detailOf(d2, p2), "Bool");
  });

  test("scope: the bare-identifier list is scoped too, while instructions stay global", () => {
    const inFirst = at("/*FIRST*/", "Only");
    assert.ok(inFirst.includes("OnlyInFirst"), "the enclosing block's own tag is offered");
    assert.ok(!inFirst.includes("OnlyInSecond"), "a sibling block's tag is not");
    assert.ok(at("/*FIRST*/", "AB").includes("ABS"), "the instruction catalog is file-independent");
  });
}

test("context: a real END_FUNCTION_BLOCK still returns to root", () => {
  const text = 'FUNCTION_BLOCK "X"\nVAR\nEND_VAR\nBEGIN\n   IF #a THEN\n      #b := 1;\n   END_IF;\nEND_FUNCTION_BLOCK\n\n';
  const ctx = resolveSclCompletionContext(text, text.length);
  assert.equal(ctx.kind, "root");
});

test("context: after a completed declaration ending in ';' -> name (fresh)", () => {
  const text = "FUNCTION_BLOCK \"X\"\nVAR_TEMP\n   a : Int;\n   \nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n";
  const offset = text.indexOf("a : Int;") + "a : Int;\n   ".length;
  const ctx = resolveSclCompletionContext(text, offset);
  assert.equal(ctx.kind, "declaration");
  assert.equal(ctx.decl.kind, "name");
});

// --- End-to-end provider tests -------------------------------------------

test("VAR_INPUT / inputValue : -> legal input datatypes only (no Array-illegal-elsewhere leakage check, but has Real/Int)", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR_INPUT\n   inputValue :|\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const ls = labels(items);
  assert.ok(ls.includes("Real"), "expected Real");
  assert.ok(ls.includes("Int"), "expected Int");
  assert.ok(!ls.includes("UserDefined"), "must not suggest UDT names as bare identifiers");
});

test("VAR_TEMP / temporaryValue : Re -> matching legal built-in datatypes (Real), replacing 'Re'", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR_TEMP\n   temporaryValue : Re|\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const real = items.find((i) => i.label === "Real");
  assert.ok(real, "expected a Real completion");
  assert.equal(real.insertText, "Real;");
  const startOff = document.offsetAt(real.range.start);
  const endOff = document.offsetAt(real.range.end);
  assert.equal(document.getText().slice(startOff, endOff), "Re");
});

test("VAR / instanceValue : \" -> user-defined types only, none of the built-ins", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR\n   instanceValue : "|\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const ls = labels(items);
  assert.deepEqual(ls, ["UserDefined"]);
  assert.equal(items[0].insertText, 'UserDefined";');
});

test("VAR_CONSTANT / c : \" -> NO user-defined type suggestions (Struct illegal in Constant)", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR_CONSTANT\n   c : "|\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.deepEqual(items, []);
});

test("VAR_OUTPUT / values : Array[1..4] of R -> legal built-in array element types", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR_OUTPUT\n   values : Array[1..4] of R|\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const real = items.find((i) => i.label === "Real");
  assert.ok(real, "expected Real as an array element type");
  assert.ok(!items.some((i) => i.label === "Array"), "nested array must never be offered");
});

test("Accepting Real for 'Array[1..4] of R' produces 'Array[1..4] of Real;'", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR_OUTPUT\n   values : Array[1..4] of R|;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const real = items.find((i) => i.label === "Real");
  // Simulate acceptance: replace real.range with real.insertText.
  const startOff = document.offsetAt(real.range.start);
  const endOff = document.offsetAt(real.range.end);
  const full = document.getText();
  const result = full.slice(0, startOff) + real.insertText + full.slice(endOff);
  assert.ok(result.includes("values : Array[1..4] of Real;"), result);
  assert.ok(!result.includes(";;"), "must not duplicate the already-present semicolon");
});

test("VAR_INPUT / values : Array[1..4] of \" -> legal user-defined array element types", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR_INPUT\n   values : Array[1..4] of "|\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.deepEqual(labels(items), ["UserDefined"]);
});

test("Accepting UserDefined for 'Array[1..4] of \"' produces 'Array[1..4] of \"UserDefined\";'", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR_INPUT\n   values : Array[1..4] of "|\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const item = items[0];
  const startOff = document.offsetAt(item.range.start);
  const endOff = document.offsetAt(item.range.end);
  const full = document.getText();
  const result = full.slice(0, startOff) + item.insertText + full.slice(endOff);
  assert.ok(result.includes('values : Array[1..4] of "UserDefined";'), result);
});

test("VAR / struct_test : Str -> offers a Struct snippet (not a bare 'Struct;')", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR\n   struct_test : Str|\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const struct = items.find((i) => i.label === "Struct");
  assert.ok(struct, "expected a Struct completion");
  assert.ok(struct.insertText instanceof vscode.SnippetString, "Struct must insert a snippet, not a plain string");
});

test("Accepting Struct generates a correctly indented END_STRUCT; scaffold (3-space indent)", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR\n   struct_test : Str|\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const struct = items.find((i) => i.label === "Struct");
  const result = simulateAccept(document, struct);
  const expected = ["   struct_test : Struct", "      ${1:member} : ${2:Bool};$0", "   END_STRUCT;"].join("\n");
  assert.ok(result.includes(expected), result);
});

test("Accepting Struct matches the file's own TAB indentation convention", () => {
  const fixture = 'FUNCTION_BLOCK "X"\nVAR\n\tstruct_test : Str|\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n';
  const { document, position } = withCursor(fixture, "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const struct = items.find((i) => i.label === "Struct");
  const result = simulateAccept(document, struct);
  const expected = ["\tstruct_test : Struct", "\t\t${1:member} : ${2:Bool};$0", "\tEND_STRUCT;"].join("\n");
  assert.ok(result.includes(expected), result);
});

test("Struct is never offered where section-legality forbids it (VAR_CONSTANT)", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR_CONSTANT\n   c : Str|\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.ok(!items.some((i) => i.label === "Struct"), "Struct must not be offered in VAR_CONSTANT");
});

test("Completing inside an ALREADY-CLOSED nested Struct's sibling member still works (real nesting regression)", () => {
  const fixture = [
    'FUNCTION_BLOCK "X"',
    "VAR",
    "   struct_test : Struct",
    "      var1 : Bool;",
    "      var2 : Bool;",
    "      struct_nested : Struct",
    "         var1 : Bool;",
    "      END_STRUCT;",
    '      var3 : R|',
    "   END_STRUCT;",
    "END_VAR",
    "BEGIN",
    "END_FUNCTION_BLOCK",
    "",
  ].join("\n");
  const { document, position } = withCursor(fixture, "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const real = items.find((i) => i.label === "Real");
  assert.ok(real, "expected Real to be offered for var3's type, after the nested struct closes");
});

test("Completing a NESTED struct's own first member's type works", () => {
  const fixture = [
    'FUNCTION_BLOCK "X"',
    "VAR",
    "   struct_test : Struct",
    "      struct_nested : Struct",
    "         var1 : R|",
    "      END_STRUCT;",
    "   END_STRUCT;",
    "END_VAR",
    "BEGIN",
    "END_FUNCTION_BLOCK",
    "",
  ].join("\n");
  const { document, position } = withCursor(fixture, "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const real = items.find((i) => i.label === "Real");
  assert.ok(real, "expected Real to be offered for the nested struct's own var1");
});

test("BEGIN / my -> instructions and local symbols ARE suggested", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR\n   myTag : Int;\nEND_VAR\nBEGIN\n   my|\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.ok(items && items.length > 0, "expected instruction suggestions inside BEGIN body");
});

test("BEGIN, bare identifier -> local tags and FB/timer instances are offered alongside instructions, each labelled with its own plane", () => {
  const fixture = [
    'FUNCTION_BLOCK "X"',
    "VAR",
    "   myTag : Int;",
    "   myTimer : TON;",
    "END_VAR",
    "BEGIN",
    "   my|",
    "END_FUNCTION_BLOCK",
    "",
  ].join("\n");
  const { document, position } = withCursor(fixture, "s7scl");
  const items = provider.provideCompletionItems(document, position);

  const tag = items.find((i) => labelText(i) === "myTag");
  const instance = items.find((i) => labelText(i) === "myTimer");
  const instruction = items.find((i) => labelText(i) === "ABS");
  assert.ok(tag, "a bare identifier must offer this block's own declared tags -- TIA resolves them without the '#'");
  assert.ok(instance, "...including instance tags");
  assert.ok(instruction, "...without dropping the instruction catalog");

  assert.equal(labelDescription(tag), "local tag");
  assert.equal(labelDescription(instance), "local instance");
  assert.equal(labelDescription(instruction), "TIA instruction");
  assert.equal(tag.kind, vscode.CompletionItemKind.Variable);
  assert.equal(instance.kind, vscode.CompletionItemKind.Class);
  assert.notEqual(instance.kind, tag.kind, "an instance and a plain variable must be visually distinct from each other");
  assert.notEqual(instance.kind, instruction.kind, "an instance and a TIA instruction must be visually distinct from each other");
  assert.ok(tag.sortText < instruction.sortText, "names actually in scope sort above the ~500-entry instruction catalog");
});

test("'#' trigger -> local instances are still visually distinct from plain tags", () => {
  const fixture = [
    'FUNCTION_BLOCK "X"',
    "VAR",
    "   myTag : Int;",
    "   myTimer : TON;",
    "END_VAR",
    "BEGIN",
    "   #|",
    "END_FUNCTION_BLOCK",
    "",
  ].join("\n");
  const { document, position } = withCursor(fixture, "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const tag = items.find((i) => labelText(i) === "myTag");
  const instance = items.find((i) => labelText(i) === "myTimer");
  assert.ok(tag && instance);
  assert.equal(tag.kind, vscode.CompletionItemKind.Variable);
  assert.equal(instance.kind, vscode.CompletionItemKind.Class);
});

test("BEGIN, FUNCTION_BLOCK, instance-dot instruction -> BOTH multi-instance and single-instance-DB completions offered, visually distinct", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR\nEND_VAR\nBEGIN\n   TONR|\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const multi = items.find((i) => labelText(i) === "TONR (local multi-instance)");
  const single = items.find((i) => labelText(i) === "TONR (single-instance DB)");
  assert.ok(multi, "expected a local multi-instance suggestion for TONR inside a FUNCTION_BLOCK");
  assert.ok(single, "expected a single-instance DB suggestion for TONR alongside it");
  assert.equal(multi.kind, vscode.CompletionItemKind.Constructor);
  assert.equal(single.kind, vscode.CompletionItemKind.Module);
  assert.notEqual(multi.kind, single.kind, "multi- and single-instance suggestions must be visually distinct from each other");
  assert.equal(multi.filterText, "TONR", "must still match on the plain instruction name while typing");
  assert.equal(single.filterText, "TONR");
});

test("BEGIN, FUNCTION (no Static section) -> only the single-instance-DB completion is offered", () => {
  const { document, position } = withCursor('FUNCTION "X" : Void\nBEGIN\n   TONR|\nEND_FUNCTION\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const multi = items.find((i) => labelText(i) === "TONR (local multi-instance)");
  const single = items.find((i) => labelText(i) === "TONR (single-instance DB)");
  assert.ok(!multi, "a FUNCTION has no Static section -- must never offer a local multi-instance");
  assert.ok(single, "single-instance DB generation must still be offered inside a FUNCTION");
  assert.equal(single.kind, vscode.CompletionItemKind.Module);
});

test("Declaration section (VAR_INPUT, name position) -> NO instruction/symbol suggestions at all", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR_INPUT\n   my|\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.deepEqual(items, [], "declaration-section name position must suggest nothing");
});

test("Inside Array[...] bounds -> no completions at all", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR\n   v : Array[1..|\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.deepEqual(items, []);
});

test("Already-typed leading space and trailing ';' are never duplicated", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR_TEMP\n   a : Re|;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const real = items.find((i) => i.label === "Real");
  assert.equal(real.insertText, "Real"); // no leading space (already had one), no ';' (already present)
});

test("No space after ':' gets exactly one space inserted", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR_TEMP\n   a :Re|\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const real = items.find((i) => i.label === "Real");
  assert.equal(real.insertText, " Real;");
});

// --- Top-level (source-file root) block-template completion -------------

const TOP_LEVEL_LABELS = ["FUNCTION_BLOCK", "FUNCTION", "ORGANIZATION_BLOCK", "DATA_BLOCK — Global", "DATA_BLOCK — FB Instance", "DATA_BLOCK — PLC Data Type", "TYPE — PLC Data Type"];

function snippetValue(item) {
  return item.insertText instanceof vscode.SnippetString ? item.insertText.value : item.insertText;
}

/** Strips this project's own (simple, non-nested, no `${n|choices|}`)
 * snippet placeholder syntax down to each placeholder's own default text --
 * good enough to simulate "what does the editor show right after
 * insertion, before anything is typed" for a test assertion, without
 * needing a real VS Code host. */
function renderSnippetDefaults(raw) {
  return raw.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\{0\}/g, "");
}

test("Empty source (validation case) -> all seven top-level block templates offered", () => {
  const { document, position } = withCursor("|", "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.deepEqual(new Set(labels(items)), new Set(TOP_LEVEL_LABELS));
});

test("Before the first top-level block -> root templates offered", () => {
  const { document, position } = withCursor('|\nFUNCTION "Existing" : Void\nBEGIN\nEND_FUNCTION\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.deepEqual(new Set(labels(items)), new Set(TOP_LEVEL_LABELS));
});

test("Between two completed top-level blocks -> root templates offered", () => {
  const { document, position } = withCursor('FUNCTION "A" : Void\nBEGIN\nEND_FUNCTION\n|\nFUNCTION "B" : Void\nBEGIN\nEND_FUNCTION\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.deepEqual(new Set(labels(items)), new Set(TOP_LEVEL_LABELS));
});

test("Immediately after an END_* terminator (same line) -> root templates offered", () => {
  const { document, position } = withCursor('FUNCTION "A" : Void\nBEGIN\nEND_FUNCTION|\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.ok(items.some((i) => i.label === "FUNCTION_BLOCK"));
});

test("After a completed block (validation case) -> all top-level templates", () => {
  const { document, position } = withCursor('FUNCTION "ExistingFC" : Void\nBEGIN\nEND_FUNCTION\n\n|\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.deepEqual(new Set(labels(items)), new Set(TOP_LEVEL_LABELS));
});

test("Inside a block body (validation case) -> no top-level block templates", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "ExistingFB"\nBEGIN\n   |\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  // `undefined` (nothing at all triggers the executable-body branch on a
  // bare, otherwise-empty line) is just as much "no root templates" as an
  // empty array -- both are pre-existing, valid returns from this same
  // executable-body path, unrelated to this request's own root-context work.
  assert.ok(!items || !items.some((i) => TOP_LEVEL_LABELS.includes(i.label)), "must not offer root templates inside a block body");
});

test("Inside a declaration section (validation case) -> no top-level block templates", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "ExistingFB"\n   VAR_INPUT\n      |\n   END_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.deepEqual(items, []);
});

test("Inside a block header, before VERSION/VAR/BEGIN -> no top-level block templates", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\n|\nVERSION : 0.1\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.deepEqual(items, []);
});

test("Inside an incomplete top-level block (no matching END_* yet) -> no top-level block templates", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\nVAR\n   |\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.deepEqual(items, []);
});

test("Inside a TYPE's own STRUCT body -> no top-level block templates", () => {
  const { document, position } = withCursor('TYPE "X"\nVERSION : 0.1\n   STRUCT\n      |\n   END_STRUCT;\nEND_TYPE\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.deepEqual(items, []);
});

test("A comment mentioning END_FUNCTION_BLOCK does not falsely reopen root state", () => {
  const { document, position } = withCursor('FUNCTION_BLOCK "X"\n// END_FUNCTION_BLOCK (not real)\n|\nBEGIN\nEND_FUNCTION_BLOCK\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.ok(!items.some((i) => i.label === "FUNCTION_BLOCK"), "still inside the FB's own header -- a comment's text must never be mistaken for its real END_FUNCTION_BLOCK closer");
});

test("A string literal containing END_FUNCTION_BLOCK text does not falsely reopen root state", () => {
  const { document, position } = withCursor("FUNCTION_BLOCK \"X\"\nVAR\n   s : String := 'END_FUNCTION_BLOCK';\n   |\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n", "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.ok(!items.some((i) => i.label === "FUNCTION_BLOCK"), "a string literal's own text must never be mistaken for a real closer either");
});

test("Replace typed prefix (validation case) -> 'func' is replaced, not appended to", () => {
  const { document, position } = withCursor("func|", "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const fb = items.find((i) => i.label === "FUNCTION_BLOCK");
  assert.ok(fb);
  assert.equal(document.getText(fb.range), "func", "range must span the already-typed prefix");
  const result = simulateAccept(document, fb);
  assert.ok(result.startsWith('FUNCTION_BLOCK "${1:ExampleFB}"'), "the prefix 'func' must be replaced by the template, not left in front of it");
  assert.ok(!result.startsWith("func"), "the typed prefix must not survive in front of the inserted template");
});

test("'fu' matches both FUNCTION and FUNCTION_BLOCK", () => {
  const { document, position } = withCursor("fu|", "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.ok(items.some((i) => i.label === "FUNCTION"));
  assert.ok(items.some((i) => i.label === "FUNCTION_BLOCK"));
});

test("'or' matches ORGANIZATION_BLOCK", () => {
  const { document, position } = withCursor("or|", "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.ok(items.some((i) => i.label === "ORGANIZATION_BLOCK"));
});

test("'da' matches all DATA_BLOCK variants", () => {
  const { document, position } = withCursor("da|", "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.ok(items.some((i) => i.label === "DATA_BLOCK — Global"));
  assert.ok(items.some((i) => i.label === "DATA_BLOCK — FB Instance"));
  assert.ok(items.some((i) => i.label === "DATA_BLOCK — PLC Data Type"));
});

test("'ty' matches the TYPE declaration", () => {
  const { document, position } = withCursor("ty|", "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.ok(items.some((i) => i.label === "TYPE — PLC Data Type"));
});

test("Accepting FUNCTION_BLOCK and typing a name replaces the placeholder, doesn't append to it", () => {
  const { document, position } = withCursor("|", "s7scl");
  const fb = provider.provideCompletionItems(document, position).find((i) => i.label === "FUNCTION_BLOCK");
  const rendered = renderSnippetDefaults(snippetValue(fb));
  assert.ok(rendered.startsWith('FUNCTION_BLOCK "ExampleFB"'));
  const typed = rendered.replace("ExampleFB", "MotorControl");
  assert.ok(typed.startsWith('FUNCTION_BLOCK "MotorControl"'));
  assert.ok(!typed.includes("ExampleFBMotorControl"));
  assert.ok(!typed.includes("ExampleFB"));
});

test("FUNCTION_BLOCK template matches the requested literal shape", () => {
  const { document, position } = withCursor("|", "s7scl");
  const fb = provider.provideCompletionItems(document, position).find((i) => i.label === "FUNCTION_BLOCK");
  assert.equal(
    snippetValue(fb),
    [
      'FUNCTION_BLOCK "${1:ExampleFB}"',
      "{ S7_Optimized_Access := 'TRUE' }",
      "VERSION : 0.1",
      "",
      "   VAR_INPUT",
      "   END_VAR",
      "",
      "   VAR_OUTPUT",
      "   END_VAR",
      "",
      "   VAR_IN_OUT",
      "   END_VAR",
      "",
      "   VAR",
      "   END_VAR",
      "",
      "   VAR_TEMP",
      "   END_VAR",
      "",
      "   VAR CONSTANT",
      "   END_VAR",
      "",
      "BEGIN",
      "${0}",
      "END_FUNCTION_BLOCK",
    ].join("\n")
  );
});

test("FUNCTION template matches the requested literal shape (no static VAR, return-type tab stop)", () => {
  const { document, position } = withCursor("|", "s7scl");
  const fc = provider.provideCompletionItems(document, position).find((i) => i.label === "FUNCTION");
  assert.equal(
    snippetValue(fc),
    [
      'FUNCTION "${1:ExampleFC}" : ${2:Void}',
      "{ S7_Optimized_Access := 'TRUE' }",
      "VERSION : 0.1",
      "",
      "   VAR_INPUT",
      "   END_VAR",
      "",
      "   VAR_OUTPUT",
      "   END_VAR",
      "",
      "   VAR_IN_OUT",
      "   END_VAR",
      "",
      "   VAR_TEMP",
      "   END_VAR",
      "",
      "   VAR CONSTANT",
      "   END_VAR",
      "",
      "BEGIN",
      "${0}",
      "END_FUNCTION",
    ].join("\n")
  );
});

test("ORGANIZATION_BLOCK template matches the requested literal shape (no VAR_INPUT/OUTPUT/IN_OUT/static VAR)", () => {
  const { document, position } = withCursor("|", "s7scl");
  const ob = provider.provideCompletionItems(document, position).find((i) => i.label === "ORGANIZATION_BLOCK");
  assert.equal(
    snippetValue(ob),
    [
      'ORGANIZATION_BLOCK "${1:ExampleOB}"',
      "{ S7_Optimized_Access := 'TRUE' }",
      "VERSION : 0.1",
      "",
      "   VAR_TEMP",
      "   END_VAR",
      "",
      "   VAR CONSTANT",
      "   END_VAR",
      "",
      "BEGIN",
      "${0}",
      "END_ORGANIZATION_BLOCK",
    ].join("\n")
  );
});

test("Global DATA_BLOCK template matches the requested literal shape (own VAR structure, no code-block sections)", () => {
  const { document, position } = withCursor("|", "s7scl");
  const db = provider.provideCompletionItems(document, position).find((i) => i.label === "DATA_BLOCK — Global");
  assert.equal(
    snippetValue(db),
    ['DATA_BLOCK "${1:ExampleDB}"', "{ S7_Optimized_Access := 'TRUE' }", "VERSION : 0.1", "", "   VAR", "${0}", "   END_VAR", "", "BEGIN", "", "END_DATA_BLOCK"].join("\n")
  );
});

test("FB-instance DATA_BLOCK template matches the requested literal shape (no VAR section, quotes auto-closed)", () => {
  const { document, position } = withCursor("|", "s7scl");
  const db = provider.provideCompletionItems(document, position).find((i) => i.label === "DATA_BLOCK — FB Instance");
  assert.equal(
    snippetValue(db),
    ['DATA_BLOCK "${1:ExampleInstanceDB}"', "{ S7_Optimized_Access := 'TRUE' }", "VERSION : 0.1", "NON_RETAIN", '"${2:ReferencedFB}"', "BEGIN", "${0}", "END_DATA_BLOCK"].join("\n")
  );
});

test("PLC-data-type-based DATA_BLOCK template matches the requested literal shape (separate from the FB-instance one)", () => {
  const { document, position } = withCursor("|", "s7scl");
  const db = provider.provideCompletionItems(document, position).find((i) => i.label === "DATA_BLOCK — PLC Data Type");
  assert.equal(
    snippetValue(db),
    ['DATA_BLOCK "${1:ExampleTypedDB}"', "{ S7_Optimized_Access := 'TRUE' }", "VERSION : 0.1", "NON_RETAIN", '"${2:ReferencedType}"', "BEGIN", "${0}", "END_DATA_BLOCK"].join("\n")
  );
});

test("TYPE template matches the requested literal shape (STRUCT/END_STRUCT;/END_TYPE, no VAR section)", () => {
  const { document, position } = withCursor("|", "s7scl");
  const ty = provider.provideCompletionItems(document, position).find((i) => i.label === "TYPE — PLC Data Type");
  assert.equal(snippetValue(ty), ['TYPE "${1:ExampleType}"', "VERSION : 0.1", "", "   STRUCT", "${0}", "   END_STRUCT;", "", "END_TYPE"].join("\n"));
});

test("FUNCTION return-type position offers Void and other built-in datatypes", () => {
  const { document, position } = withCursor('FUNCTION "X" : |\nBEGIN\nEND_FUNCTION\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.ok(items.some((i) => i.label === "Void"));
  assert.ok(items.some((i) => i.label === "Real"));
  assert.ok(items.some((i) => i.label === "Int"));
});

test("FUNCTION return-type position, partial 'Re' -> Real still matches, no duplicate space", () => {
  const { document, position } = withCursor('FUNCTION "X" : Re|\nBEGIN\nEND_FUNCTION\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  const real = items.find((i) => i.label === "Real");
  assert.ok(real);
  assert.equal(real.insertText, "Real");
});
test("FUNCTION return-type completion remains available when the cursor splits an identifier", () => {
  const { document, position } = withCursor('FUNCTION "X" : Int|eger\nVERSION : 0.1\nBEGIN\nEND_FUNCTION\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.ok(items.some((i) => i.label === "Int"));
});

test("FUNCTION return-type position is NOT offered once the return type is already complete", () => {
  const { document, position } = withCursor('FUNCTION "X" : Void|\nVERSION : 0.1\nBEGIN\nEND_FUNCTION\n', "s7scl");
  const items = provider.provideCompletionItems(document, position);
  assert.ok(!items.some((i) => i.label === "Void" || i.label === "Real"), "the return-type slot is already closed once something follows it");
});

// --- Referenced-symbol placeholder filtering (FB-instance vs typed DB) --

const blockIndex2 = new BlockIndex();
blockIndex2.rebuild([
  { path: "motor.scl", text: 'FUNCTION_BLOCK "MotorControl"\nBEGIN\nEND_FUNCTION_BLOCK\n' },
  { path: "flow.scl", text: 'FUNCTION "CalculateFlow" : Void\nBEGIN\nEND_FUNCTION\n' },
]);
const typeCache2 = buildTypeCache(ruleSet, [{ path: "motor.udt", decls: [{ name: "MotorData", members: [], line: 1 }] }]);
const provider2 = new S7dclCompletionProvider(ruleSet, blockIndex2, () => typeCache2);

test("Instance DB symbol filtering (validation case): FB-instance placeholder -> only MotorControl", () => {
  const { document, position } = withCursor(
    'DATA_BLOCK "X"\n{ S7_Optimized_Access := \'TRUE\' }\nVERSION : 0.1\nNON_RETAIN\n"ReferencedFB|"\nBEGIN\nEND_DATA_BLOCK\n',
    "s7scl"
  );
  const items = provider2.provideCompletionItems(document, position);
  assert.deepEqual(labels(items), ["MotorControl"]);
});

test("Instance DB symbol filtering (validation case): typed-DB placeholder -> only MotorData", () => {
  const { document, position } = withCursor(
    'DATA_BLOCK "X"\n{ S7_Optimized_Access := \'TRUE\' }\nVERSION : 0.1\nNON_RETAIN\n"ReferencedType|"\nBEGIN\nEND_DATA_BLOCK\n',
    "s7scl"
  );
  const items = provider2.provideCompletionItems(document, position);
  assert.deepEqual(labels(items), ["MotorData"]);
});

test("Referenced-symbol slot, real typed prefix (placeholder signal gone) -> both FB and UDT offered, never the FC", () => {
  const { document, position } = withCursor('DATA_BLOCK "X"\n{ S7_Optimized_Access := \'TRUE\' }\nVERSION : 0.1\nNON_RETAIN\n"Motor|"\nBEGIN\nEND_DATA_BLOCK\n', "s7scl");
  const items = provider2.provideCompletionItems(document, position);
  const ls = labels(items);
  assert.ok(ls.includes("MotorControl"));
  assert.ok(ls.includes("MotorData"));
  assert.ok(!ls.includes("CalculateFlow"), "an FC must never be a legal DATA_BLOCK structure source");
});

test("Referenced-symbol slot preserves exactly one pair of quotes when replacing the placeholder", () => {
  const { document, position } = withCursor(
    'DATA_BLOCK "X"\n{ S7_Optimized_Access := \'TRUE\' }\nVERSION : 0.1\nNON_RETAIN\n"ReferencedFB|"\nBEGIN\nEND_DATA_BLOCK\n',
    "s7scl"
  );
  const items = provider2.provideCompletionItems(document, position);
  const motorControl = items.find((i) => i.label === "MotorControl");
  assert.ok(motorControl);
  assert.equal(motorControl.insertText, "MotorControl", "no quote baked into insertText -- the surrounding quotes are fixed, untouched snippet text");
  const result = simulateAccept(document, motorControl);
  const line = result.split("\n").find((l) => l.includes("MotorControl"));
  assert.equal(line, '"MotorControl"', "exactly one pair of quotes must remain, no duplication");
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
