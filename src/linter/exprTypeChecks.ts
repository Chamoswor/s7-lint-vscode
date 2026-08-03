// SCL assignment-expression type checking: arithmetic/logical/comparison
// operand domain compatibility, implicit numeric-conversion warnings, and
// explicit-conversion-function argument types -- the first real operator
// type-inference this project does (see parser/s7dclParser.ts's own
// "SCL assignment-expression parsing" section header for why nothing
// upstream of this ever built a real expression tree before).
//
// Domain model: every concrete base type is classified into a coarse
// "domain" (numeric/time/bool/bit-string) via type-registry/
// expression-operators.yaml's `categoryToDomain`, itself keyed off
// base-types.yaml's own `category` field -- never a hand-rolled type list.
// A type whose category has no domain entry (character/string/date-time/
// system/complex) simply can't be evaluated by this checker at all; an
// expression touching one resolves to `null` (see `ExprEval`) and is left
// unchecked, never guessed.
//
// Error propagation ("poison" -- see `evalExpr`'s own comment): once ANY
// sub-expression fails to resolve a type (either because a domain rule was
// violated and already reported, or because an operand/call couldn't be
// resolved at all -- undeclared, wrong shape, etc., someone ELSE's
// diagnostic to report) its own `ExprEval.typeName` is `null`. A binary/
// unary node with a `null` child is NEVER itself checked against a domain
// rule (its own result is also `null`, propagating upward) -- this is what
// keeps `(#v_real + #v_time) * 2.0` down to exactly ONE diagnostic (the
// inner `+`) instead of a second, misleading one for the outer `*`.
import { BlockIndex } from "../analysis/blockIndex";
import { resolveOperandRef } from "../analysis/symbolTable";
import { TypeCacheResult } from "../cache/typeCache";
import { ParsedBlockFile, SclAssignmentExpr, SclExprNode } from "../parser/s7dclParser";
import { typeRefTopLevelName } from "../parser/typeRef";
import { expandPinDataTypes, resolveTypeAlias } from "../rules/literalTypes";
import { InstructionEntry, RuleSet } from "../rules/types";
import { formatDiagnostic, LintDiagnostic } from "./diagnostics";

interface EvalContext {
  block: ParsedBlockFile;
  blockIndex: BlockIndex;
  typeCache: TypeCacheResult;
  ruleSet: RuleSet;
}

interface ExprEval {
  /** Canonical base-types.yaml type name, or `null` when this node's type
   * couldn't be confidently resolved OR a domain-rule violation was
   * already reported somewhere inside it -- see this file's own header on
   * propagation. Never guessed. */
  typeName: string | null;
  /** True only for a bare, untyped integer literal (`5`, not `5.0`/
   * `W#16#0005`/a declared Int variable) -- IEC 61131-3 leaves such a
   * literal's type to context, so it's exempt from the
   * `expr-implicit-numeric-conversion` warning (comparing/combining it
   * with ANY numeric variable is never flagged), while still
   * participating normally in domain checks (a bare integer literal next
   * to a Bool/Time operand is still a real domain mismatch). */
  looseIntLiteral?: boolean;
  /** True only for the `NULL` literal -- references.yaml's own comparison
   * rule (a Reference is comparable ONLY against NULL) needs to recognize
   * this specifically, since NULL's own `typeName` is `null` (no fixed
   * type of its own) same as any other unresolvable operand would be. */
  isNullLiteral?: boolean;
}

const TYPED_LITERAL_PREFIX_TO_TYPE: Record<string, string> = {
  T: "Time",
  TIME: "Time",
  LT: "LTime",
  LTIME: "LTime",
  S5T: "S5Time",
  S5TIME: "S5Time",
  D: "Date",
  DATE: "Date",
  DT: "Date_And_Time",
  DATE_AND_TIME: "Date_And_Time",
  TOD: "Time_Of_Day",
  TIME_OF_DAY: "Time_Of_Day",
  LTOD: "LTime_Of_Day",
  B: "Byte",
  W: "Word",
  DW: "DWord",
};

