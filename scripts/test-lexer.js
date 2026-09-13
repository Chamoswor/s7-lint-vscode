// Regression tests for the shared lexer's sign handling and for the
// literal-run rules that re-join the tokens it splits. A `+`/`-` touching a
// digit is the binary operator after anything that ends an operand (`4-1`,
// `#a-1`, `#arr[1]-1`) and the sign of that number everywhere else
// (`:= -1`, `(-1)`, `Array[-5..-1]`, `int#-32768`). Folding the sign
// unconditionally used to turn `4-1` into two numbers and report a missing
// semicolon.
"use strict";
const assert = require("assert").strict;
const { Lexer, TokenCursor } = require("../out/parser/lexer");
const { literalRunLength } = require("../out/parser/literalRun");

function tokenShape(text) {
  return new Lexer(text)
    .tokenize()
    .filter((t) => t.kind !== "eof")
    .map((t) => `${t.kind}:${t.text}`);
}

function expectTokens(text, expected) {
  assert.deepEqual(tokenShape(text), expected, `tokens of ${JSON.stringify(text)}`);
}

// --- binary operator: the token before it ends an operand ------------------
expectTokens("4-1", ["number:4", "punct:-", "number:1"]);
expectTokens("4+1", ["number:4", "punct:+", "number:1"]);
expectTokens("#a-1", ["ident:#a", "punct:-", "number:1"]);
expectTokens("#a -1", ["ident:#a", "punct:-", "number:1"]);
expectTokens("#arr[1]-1", ["ident:#arr", "punct:[", "number:1", "punct:]", "punct:-", "number:1"]);
expectTokens("(#a)-1", ["punct:(", "ident:#a", "punct:)", "punct:-", "number:1"]);
expectTokens("#ref^-1", ["ident:#ref", "punct:^", "punct:-", "number:1"]);
expectTokens('"Tag"-1', ['string:"Tag"', "punct:-", "number:1"]);
expectTokens("16#FF-1", ["number:16", "ident:#FF", "punct:-", "number:1"]);

// --- sign: anything else before it -----------------------------------------
expectTokens("-1", ["number:-1"]);
expectTokens("#a := -1", ["ident:#a", "op::=", "number:-1"]);
expectTokens("(-1)", ["punct:(", "number:-1", "punct:)"]);
expectTokens("#a * -2", ["ident:#a", "punct:*", "number:-2"]);
expectTokens("#a - -2", ["ident:#a", "punct:-", "number:-2"]);
expectTokens("#a <= +2", ["ident:#a", "op:<=", "number:+2"]);
expectTokens("F(1, -1)", ["ident:F", "punct:(", "number:1", "punct:,", "number:-1", "punct:)"]);
expectTokens("#a AND -1", ["ident:#a", "ident:AND", "number:-1"]);
expectTokens("TO -1 BY -1", ["ident:TO", "number:-1", "ident:BY", "number:-1"]);
expectTokens("OF -1:", ["ident:OF", "number:-1", "punct::"]);
expectTokens("Array[-5..-1]", ["ident:Array", "punct:[", "number:-5", "punct:.", "punct:.", "number:-1", "punct:]"]);
expectTokens("int#-32768", ["ident:int", "ident:#", "number:-32768"]);
expectTokens("T#-10s", ["ident:T", "ident:#", "number:-10", "ident:s"]);

// --- literal runs still re-join every split literal ------------------------
function leadingLiteral(text) {
  const tokens = new Lexer(text).tokenize();
  const length = literalRunLength(new TokenCursor(tokens), 0);
  return tokens
    .slice(0, length)
    .map((t) => t.text)
    .join("");
}

for (const literal of [
  "DATE#1995-11-11",
  "D#2026-1-1",
  "DT#95-01-01-12:12:12.2",
  "LDT#2008-10-25-08:12:34.567",
  "TOD#11:11:11",
  "3.0E+10",
  "2E-3",
  "1.5e-3",
  "REAL#1.5E-3",
  "int#-32768",
  "T#-10s",
  "T#0.0s",
  "-3.4",
  "16#FF",
  "W#16#00FF",
]) {
  assert.equal(leadingLiteral(literal), literal, `${literal} lexes back into one literal run`);
}

// A subtraction right after a literal is not swallowed into it.
assert.equal(leadingLiteral("4-1"), "4");
assert.equal(leadingLiteral("1.5-1"), "1.5");
assert.equal(leadingLiteral("16#FF-1"), "16#FF");
assert.equal(leadingLiteral("16#1E-3"), "16#1E", "a hex digit E followed by -3 is a subtraction, not an exponent");

console.log("Lexer sign handling and literal-run regressions passed.");
