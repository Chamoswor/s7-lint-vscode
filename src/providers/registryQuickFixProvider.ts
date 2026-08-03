// Quick Fixes for the two diagnostics whose usual cause is the instruction
// REGISTRY rather than the checked source:
//
//   - `missing-required-pin` -- "Mark 'ADDR_2' as optional on 'PUT'". A
//     `required: true` that was never actually required is an easy slip when
//     transcribing a Siemens pin table (PUT's ADDR_2..4/SD_2..4 are the
//     motivating real case: only the _1 pair is mandatory), and it fires on
//     every single call site until the YAML is corrected.
//   - `unknown-instruction` -- "Add 'PEEK_WORD' to the instruction registry",
//     scaffolding an entry seeded from the call site.
//
// Both edit files OUTSIDE the document being linted, and both need the rule
// set reloaded afterwards, so these are `command`-backed actions rather than
// `WorkspaceEdit` ones (see extension.ts for the two command handlers).
//
// Like providers/exprConversionQuickFixProvider.ts, this re-runs the very
// check pass that produced the diagnostic in order to recover its structured
// `registryFix` payload -- a CodeActionProvider only ever receives plain
// `vscode.Diagnostic`s, which have nowhere to carry it.
//
// Recovered fixes are keyed by LINE plus the rendered message text:
//   - message, because position alone is not unique -- one call reports one
//     `missing-required-pin` PER unfilled pin, all at the identical call
//     position, so six distinct fixes would collapse into one;
//   - line only (not line+column), because extension.ts's toVscodeDiagnostic
//     CLAMPS the column to the line's length, so a column past end-of-line
//     would never match back. Two identical messages on one line can only be
//     the same call name or pin repeated, which maps to the same fix anyway.
import * as vscode from "vscode";
import { BlockIndex } from "../analysis/blockIndex";
import { TypeCacheResult } from "../cache/typeCache";
import { RegistryFix } from "../linter/diagnostics";
import { checkInstructions } from "../linter/instructionChecks";
import { checkSclInstructions } from "../linter/sclInstructionChecks";
import { detectS7dclKind, parseS7dclBlock, parseS7dclFile } from "../parser/s7dclParser";
import { RuleSet } from "../rules/types";

const MISSING_REQUIRED_PIN_CODE = "missing-required-pin";
const UNKNOWN_INSTRUCTION_CODE = "unknown-instruction";

/** Command ids -- kept here so the provider and extension.ts can't drift. */
export const MARK_PIN_OPTIONAL_COMMAND = "tiaLint.registryMarkPinOptional";
export const SCAFFOLD_INSTRUCTION_COMMAND = "tiaLint.registryScaffoldInstruction";

export interface MarkPinOptionalArgs {
  instructionName: string;
  pinNames: string[];
  scl: boolean;
}

export interface ScaffoldInstructionArgs {
  instructionName: string;
  pinNames: string[];
  scl: boolean;
}

export class RegistryQuickFixProvider implements vscode.CodeActionProvider {
  public static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(private readonly ruleSet: RuleSet, private readonly blockIndex: BlockIndex, private readonly getTypeCache: () => TypeCacheResult) {}

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const relevant = context.diagnostics.filter((d) => d.code === MISSING_REQUIRED_PIN_CODE || d.code === UNKNOWN_INSTRUCTION_CODE);
    if (relevant.length === 0) return [];

    const fixes = this.recoverRegistryFixes(document);
    if (fixes.size === 0) return [];

    const actions: vscode.CodeAction[] = [];
    // Every pin-required fix on THIS invocation, grouped per instruction, so
    // a call missing six pins can also offer one "mark all six" action
    // instead of only six separate ones.
    const pinGroups = new Map<string, { fix: Extract<RegistryFix, { kind: "pin-required" }>; pins: string[]; diagnostics: vscode.Diagnostic[] }>();

    for (const diagnostic of relevant) {
      const fix = fixes.get(fixKey(diagnostic.range.start.line + 1, diagnostic.message));
      if (!fix) continue;

      if (fix.kind === "unknown-instruction") {
        const action = new vscode.CodeAction(`Add '${fix.instructionName}' to the instruction registry...`, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        const args: ScaffoldInstructionArgs = { instructionName: fix.instructionName, pinNames: fix.pinNames, scl: fix.scl };
        action.command = { command: SCAFFOLD_INSTRUCTION_COMMAND, title: action.title, arguments: [args] };
        actions.push(action);
        continue;
      }

      const action = new vscode.CodeAction(
        `Mark pin '${fix.pinName}' as optional on '${fix.instructionName}' in the registry`,
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = [diagnostic];
      const args: MarkPinOptionalArgs = { instructionName: fix.instructionName, pinNames: [fix.pinName], scl: fix.scl };
      action.command = { command: MARK_PIN_OPTIONAL_COMMAND, title: action.title, arguments: [args] };
      actions.push(action);

      const groupKey = `${fix.scl ? "scl" : "shared"}:${fix.instructionName}`;
      const group = pinGroups.get(groupKey) ?? { fix, pins: [], diagnostics: [] };
      group.pins.push(fix.pinName);
      group.diagnostics.push(diagnostic);
      pinGroups.set(groupKey, group);
    }

    for (const group of pinGroups.values()) {
      if (group.pins.length < 2) continue;
      const action = new vscode.CodeAction(
        `Mark all ${group.pins.length} unfilled pins as optional on '${group.fix.instructionName}' (${group.pins.join(", ")})`,
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = group.diagnostics;
      const args: MarkPinOptionalArgs = { instructionName: group.fix.instructionName, pinNames: group.pins, scl: group.fix.scl };
      action.command = { command: MARK_PIN_OPTIONAL_COMMAND, title: action.title, arguments: [args] };
      actions.push(action);
    }

    return actions;
  }

  /** Re-runs the instruction checks for this document and indexes every
   * diagnostic that carries a `registryFix`. Mirrors extension.ts's own
   * `lintDocument` dispatch (a `.scl` file can bundle several declarations
   * and uses the SCL checker; a `.s7dcl` file has one block and uses the
   * LAD/FBD one) -- the other check passes it runs can't produce either of
   * the two codes handled here, so they're skipped. */
  private recoverRegistryFixes(document: vscode.TextDocument): Map<string, RegistryFix> {
    const byKey = new Map<string, RegistryFix>();
    const text = document.getText();
    const isScl = document.uri.fsPath.toLowerCase().endsWith(".scl");

    const record = (diags: { line: number; message: string; registryFix?: RegistryFix }[]): void => {
      for (const d of diags) {
        if (d.registryFix) byKey.set(fixKey(d.line, d.message), d.registryFix);
      }
    };

    try {
      if (isScl) {
        for (const block of parseS7dclFile(text)) {
          record(checkSclInstructions(block, this.ruleSet, this.blockIndex, this.getTypeCache()));
        }
      } else if (detectS7dclKind(text) === "block") {
        const block = parseS7dclBlock(text);
        if (block) record(checkInstructions(block, this.ruleSet));
      }
    } catch {
      // A Quick Fix must never surface a parse/check failure as an error --
      // offering no action is the correct degradation.
      return new Map();
    }
    return byKey;
  }
}

/** 1-based line plus the exact rendered message -- see the class header for
 * why neither half alone is enough. */
function fixKey(line: number, message: string): string {
  return `${line}:${message}`;
}
