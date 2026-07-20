// Quick Fix for the `instruction-needs-instance` diagnostic
// (linter/sclInstructionChecks.ts) -- offers "Generate local multi-instance"
// and/or "Generate single-instance DATA_BLOCK", mirroring TIA Portal's own
// two ways to fix this (see instanceQuickFix.ts's own file header for the
// exact shape each produces and why this is text-position- rather than
// AST-based). Which action(s) are offered depends on the enclosing block
// type: both inside a FUNCTION_BLOCK (it alone has a Static section a
// multi-instance can live in), single-instance DB generation ONLY inside a
// FUNCTION/ORGANIZATION_BLOCK (neither has one at all).
import * as vscode from "vscode";
import { BlockIndex } from "../analysis/blockIndex";
import { TypeCacheResult } from "../cache/typeCache";
import { RuleSet } from "../rules/types";
import {
  buildInstanceDeclarationEdit,
  buildSingleInstanceDbEdit,
  fbInstanceRef,
  findInstanceDotEntry,
  identifierRangeAt,
  instructionInstanceRef,
  quotedNameRangeAt,
  resolveBlockInstanceContext,
} from "./instanceQuickFix";

const NEEDS_INSTANCE_CODE = "instruction-needs-instance";
/** Dotting into a bare FUNCTION_BLOCK type (linter/symbolChecks.ts) -- fixed
 * by creating an instance of it, exactly as TIA Portal offers. */
const DOT_ACCESS_NEEDS_INSTANCE_CODE = "dot-access-needs-instance";

export class InstanceQuickFixProvider implements vscode.CodeActionProvider {
  public static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(private readonly ruleSet: RuleSet, private readonly blockIndex: BlockIndex, private readonly getTypeCache: () => TypeCacheResult) {}

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code !== NEEDS_INSTANCE_CODE) continue;

      // A LintDiagnostic's own vscode.Diagnostic.range spans to the end of
      // the line (see extension.ts's toVscodeDiagnostic) -- re-derive just
      // the call NAME's own range from its start position instead of
      // trusting the diagnostic's range wholesale.
      const nameRange = identifierRangeAt(document, diagnostic.range.start);
      if (!nameRange) continue;
      const callName = document.getText(nameRange);

      const entry = findInstanceDotEntry(this.ruleSet, callName);
      if (!entry) continue;

      const ctx = resolveBlockInstanceContext(document, diagnostic.range.start.line);
      if (!ctx) continue;

      const instRef = instructionInstanceRef(entry);
      if (!instRef) continue;
      const multiPlan = buildInstanceDeclarationEdit(document, ctx, instRef);
      if (multiPlan) {
        const action = new vscode.CodeAction(`Generate local multi-instance '${multiPlan.instanceName} : ${entry.instanceType}'`, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        const edit = new vscode.WorkspaceEdit();
        edit.set(document.uri, [multiPlan.edit, vscode.TextEdit.replace(nameRange, `#${multiPlan.instanceName}`)]);
        action.edit = edit;
        actions.push(action);
      }

      const singlePlan = buildSingleInstanceDbEdit(document, ctx, instRef, this.blockIndex, this.getTypeCache());
      if (singlePlan) {
        const action = new vscode.CodeAction(`Generate single-instance DATA_BLOCK "${singlePlan.dbName}"`, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = !multiPlan;
        const edit = new vscode.WorkspaceEdit();
        edit.set(document.uri, [singlePlan.edit, vscode.TextEdit.replace(nameRange, `"${singlePlan.dbName}"`)]);
        action.edit = edit;
        actions.push(action);
      }
    }

    actions.push(...this.fbInstanceActions(document, context));
    return actions;
  }

  /**
   * Fixes for `dot-access-needs-instance` -- dotting into a bare FUNCTION_BLOCK
   * (`"FB_Pump".member`), which TIA Portal itself refuses. A FUNCTION_BLOCK's
   * members are only reachable through an INSTANCE of it, so the same two
   * actions the instruction case offers apply, just with the FB as the instance
   * type (declared quoted, and with no `InstructionName` pragma -- see
   * `InstanceTypeRef`). Each rewrites the offending base reference to point at
   * the instance it just created.
   */
  private fbInstanceActions(document: vscode.TextDocument, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code !== DOT_ACCESS_NEEDS_INSTANCE_CODE) continue;

      const quoted = quotedNameRangeAt(document, diagnostic.range.start);
      if (!quoted) continue;
      // Only a real workspace FUNCTION_BLOCK can be instantiated.
      const block = this.blockIndex.get(quoted.name);
      if (!block || block.blockType !== "FUNCTION_BLOCK") continue;

      const ctx = resolveBlockInstanceContext(document, diagnostic.range.start.line);
      if (!ctx) continue;
      const ref = fbInstanceRef(block.name);

      const multiPlan = buildInstanceDeclarationEdit(document, ctx, ref);
      if (multiPlan) {
        const action = new vscode.CodeAction(
          `Generate local multi-instance '${multiPlan.instanceName} : "${block.name}"'`,
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        const edit = new vscode.WorkspaceEdit();
        edit.set(document.uri, [multiPlan.edit, vscode.TextEdit.replace(quoted.range, `#${multiPlan.instanceName}`)]);
        action.edit = edit;
        actions.push(action);
      }

      const singlePlan = buildSingleInstanceDbEdit(document, ctx, ref, this.blockIndex, this.getTypeCache());
      if (singlePlan) {
        const action = new vscode.CodeAction(`Generate single-instance DATA_BLOCK "${singlePlan.dbName}"`, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = !multiPlan;
        const edit = new vscode.WorkspaceEdit();
        edit.set(document.uri, [singlePlan.edit, vscode.TextEdit.replace(quoted.range, `"${singlePlan.dbName}"`)]);
        action.edit = edit;
        actions.push(action);
      }
    }
    return actions;
  }
}
