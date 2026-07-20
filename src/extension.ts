import * as path from "path";
import * as vscode from "vscode";
import { buildDocumentIndex } from "./analysis/documentIndex";
import { CacheManager } from "./cache/cacheManager";
import { getMlcLocale } from "./config";
import { checkStructCountPerDataBlock } from "./linter/compositionChecks";
import { LintDiagnostic, LintSeverity } from "./linter/diagnostics";
import { checkSclExpressionTypes } from "./linter/exprTypeChecks";
import { checkLadWiring } from "./linter/ladWiringChecks";
import { checkInstructions } from "./linter/instructionChecks";
import { checkSclInstructions } from "./linter/sclInstructionChecks";
import { checkSclSyntaxStructure } from "./linter/synStructureChecks";
import { checkIllegalDotAccess, checkSclConditionTypes, checkUndeclaredIdentifiers } from "./linter/symbolChecks";
import { detectS7dclKind, parseS7dclBlock, parseS7dclFile } from "./parser/s7dclParser";
import { S7dclCompletionProvider } from "./providers/completion";
import { S7dclDefinitionProvider } from "./providers/definition";
import { S7dclHoverProvider } from "./providers/hover";
import { ExprConversionQuickFixProvider } from "./providers/exprConversionQuickFixProvider";
import { InstanceQuickFixProvider } from "./providers/instanceQuickFixProvider";
import { MlcHintsController } from "./providers/mlcHints";
import { S7dclRenameProvider } from "./providers/rename";
import { S7dclSemanticTokensProvider, semanticTokensLegend } from "./providers/semanticTokens";
import { S7ResDefinitionProvider } from "./providers/s7resDefinition";
import { S7ResRenameProvider } from "./providers/s7resRename";
import { loadRuleSet } from "./rules/loadRules";
import { RuleSet } from "./rules/types";
import { RegistryEditorPanel } from "./instructionEditor/panel";

const S7DCL_SELECTOR: vscode.DocumentSelector = [{ language: "s7dcl" }, { language: "s7udt" }, { language: "s7scl" }];
const S7RES_SELECTOR: vscode.DocumentSelector = [{ pattern: "**/*.s7res" }];

let ruleSet: RuleSet;
let cacheManager: CacheManager;
let diagnosticCollection: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let mlcHints: MlcHintsController;