/** Infers a literal's canonical type from its own raw text (as captured by
 * parser/s7dclParser.ts's `peekLiteralRunLength`) -- `TRUE`/`FALSE` ->
 * `Bool`; a letter-prefixed typed literal (`T#10ms`, `W#16#00FF`, ...) ->
 * that prefix's type (`TYPED_LITERAL_PREFIX_TO_TYPE`); a bare number
 * containing `.` -> `Real`; a bare integer -> `Int`, flagged
 * `looseIntLiteral` (see `ExprEval`'s own comment). `NULL`/`ZERO` and a
 * `P#` pointer literal (never a legal arithmetic/logical/comparison
 * operand) resolve to `{ typeName: null }` -- nothing to check, not an
 * error either. */
function evalLiteral(raw: string): ExprEval {
  if (/^(TRUE|FALSE)$/i.test(raw)) return { typeName: "Bool" };
  if (/^NULL$/i.test(raw)) return { typeName: null, isNullLiteral: true };

  const prefixMatch = /^([A-Za-z_]+)#/.exec(raw);
  if (prefixMatch) {
    const mapped = TYPED_LITERAL_PREFIX_TO_TYPE[prefixMatch[1].toUpperCase()];
    return { typeName: mapped ?? null };
  }

  if (/^[+-]?\d+\.\d+$/.test(raw)) return { typeName: "Real" };
  if (/^[+-]?\d+$/.test(raw)) return { typeName: "Int", looseIntLiteral: true };

  return { typeName: null };
}

/** Same "SCL-first, shared-fallback" precedence
 * linter/sclInstructionChecks.ts's own `findEntry` uses, kept as its own
 * tiny copy here rather than imported -- this checker only ever needs the
 * entry's `pins[0]`/`result` for a conversion-function argument check, not
 * `findEntry`'s fuller `FoundEntry` (registryKey/source) shape that
 * function's OTHER callers need for `required`-flag relaxation. */
function findInstructionEntry(ruleSet: RuleSet, name: string): InstructionEntry | undefined {
  return ruleSet.sclInstructions[name] ?? ruleSet.instructions[name];
}

/** Which VAR_* section (this parser's own keyword, e.g. `VAR_TEMP`)
 * declares `tagName` in `block`, or `undefined` if it isn't a local
 * declaration this parser can see (a global PLC tag, an absolute address,
 * or genuinely not declared here). Mirrors
 * linter/sclInstructionChecks.ts's own `resolveDeclaredSection` (kept as
 * its own tiny copy for the same reason `findInstructionEntry` above is --
 * that function isn't exported, and this one's needs are simpler: just
 * the section keyword, not memory.yaml's own declarationMapping). */
function resolveDeclaredVarSection(block: ParsedBlockFile, tagName: string): string | undefined {
  for (const section of block.varSections) {
    if (section.members.some((m) => m.name === tagName)) return section.kind;
  }
  return undefined;
}

/** references.yaml's `refInstruction.legalTargets`: `REF(<tag>)`'s target
 * must be a global DB tag or a Static-section (`VAR`) tag -- never
 * VAR_TEMP, a block's own formal parameter (VAR_INPUT/OUTPUT/IN_OUT), or
 * VAR_CONSTANT (the "memory area must be OPTIMIZED" half of the rule
 * isn't checked -- this project has no per-tag memory-area data for a
 * plain FB-local variable to compare against, only for a resolved
 * instruction PIN via system-registry/memory.yaml's declarationMapping,
 * which doesn't apply here -- don't guess). Only checked for a single,
 * bare, LOCAL `#tag` argument (no `.member`, not an external `"DB".tag`
 * reference) -- an external/global-DB-tag argument is exactly the legal
 * case this rule allows, so it's left unchecked rather than guessed at
 * (this project has no cross-file memory-area data for THAT either).
 * REF()'s own result (a Reference) isn't otherwise modeled -- this
 * function exists solely for this one target-section check, not general
 * REF() call validation (that's linter/sclInstructionChecks.ts's job, and
 * REF() isn't a catalogued instruction there either). */
function evalRefInstruction(node: Extract<SclExprNode, { kind: "call" }>, ctx: EvalContext, diags: LintDiagnostic[]): ExprEval {
  for (const arg of node.args) evalExpr(arg, ctx, diags);

  if (node.args.length === 1) {
    const arg = node.args[0];
    if (arg.kind === "operand" && arg.ref.segments.length === 1 && !arg.ref.external) {
      const tagName = arg.ref.segments[0];
      const section = resolveDeclaredVarSection(ctx.block, tagName);
      if (section && section !== "VAR") {
        diags.push(formatDiagnostic(ctx.ruleSet, "expr-ref-illegal-target-section", node.line, node.col, { tagName, section }));
      }
    }
  }

  return { typeName: null };
}

