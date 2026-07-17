// Quick Fix for the `expr-implicit-numeric-conversion` warning
// (linter/exprTypeChecks.ts) -- offers to make an implicit same-domain
// numeric conversion (e.g. Int + Real) explicit by wrapping the RIGHT-hand
// operand in its own `{rightType}_TO_{leftType}(...)` conversion call,
// exactly the fix the diagnostic's own message already suggests.
//
// Unlike providers/instanceQuickFixProvider.ts (purely text-position-based,
// since nothing about that fix needs to know an expression's own shape),
// this ONE fix genuinely needs the right-hand OPERAND's exact source span --
// which can be an arbitrary sub-expression (`#b * #c`, `(#a + #b)`, a
// nested call, ...), not just a single token -- so re-deriving it from raw
// text here would mean re-implementing SCL's own operator precedence a
// second time. Instead this reads the span straight off the ALREADY-PARSED
// `SclExprNode` tree via `LintDiagnostic.implicitConversionFix` (see that
// field's own comment, and parser/s7dclParser.ts's `SclExprNode.endLine`/
// `endCol`) -- re-running the exact same parse + check pass extension.ts's
// own `lintDocument` already runs for this document, since a
// CodeActionProvider only ever receives `vscode.Diagnostic[]` (no room for
// this kind of structured extra data) rather than the richer
// `LintDiagnostic[]` that pass actually produces.
import * as vscode from "vscode";
import { BlockIndex } from "../analysis/blockIndex";
import { TypeCacheResult } from "../cache/typeCache";
import { checkSclExpressionTypes } from "../linter/exprTypeChecks";
import { parseS7dclFile } from "../parser/s7dclParser";
import { RuleSet } from "../rules/types";

const IMPLICIT_CONVERSION_CODE = "expr-implicit-numeric-conversion";

export class ExprConversionQuickFixProvider implements vscode.CodeActionProvider {
  public static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(private readonly ruleSet: RuleSet, private readonly blockIndex: BlockIndex, private readonly getTypeCache: () => TypeCacheResult) {}

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const relevant = context.diagnostics.filter((d) => d.code === IMPLICIT_CONVERSION_CODE);
    if (relevant.length === 0) return [];

    // Re-run the same check to recover its own LintDiagnostic[] (with the
    // structured `implicitConversionFix` field) -- keyed by the exact
    // (line, col) position `formatDiagnostic` reported at (the operator's
    // own position), so several implicit-conversion warnings sharing one
    // LINE (a compound expression with more than one flagged operator)
    // still resolve to the right one each.
    const typeCache = this.getTypeCache();
    const fixByPosition = new Map<string, NonNullable<import("../linter/diagnostics").LintDiagnostic["implicitConversionFix"]>>();
    for (const block of parseS7dclFile(document.getText())) {
      for (const d of checkSclExpressionTypes(block, this.ruleSet, this.blockIndex, typeCache)) {
        if (d.code === IMPLICIT_CONVERSION_CODE && d.implicitConversionFix) {
          fixByPosition.set(`${d.line}:${d.col}`, d.implicitConversionFix);
        }
      }
    }

    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of relevant) {
      // vscode.Diagnostic.range is 0-based; LintDiagnostic's own line/col
      // (and this key) are 1-based -- see extension.ts's toVscodeDiagnostic.
      const key = `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`;
      const fix = fixByPosition.get(key);
      if (!fix) continue;

      const range = new vscode.Range(
        new vscode.Position(fix.rightLine - 1, fix.rightCol - 1),
        new vscode.Position(fix.rightEndLine - 1, fix.rightEndCol - 1)
      );
      const original = document.getText(range);
      // Every real `<src>_TO_<dest>` SCL conversion instruction is spelled
      // in UPPERCASE (confirmed against the real corpus, e.g.
      // expression-type-diagnostics.scl's `INT_TO_REAL` call, and
      // sclInstructionChecks.ts's own `findEntry` is a deliberately EXACT,
      // case-sensitive registry lookup with no fuzzy fallback) -- but
      // `fix.rightType`/`fix.leftType` are base-types.yaml's own MIXED-case
      // canonical names (`LReal`, `Real`, ...), so building the call name
      // straight from them would silently mismatch the registry key
      // (`LReal_TO_Real` vs. the real `LREAL_TO_REAL`) and make the guard
      // below always refuse.
      const funcName = `${fix.rightType.toUpperCase()}_TO_${fix.leftType.toUpperCase()}`;
      // Only offer this when the suggested conversion is a REAL,
      // registered instruction -- e.g. no `LInt_TO_...`/`..._TO_LInt` pair
      // is catalogued yet (Siemens' own official conversion-instructions
      // table this registry was transcribed from doesn't document LInt/
      // ULInt at all), so inserting one there would just trade one
      // diagnostic (`expr-implicit-numeric-conversion`) for another
      // (`unknown-instruction`) -- never guessed.
      if (!this.ruleSet.sclInstructions[funcName] && !this.ruleSet.instructions[funcName]) continue;

      const action = new vscode.CodeAction(`Convert explicitly with ${funcName}(...)`, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, range, `${funcName}(${original})`);
      action.edit = edit;
      actions.push(action);
    }

    return actions;
  }
}