const SEVERITY_MAP: Record<LintSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("S7 Lint");
  context.subscriptions.push(output);

  const resourcesDir = path.join(context.extensionPath, "resources");
  try {
    ruleSet = loadRuleSet(resourcesDir);
  } catch (err) {
    output.appendLine(`[S7 Lint] Failed to load bundled rules from ${resourcesDir}: ${String(err)}`);
    vscode.window.showErrorMessage('S7 Lint: failed to load its bundled rule set -- see the "S7 Lint" output channel.');
    return;
  }
  output.appendLine(
    `[S7 Lint] Loaded ${Object.keys(ruleSet.instructions).length} instructions, ` +
      `${Object.keys(ruleSet.baseTypes).length} base types, ${Object.keys(ruleSet.systemTypes).length} system types, ` +
      `${ruleSet.opaqueSectionNames.size} opaque section-legality names.`
  );

  diagnosticCollection = vscode.languages.createDiagnosticCollection("tiaLint");
  context.subscriptions.push(diagnosticCollection);

  cacheManager = new CacheManager(ruleSet, output);
  mlcHints = new MlcHintsController(ruleSet, cacheManager.getBlockIndex());
  await cacheManager.rebuild();

  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      S7DCL_SELECTOR,
      new S7dclSemanticTokensProvider(ruleSet, cacheManager.getBlockIndex()),
      semanticTokensLegend
    ),
    vscode.languages.registerHoverProvider(S7DCL_SELECTOR, new S7dclHoverProvider(ruleSet, cacheManager.getBlockIndex())),
    vscode.languages.registerDefinitionProvider(S7DCL_SELECTOR, new S7dclDefinitionProvider(ruleSet, cacheManager.getBlockIndex())),
    vscode.languages.registerDefinitionProvider(S7RES_SELECTOR, new S7ResDefinitionProvider()),
    vscode.languages.registerRenameProvider(S7DCL_SELECTOR, new S7dclRenameProvider(ruleSet, cacheManager.getBlockIndex())),
    vscode.languages.registerRenameProvider(S7RES_SELECTOR, new S7ResRenameProvider()),
    vscode.languages.registerCompletionItemProvider(S7DCL_SELECTOR, new S7dclCompletionProvider(ruleSet, cacheManager.getBlockIndex(), () => cacheManager.getTypeCacheResult()), ".", "#", '"', ":"),
    vscode.languages.registerCodeActionsProvider(
      S7DCL_SELECTOR,
      new InstanceQuickFixProvider(ruleSet, cacheManager.getBlockIndex(), () => cacheManager.getTypeCacheResult()),
      InstanceQuickFixProvider.metadata
    ),
    vscode.languages.registerCodeActionsProvider(
      S7DCL_SELECTOR,
      new ExprConversionQuickFixProvider(ruleSet, cacheManager.getBlockIndex(), () => cacheManager.getTypeCacheResult()),
      ExprConversionQuickFixProvider.metadata
    )
  );

  const relintAllOpen = () => {
    for (const doc of vscode.workspace.textDocuments) lintDocument(doc);
    mlcHints.refreshAllVisible();
  };

  context.subscriptions.push(cacheManager.onDidRebuild(relintAllOpen));
  cacheManager.watch(context, async () => {
    await cacheManager.rebuild();
  });

  // Keep open buffers visible to the shared block index, so hover/definition/
  // rename/completion resolve a block declared in an UNSAVED document exactly
  // as the lint pass does (see BlockIndex.setDocumentOverlay). Open/close are
  // handled here; edits refresh the overlay via lintDocument's debounced pass.
  const isBlockBearing = (doc: vscode.TextDocument): boolean => {
    const p = doc.uri.fsPath.toLowerCase();
    return p.endsWith(".scl") || p.endsWith(".s7dcl") || p.endsWith(".db");
  };
  const syncBlockOverlay = (doc: vscode.TextDocument): void => {
    if (isBlockBearing(doc)) cacheManager.getBlockIndex().setDocumentOverlay(doc.uri.fsPath, doc.getText());
  };
  for (const doc of vscode.workspace.textDocuments) syncBlockOverlay(doc);
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(syncBlockOverlay));
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => cacheManager.getBlockIndex().clearDocumentOverlay(doc.uri.fsPath))
  );

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(lintDocument));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(lintDocument));

  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const key = e.document.uri.toString();
      const existing = debounceTimers.get(key);
      if (existing) clearTimeout(existing);
      debounceTimers.set(
        key,
        setTimeout(() => lintDocument(e.document), 400)
      );
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnosticCollection.delete(doc.uri);
    })
  );

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((e) => mlcHints.refresh(e)));
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => mlcHints.refreshAllVisible()));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tiaLint.mlcLocale")) mlcHints.refreshAllVisible();
    })
  );

  relintAllOpen();

  context.subscriptions.push(
    vscode.commands.registerCommand("tiaLint.rebuildCache", async () => {
      await cacheManager.rebuild();
      relintAllOpen();
      vscode.window.showInformationMessage("S7 Lint: type cache rebuilt.");
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("tiaLint.relintWorkspace", () => {
      relintAllOpen();
      vscode.window.showInformationMessage("S7 Lint: re-linted all open documents.");
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("tiaLint.showRuleStats", () => {
      vscode.window.showInformationMessage(
        `S7 Lint rules: ${Object.keys(ruleSet.instructions).length} instructions, ` +
          `${Object.keys(ruleSet.baseTypes).length} base types, ${Object.keys(ruleSet.systemTypes).length} system types.`
      );
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("tiaLint.openInstructionEditor", () => {
      RegistryEditorPanel.createOrShow(context, resourcesDir, output);
    })
  );
}

function lintDocument(doc: vscode.TextDocument): void {
  const fsPath = doc.uri.fsPath;
  const isS7dcl = fsPath.toLowerCase().endsWith(".s7dcl");
  const isScl = fsPath.toLowerCase().endsWith(".scl");
  const isUdtSource = cacheManager.isUdtSource(fsPath);
  if (!isS7dcl && !isScl && !isUdtSource) return;

  const diagnostics: vscode.Diagnostic[] = [];

  if (isScl) {
    // An authored .scl source file may bundle several program-block
    // declarations in one file (unlike a .s7dcl export) -- see
    // parseS7dclFile. Each one gets its own SCL instruction-call check;
    // there's no NETWORK/RUNG wire-rooting or LAD/FBD-style AST here.
    const text = doc.getText();
    // Keep this buffer's own blocks in the shared index before checking it,
    // so an unsaved declaration resolves for the lint pass AND for hover/
    // definition/completion alike -- see BlockIndex.setDocumentOverlay.
    cacheManager.getBlockIndex().setDocumentOverlay(fsPath, text);
    const blockIndex = cacheManager.getBlockIndex();
    for (const block of parseS7dclFile(text)) {
      for (const d of checkSclInstructions(block, ruleSet, blockIndex, cacheManager.getTypeCacheResult())) {
        diagnostics.push(toVscodeDiagnostic(doc, d));
      }
      for (const d of checkUndeclaredIdentifiers(block, blockIndex, cacheManager.getTypeCacheResult(), ruleSet)) {
        diagnostics.push(toVscodeDiagnostic(doc, d));
      }
      for (const d of checkIllegalDotAccess(block, blockIndex, cacheManager.getTypeCacheResult(), ruleSet)) {
        diagnostics.push(toVscodeDiagnostic(doc, d));
      }
      for (const d of checkSclConditionTypes(block, blockIndex, cacheManager.getTypeCacheResult(), ruleSet)) {
        diagnostics.push(toVscodeDiagnostic(doc, d));
      }
      for (const d of checkSclExpressionTypes(block, ruleSet, blockIndex, cacheManager.getTypeCacheResult())) {
        diagnostics.push(toVscodeDiagnostic(doc, d));
      }
    }
    for (const d of checkSclSyntaxStructure(text, ruleSet)) {
      diagnostics.push(toVscodeDiagnostic(doc, d));
    }
    // Literal-vs-declared-type checks + UDT-cache-relevant spans -- covers
    // every declaration in the file (see analysis/documentIndex.ts's own
    // multi-declaration top-level walk).
    for (const d of buildDocumentIndex(text, ruleSet, blockIndex, fsPath, getMlcLocale(doc.uri)).diagnostics) {
      diagnostics.push(toVscodeDiagnostic(doc, d));
    }
  } else if (isS7dcl) {
    const text = doc.getText();
    // Keep this buffer's own blocks in the shared index before checking it,
    // so an unsaved declaration resolves for the lint pass AND for hover/
    // definition/completion alike -- see BlockIndex.setDocumentOverlay.
    cacheManager.getBlockIndex().setDocumentOverlay(fsPath, text);
    const blockIndex = cacheManager.getBlockIndex();
    if (detectS7dclKind(text) === "block") {
      const block = parseS7dclBlock(text);
      if (block) {
        for (const d of checkInstructions(block, ruleSet)) {
          diagnostics.push(toVscodeDiagnostic(doc, d));
        }
        for (const d of checkLadWiring(block, ruleSet)) {
          diagnostics.push(toVscodeDiagnostic(doc, d));
        }
        for (const d of checkUndeclaredIdentifiers(block, blockIndex, cacheManager.getTypeCacheResult(), ruleSet)) {
          diagnostics.push(toVscodeDiagnostic(doc, d));
        }
        for (const d of checkIllegalDotAccess(block, blockIndex, cacheManager.getTypeCacheResult(), ruleSet)) {
          diagnostics.push(toVscodeDiagnostic(doc, d));
        }
        for (const d of checkStructCountPerDataBlock(block, ruleSet)) {
          diagnostics.push(toVscodeDiagnostic(doc, d));
        }
      }
    }
    // A "type"-kind .s7dcl file has no instruction calls to check -- its
    // UDT-cache diagnostics (below) are what matters for it.

    // Literal-vs-declared-type checks (VAR defaults, instruction pin
    // arguments) -- see analysis/documentIndex.ts. Runs for both "block"
    // and "type"-kind files; independent of the AST-based checks above.
    for (const d of buildDocumentIndex(text, ruleSet, blockIndex, fsPath, getMlcLocale(doc.uri)).diagnostics) {
      diagnostics.push(toVscodeDiagnostic(doc, d));
    }
  }

  for (const cd of cacheManager.getDiagnosticsForFile(fsPath)) {
    diagnostics.push(
      toVscodeDiagnostic(doc, { line: cd.line, col: 1, severity: cd.severity, message: cd.message, code: cd.code })
    );
  }

  diagnosticCollection.set(doc.uri, diagnostics);
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document === doc) mlcHints.refresh(editor);
  }
}

function toVscodeDiagnostic(doc: vscode.TextDocument, d: LintDiagnostic): vscode.Diagnostic {
  const zeroLine = Math.min(Math.max(0, d.line - 1), Math.max(0, doc.lineCount - 1));
  const lineText = doc.lineCount > 0 ? doc.lineAt(zeroLine).text : "";
  const startCol = Math.max(0, Math.min(d.col - 1, lineText.length));
  const range = new vscode.Range(zeroLine, startCol, zeroLine, lineText.length);
  const diag = new vscode.Diagnostic(range, d.message, SEVERITY_MAP[d.severity]);
  diag.source = "tia-lint";
  diag.code = d.code;
  return diag;
}

export function deactivate(): void {
  diagnosticCollection?.dispose();
}