/** Resolves an `operand` node's declared type via
 * analysis/symbolTable.ts's full chain resolution (same one
 * linter/sclInstructionChecks.ts's `resolveTagTypeName` already uses for
 * an analogous purpose), normalized through `resolveTypeAlias` so it
 * compares cleanly against base-types.yaml's canonical spelling.
 * `{ typeName: null }` for anything not confidently resolvable
 * (undeclared, an unresolved path step, an array/inline-struct with no
 * single top-level name) -- `checkUndeclaredIdentifiers` already reports
 * the undeclared case elsewhere; this checker never duplicates it. */
function evalOperand(node: Extract<SclExprNode, { kind: "operand" }>, ctx: EvalContext): ExprEval {
  const resolved = resolveOperandRef(node.ref.segments, ctx.block, ctx.blockIndex, ctx.typeCache, ctx.ruleSet, node.ref.external);
  if (resolved.kind !== "resolved") return { typeName: null };
  const name = typeRefTopLevelName(resolved.typeRef);
  return { typeName: name ? resolveTypeAlias(name, ctx.ruleSet) : null };
}

/** Resolves a `call` node's OWN result type (from its registry entry's
 * `result.dataTypes`, `kind: "value"` only -- a `kind: "none"`/
 * `"inferred"`/`"type-expression"` result isn't a fixed type this checker
 * can compare against, and isn't guessed), AND -- when the entry is a
 * single-argument explicit conversion (`pins.length === 1`) -- checks that
 * ONE argument's resolved type against the pin's own `dataTypes`, emitting
 * `expr-conversion-arg-type-mismatch` on a mismatch. The call's own result
 * type is returned regardless of whether the argument check passed (see
 * this file's own header: an argument-type error doesn't poison the
 * OUTER expression using this call's result -- TIA's own conversion
 * functions always produce their declared output type regardless of what
 * was actually passed in, so e.g. `#v_real + INT_TO_REAL(#v_time)`
 * reports exactly the one argument-type error, with the outer `+`
 * checked normally against Real). An unrecognized call name, or one with
 * no catalogued `result`, resolves to `{ typeName: null }` -- name/pin-
 * count validation is linter/sclInstructionChecks.ts's own job, not
 * duplicated here. */
function evalCall(node: Extract<SclExprNode, { kind: "call" }>, ctx: EvalContext, diags: LintDiagnostic[]): ExprEval {
  if (node.name.toUpperCase() === "REF") return evalRefInstruction(node, ctx, diags);

  const argEvals = node.args.map((a) => evalExpr(a, ctx, diags));

  const entry = findInstructionEntry(ctx.ruleSet, node.name);
  if (!entry) return { typeName: null };

  if (entry.pins.length === 1 && argEvals.length === 1 && argEvals[0].typeName) {
    const pin = entry.pins[0];
    if (pin.dataTypes && pin.dataTypes.length > 0) {
      const { skip, types } = expandPinDataTypes(pin.dataTypes, ctx.ruleSet);
      if (!skip && !types.has(argEvals[0].typeName)) {
        diags.push(
          formatDiagnostic(ctx.ruleSet, "expr-conversion-arg-type-mismatch", node.line, node.col, {
            name: node.name,
            expected: pin.dataTypes.join(", "),
            actualType: argEvals[0].typeName,
          })
        );
      }
    }
  }

  if (!entry.result || entry.result.kind !== "value" || !entry.result.dataTypes || entry.result.dataTypes.length !== 1) {
    return { typeName: null };
  }
  return { typeName: resolveTypeAlias(entry.result.dataTypes[0], ctx.ruleSet) };
}

/** The domain (numeric/time/bool/bit-string) `typeName` belongs to, via
 * expression-operators.yaml's `categoryToDomain` keyed off
 * base-types.yaml's own `category` -- `null` for a type whose category has
 * no domain entry (character/string/date-time/system/complex) OR isn't a
 * known base type at all; either way, nothing this checker can classify,
 * so the caller leaves it unchecked rather than guess. */
function domainOf(typeName: string, ruleSet: RuleSet): string | null {
  const category = ruleSet.baseTypes[typeName]?.category;
  if (!category) return null;
  return ruleSet.exprOperators.categoryToDomain[category] ?? null;
}

function domainPairAllowed(leftDomain: string, rightDomain: string, allowedPairs: [string, string][]): boolean {
  return allowedPairs.some(([a, b]) => (a === leftDomain && b === rightDomain) || (a === rightDomain && b === leftDomain));
}

/** Emits `expr-implicit-numeric-conversion`, attaching the right operand's
 * exact source span (`node.right`'s own `SclExprNode` position fields) as
 * `implicitConversionFix` -- see `LintDiagnostic`'s own comment on that
 * field. `leftType`/`rightType` are passed in already-resolved (never
 * `null` here -- both call sites only reach this after confirming
 * `left.typeName`/`right.typeName` are set). */
function pushImplicitConversionWarning(
  node: Extract<SclExprNode, { kind: "binary" }>,
  leftType: string,
  rightType: string,
  ctx: EvalContext,
  diags: LintDiagnostic[]
): void {
  const diag = formatDiagnostic(ctx.ruleSet, "expr-implicit-numeric-conversion", node.line, node.col, { op: node.op, leftType, rightType });
  diag.implicitConversionFix = {
    leftType,
    rightType,
    rightLine: node.right.line,
    rightCol: node.right.col,
    rightEndLine: node.right.endLine,
    rightEndCol: node.right.endCol,
  };
  diags.push(diag);
}

/** Evaluates one binary operator node: resolves both operands (always --
 * even once one side is already known to fail, so every OTHER independent
 * error in the same expression still gets reported, not just the first),
 * then -- only if BOTH sides resolved a type -- classifies the operator
 * into arithmetic/logical/comparison and checks the two operands' domains
 * against expression-operators.yaml's rules for that category. Returns
 * `{ typeName: null }` whenever either side is unresolved OR a domain
 * violation fires here -- poisoning this node for any OUTER operator (see
 * file header). */
function evalBinary(node: Extract<SclExprNode, { kind: "binary" }>, ctx: EvalContext, diags: LintDiagnostic[]): ExprEval {
  const left = evalExpr(node.left, ctx, diags);
  const right = evalExpr(node.right, ctx, diags);

  // references.yaml's comparison rule: a Reference is comparable ONLY
  // against NULL, never anything else (including another Reference) --
  // checked BEFORE the generic domain machinery below, since `Reference`
  // has no domain of its own (base-types.yaml's "complex" category isn't
  // in expression-operators.yaml's categoryToDomain) and NULL's own
  // typeName is always null, so neither operand would reach that
  // machinery meaningfully on its own.
  if (ctx.ruleSet.exprOperators.comparison.operators.includes(node.op) && (left.typeName === "Reference" || right.typeName === "Reference")) {
    const comparedAgainstNull = (left.typeName === "Reference" && right.isNullLiteral) || (right.typeName === "Reference" && left.isNullLiteral);
    if (!comparedAgainstNull) {
      diags.push(formatDiagnostic(ctx.ruleSet, "expr-reference-comparison-illegal", node.line, node.col, { op: node.op }));
    }
    return { typeName: null };
  }

  if (!left.typeName || !right.typeName) return { typeName: null };

  const rawLeftDomain = domainOf(left.typeName, ctx.ruleSet);
  const rawRightDomain = domainOf(right.typeName, ctx.ruleSet);
  if (!rawLeftDomain || !rawRightDomain) return { typeName: null }; // an operand's domain can't be classified -- don't guess

  // A bare integer literal is an UNTYPED constant: it has no domain of its
  // own and takes the one its first operation gives it (Siemens' own typed-
  // vs-non-typed constant rule, and the same S7-SCL grammar that lists a
  // plain decimal digit string as a legal BYTE/WORD/DWORD bit constant). So
  // `#someWord + 1` and `(#bits AND #mask) <> 0` are ordinary code, not the
  // domain mismatches a fixed `Int` typing made them look like. Limited to
  // numeric and bit-string: a bare integer next to a Bool or a Time operand
  // has no such reading and stays a real mismatch.
  const ADOPTABLE = ["numeric", "bit-string"];
  const leftDomain = left.looseIntLiteral && ADOPTABLE.includes(rawRightDomain) ? rawRightDomain : rawLeftDomain;
  const rightDomain = right.looseIntLiteral && ADOPTABLE.includes(rawLeftDomain) ? rawLeftDomain : rawRightDomain;

  const ops = ctx.ruleSet.exprOperators;
  const op = node.op;

  if (ops.arithmetic.operators.includes(op)) {
    if (!domainPairAllowed(leftDomain, rightDomain, ops.arithmetic.allowedDomainPairs)) {
      diags.push(
        formatDiagnostic(ctx.ruleSet, "expr-arithmetic-domain-mismatch", node.line, node.col, {
          op,
          leftType: left.typeName,
          rightType: right.typeName,
        })
      );
      return { typeName: null };
    }
    if (leftDomain === rightDomain && (ops.arithmetic.warnOnMismatchWithinDomain ?? []).includes(leftDomain)) {
      if (left.typeName !== right.typeName && !left.looseIntLiteral && !right.looseIntLiteral) {
        pushImplicitConversionWarning(node, left.typeName, right.typeName, ctx, diags);
      }
    }
    return { typeName: left.typeName };
  }

  if (ops.logical.operators.includes(op)) {
    if (!domainPairAllowed(leftDomain, rightDomain, ops.logical.allowedDomainPairs)) {
      diags.push(
        formatDiagnostic(ctx.ruleSet, "expr-logical-domain-mismatch", node.line, node.col, {
          op,
          leftType: left.typeName,
          rightType: right.typeName,
        })
      );
      return { typeName: null };
    }
    if (leftDomain === rightDomain && (ops.logical.requireExactTypeMatch ?? []).includes(leftDomain) && left.typeName !== right.typeName) {
      diags.push(
        formatDiagnostic(ctx.ruleSet, "expr-bitstring-width-mismatch", node.line, node.col, {
          op,
          leftType: left.typeName,
          rightType: right.typeName,
        })
      );
      return { typeName: null };
    }
    return { typeName: left.typeName };
  }

  if (ops.comparison.operators.includes(op)) {
    if (!domainPairAllowed(leftDomain, rightDomain, ops.comparison.allowedDomainPairs)) {
      diags.push(
        formatDiagnostic(ctx.ruleSet, "expr-comparison-domain-mismatch", node.line, node.col, {
          op,
          leftType: left.typeName,
          rightType: right.typeName,
        })
      );
      return { typeName: null };
    }
    if (leftDomain === rightDomain && (ops.comparison.warnOnMismatchWithinDomain ?? []).includes(leftDomain)) {
      if (left.typeName !== right.typeName && !left.looseIntLiteral && !right.looseIntLiteral) {
        pushImplicitConversionWarning(node, left.typeName, right.typeName, ctx, diags);
      }
    }
    return { typeName: "Bool" };
  }

  return { typeName: null };
}

function evalExpr(node: SclExprNode, ctx: EvalContext, diags: LintDiagnostic[]): ExprEval {
  switch (node.kind) {
    case "literal":
      return evalLiteral(node.raw);
    case "operand":
      return evalOperand(node, ctx);
    case "call":
      return evalCall(node, ctx, diags);
    case "unary":
      return evalExpr(node.operand, ctx, diags);
    case "binary":
      return evalBinary(node, ctx, diags);
  }
}

/** Type-checks every `#lhs := <expr>;` assignment parser/s7dclParser.ts's
 * `parseSclBody` recognized (`block.sclAssignments`) -- see this file's
 * own header for the domain model and error-propagation rule. The LHS's
 * own declared type is deliberately NOT compared against the RHS's
 * resolved type here (that's a SEPARATE, already-existing concern --
 * linter/sclInstructionChecks.ts's `checkResultTypeMatch` does the
 * analogous check for a `#lhs := Call(...)` assignment; this checker is
 * scoped to the RHS expression's OWN internal operator consistency, not
 * assignability to the target). */
export function checkSclExpressionTypes(block: ParsedBlockFile, ruleSet: RuleSet, blockIndex: BlockIndex, typeCache: TypeCacheResult): LintDiagnostic[] {
  const ctx: EvalContext = { block, blockIndex, typeCache, ruleSet };
  const diags: LintDiagnostic[] = [];
  for (const assignment of block.sclAssignments as SclAssignmentExpr[]) {
    evalExpr(assignment.expr, ctx, diags);
  }
  return diags;
}
