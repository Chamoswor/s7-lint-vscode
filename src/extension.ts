import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { buildDocumentIndex } from "./analysis/documentIndex";
import { CacheManager } from "./cache/cacheManager";
import { getMlcLocale } from "./config";
import { checkMainSafetyBlockInterface, checkStructCountPerDataBlock } from "./linter/compositionChecks";
import { LintDiagnostic, LintSeverity } from "./linter/diagnostics";
import { checkSclExpressionTypes } from "./linter/exprTypeChecks";
import { checkLadWiring } from "./linter/ladWiringChecks";
import { checkInstructions } from "./linter/instructionChecks";
import { checkSclInstructions } from "./linter/sclInstructionChecks";
import { checkMlcReferences, checkS7res } from "./linter/s7resChecks";
import { checkSclSyntaxStructure } from "./linter/synStructureChecks";
import { checkIllegalDotAccess, checkSclConditionTypes, checkUndeclaredIdentifiers } from "./linter/symbolChecks";
import { detectS7dclKind, parseS7dclBlock, parseS7dclFile } from "./parser/s7dclParser";
import { siblingS7ResPath } from "./parser/s7resParser";
import { S7_COMPLETION_TRIGGER_CHARACTERS, S7dclCompletionProvider } from "./providers/completion";
import { S7dclDefinitionProvider } from "./providers/definition";
import { S7dclHoverProvider } from "./providers/hover";
import { ExprConversionQuickFixProvider } from "./providers/exprConversionQuickFixProvider";
import { InstanceQuickFixProvider } from "./providers/instanceQuickFixProvider";
import {
  MARK_PIN_OPTIONAL_COMMAND,
  MarkPinOptionalArgs,
  RegistryQuickFixProvider,
  SCAFFOLD_INSTRUCTION_COMMAND,
  ScaffoldInstructionArgs,
} from "./providers/registryQuickFixProvider";
import { MlcHintsController } from "./providers/mlcHints";
import { S7dclRenameProvider } from "./providers/rename";
import { S7dclSemanticTokensProvider, semanticTokensLegend } from "./providers/semanticTokens";
import { S7ResDefinitionProvider } from "./providers/s7resDefinition";
import { S7ResQuickFixProvider } from "./providers/s7resQuickFixProvider";
import { SafetyCallQuickFixProvider } from "./providers/safetyCallQuickFixProvider";
import { S7ResRenameProvider } from "./providers/s7resRename";
import { loadRuleSet } from "./rules/loadRules";
import { RuleSet } from "./rules/types";
import { RegistryEditorPanel, RevealEntryTarget } from "./instructionEditor/panel";
import { RegistryEditResult, scaffoldInstruction, setPinsRequired } from "./instructionEditor/registryQuickFixEdits";
import { EXTERNAL_REGISTRY_FILES } from "./instructionEditor/registryPaths";
import { KNOWN_FAMILIES } from "./instructionEditor/schemaEnums";
import {
  DISABLE_RECOMMENDED_SEMANTIC_COLORS_COMMAND,
  INSTALL_RECOMMENDED_SEMANTIC_COLORS_COMMAND,
  RECOMMENDED_SEMANTIC_COLORS_SETTING,
  RecommendedSemanticPaletteKind,
  withRecommendedSemanticColors,
  withoutRecommendedSemanticColors,
} from "./semanticColors";

const S7DCL_SELECTOR: vscode.DocumentSelector = [{ language: "s7dcl" }, { language: "s7udt" }, { language: "s7scl" }];
const S7RES_SELECTOR: vscode.DocumentSelector = [{ pattern: "**/*.s7res" }];
const S7_LANGUAGE_IDS = new Set(["s7dcl", "s7udt", "s7scl"]);

let ruleSet: RuleSet;
let cacheManager: CacheManager;
let diagnosticCollection: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let mlcHints: MlcHintsController;
let semanticColorWrite: Promise<void> = Promise.resolve();

const SEVERITY_MAP: Record<LintSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
};

function recommendedSemanticColorsEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(RECOMMENDED_SEMANTIC_COLORS_SETTING, true);
}

function activePaletteKind(): RecommendedSemanticPaletteKind | undefined {
  if (vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark) return "dark";
  if (vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light) return "light";
  return undefined;
}

function enqueueSemanticColorWrite(run: () => Promise<void>): Promise<void> {
  const result = semanticColorWrite.then(run, run);
  semanticColorWrite = result.catch(() => undefined);
  return result;
}

/** Installs/refreshes the current theme's S7 semantic rules. Automatic calls
 * preserve user-customized selector values; the explicit command passes
 * `overwriteCustom` so it can restore the shipped preset on demand. */
function ensureRecommendedSemanticColors(showResult: boolean, overwriteCustom = false): Promise<void> {
  return enqueueSemanticColorWrite(async () => {
    if (!recommendedSemanticColorsEnabled() && !overwriteCustom) return;
    const paletteKind = activePaletteKind();
    if (!paletteKind) {
      if (showResult) {
        void vscode.window.showWarningMessage(
          "S7 Lint: recommended semantic colors were not installed for this high-contrast theme. Its accessibility colors remain unchanged."
        );
      }
      return;
    }
    const themeName = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme")?.trim();
    if (!themeName) {
      if (showResult) void vscode.window.showErrorMessage("S7 Lint: could not determine the active color theme.");
      return;
    }

    const editorConfig = vscode.workspace.getConfiguration("editor");
    const current = editorConfig.inspect<unknown>("semanticTokenColorCustomizations")?.globalValue;
    const next = withRecommendedSemanticColors(current, themeName, paletteKind, overwriteCustom);
    const changed = JSON.stringify(current) !== JSON.stringify(next);
    if (changed) {
      try {
        await editorConfig.update("semanticTokenColorCustomizations", next, vscode.ConfigurationTarget.Global);
      } catch (err) {
        output.appendLine(`[S7 Lint] Failed to install recommended semantic colors: ${String(err)}`);
        if (showResult) {
          void vscode.window.showErrorMessage(
            'S7 Lint: could not update User Settings -- see the "S7 Lint" output channel.'
          );
        }
        return;
      }
    }

    if (showResult) {
      const openSettings = "Open User Settings (JSON)";
      const choice = await vscode.window.showInformationMessage(
        changed
          ? `S7 Lint: installed recommended ${paletteKind} semantic colors for '${themeName}'. Existing unrelated rules were preserved.`
          : `S7 Lint: recommended semantic colors are already active for '${themeName}'.`,
        openSettings
      );
      if (choice === openSettings) await vscode.commands.executeCommand("workbench.action.openSettingsJson");
    }
  });
}

function removeRecommendedSemanticColors(showResult: boolean): Promise<void> {
  return enqueueSemanticColorWrite(async () => {
    const editorConfig = vscode.workspace.getConfiguration("editor");
    const current = editorConfig.inspect<unknown>("semanticTokenColorCustomizations")?.globalValue;
    const next = withoutRecommendedSemanticColors(current);
    const changed = JSON.stringify(current) !== JSON.stringify(next);
    if (changed) {
      try {
        await editorConfig.update("semanticTokenColorCustomizations", next, vscode.ConfigurationTarget.Global);
      } catch (err) {
        output.appendLine(`[S7 Lint] Failed to remove recommended semantic colors: ${String(err)}`);
        if (showResult) {
          void vscode.window.showErrorMessage(
            'S7 Lint: could not update User Settings -- see the "S7 Lint" output channel.'
          );
        }
        return;
      }
    }
    if (showResult) {
      void vscode.window.showInformationMessage(
        changed
          ? "S7 Lint: automatic recommended semantic colors disabled and managed preset rules removed."
          : "S7 Lint: automatic recommended semantic colors disabled. No managed preset rules were present."
      );
    }
  });
}

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
  const s7resQuickFixProvider = new S7ResQuickFixProvider();

  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      S7DCL_SELECTOR,
      new S7dclSemanticTokensProvider(ruleSet, cacheManager.getBlockIndex(), () => cacheManager.getTypeCacheResult()),
      semanticTokensLegend
    ),
    vscode.languages.registerHoverProvider(
      S7DCL_SELECTOR,
      new S7dclHoverProvider(ruleSet, cacheManager.getBlockIndex(), () => cacheManager.getTypeCacheResult())
    ),
    vscode.languages.registerDefinitionProvider(
      S7DCL_SELECTOR,
      new S7dclDefinitionProvider(ruleSet, cacheManager.getBlockIndex(), () => cacheManager.getTypeCacheResult())
    ),
    vscode.languages.registerDefinitionProvider(S7RES_SELECTOR, new S7ResDefinitionProvider()),
    vscode.languages.registerRenameProvider(
      S7DCL_SELECTOR,
      new S7dclRenameProvider(ruleSet, cacheManager.getBlockIndex(), () => cacheManager.getTypeCacheResult())
    ),
    vscode.languages.registerRenameProvider(S7RES_SELECTOR, new S7ResRenameProvider()),
    vscode.languages.registerCompletionItemProvider(
      S7DCL_SELECTOR,
      new S7dclCompletionProvider(ruleSet, cacheManager.getBlockIndex(), () => cacheManager.getTypeCacheResult()),
      ...S7_COMPLETION_TRIGGER_CHARACTERS
    ),
    vscode.languages.registerCodeActionsProvider(
      S7DCL_SELECTOR,
      new InstanceQuickFixProvider(ruleSet, cacheManager.getBlockIndex(), () => cacheManager.getTypeCacheResult()),
      InstanceQuickFixProvider.metadata
    ),
    vscode.languages.registerCodeActionsProvider(
      S7DCL_SELECTOR,
      new ExprConversionQuickFixProvider(ruleSet, cacheManager.getBlockIndex(), () => cacheManager.getTypeCacheResult()),
      ExprConversionQuickFixProvider.metadata
    ),
    vscode.languages.registerCodeActionsProvider(
      S7DCL_SELECTOR,
      new RegistryQuickFixProvider(ruleSet, cacheManager.getBlockIndex(), () => cacheManager.getTypeCacheResult()),
      RegistryQuickFixProvider.metadata
    ),
    vscode.languages.registerCodeActionsProvider(
      S7DCL_SELECTOR,
      new SafetyCallQuickFixProvider(),
      SafetyCallQuickFixProvider.metadata
    ),
    vscode.languages.registerCodeActionsProvider(
      S7DCL_SELECTOR,
      s7resQuickFixProvider,
      S7ResQuickFixProvider.metadata
    ),
    vscode.languages.registerCodeActionsProvider(
      S7RES_SELECTOR,
      s7resQuickFixProvider,
      S7ResQuickFixProvider.metadata
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

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(lintDocumentAndMlcSibling));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(lintDocumentAndMlcSibling));

  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const key = e.document.uri.toString();
      const existing = debounceTimers.get(key);
      if (existing) clearTimeout(existing);
      debounceTimers.set(
        key,
        setTimeout(() => lintDocumentAndMlcSibling(e.document), 400)
      );
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnosticCollection.delete(doc.uri);
      const sibling = findOpenMlcSibling(doc);
      if (sibling) lintDocument(sibling);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((e) => {
      mlcHints.refresh(e);
      if (e && S7_LANGUAGE_IDS.has(e.document.languageId)) void ensureRecommendedSemanticColors(false);
    })
  );
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => mlcHints.refreshAllVisible()));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tiaLint.mlcLocale")) mlcHints.refreshAllVisible();
      if (e.affectsConfiguration(RECOMMENDED_SEMANTIC_COLORS_SETTING)) {
        if (recommendedSemanticColorsEnabled()) void ensureRecommendedSemanticColors(false);
        else void removeRecommendedSemanticColors(false);
      }
    })
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      const editor = vscode.window.activeTextEditor;
      if (editor && S7_LANGUAGE_IDS.has(editor.document.languageId)) void ensureRecommendedSemanticColors(false);
    })
  );

  relintAllOpen();
  if (vscode.window.activeTextEditor && S7_LANGUAGE_IDS.has(vscode.window.activeTextEditor.document.languageId)) {
    void ensureRecommendedSemanticColors(false);
  }

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
  context.subscriptions.push(
    vscode.commands.registerCommand(INSTALL_RECOMMENDED_SEMANTIC_COLORS_COMMAND, async () => {
      await vscode.workspace
        .getConfiguration("tiaLint")
        .update("recommendedSemanticColors.enabled", true, vscode.ConfigurationTarget.Global);
      await ensureRecommendedSemanticColors(true, true);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(DISABLE_RECOMMENDED_SEMANTIC_COLORS_COMMAND, async () => {
      await vscode.workspace
        .getConfiguration("tiaLint")
        .update("recommendedSemanticColors.enabled", false, vscode.ConfigurationTarget.Global);
      await removeRecommendedSemanticColors(true);
    })
  );

  // --- reacting to registry edits -----------------------------------------

  /** Re-reads the registry from disk after something wrote to it. Every
   * provider, the cache manager and this module's own `lintDocument` captured
   * `ruleSet` BY REFERENCE when they were constructed, so the fresh data is
   * copied ONTO that same object rather than rebound -- rebinding would leave
   * every one of them pointing at the stale set. */
  const reloadRuleSet = (): boolean => {
    try {
      Object.assign(ruleSet, loadRuleSet(resourcesDir));
      return true;
    } catch (err) {
      output.appendLine(`[S7 Lint] Failed to reload rules after a registry edit: ${String(err)}`);
      vscode.window.showErrorMessage('S7 Lint: the registry was written but could not be reloaded -- see the "S7 Lint" output channel.');
      return false;
    }
  };

  // Saving in the Instruction Registry Editor takes effect immediately:
  // without this the linter kept serving the rule set loaded at activation,
  // so a corrected entry only showed up after reloading the window.
  context.subscriptions.push(
    RegistryEditorPanel.onDidSave(async (savedFiles) => {
      if (!reloadRuleSet()) return;
      // The UDT/type cache is built FROM the rule set (see CacheManager's own
      // `buildTypeCache(this.ruleSet, files)`), so a system-types.yaml change
      // needs the cache rebuilt too -- reloading the rule set alone would
      // leave symbol resolution using the old type table. Gated on that file
      // actually having been written, because a rebuild re-parses every UDT
      // and block file in the workspace and the common case (an
      // instruction-registry edit) doesn't affect the cache at all.
      if (savedFiles.includes(EXTERNAL_REGISTRY_FILES.systemTypes)) {
        await cacheManager.rebuild(); // fires onDidRebuild -> relintAllOpen
      } else {
        relintAllOpen();
      }
      output.appendLine(
        `[S7 Lint] Registry saved (${savedFiles.length} file(s)); reloaded ` +
          `${Object.keys(ruleSet.instructions).length} instructions, ${Object.keys(ruleSet.sclInstructions).length} SCL instructions, ` +
          `${Object.keys(ruleSet.systemTypes).length} system types.`
      );
    }),
    new vscode.Disposable(() => RegistryEditorPanel.disposeEmitter())
  );

  /** Shared tail of both registry Quick Fixes: refuse while the editor panel
   * holds unsaved work, run the edit, then reload rules + re-lint so the
   * diagnostic disappears without the user having to touch the file. The
   * offered "Open registry editor" lands directly ON `reveal`'s entry, so
   * finishing a scaffold (or double-checking a flipped flag) doesn't start
   * with hunting through a collapsed tree. */
  const applyRegistryEdit = (
    run: () => RegistryEditResult,
    successMessage: (relPath: string) => string,
    reveal: RevealEntryTarget
  ): void => {
    if (RegistryEditorPanel.hasUnsavedChanges()) {
      void vscode.window.showWarningMessage(
        "S7 Lint: the Instruction Registry Editor has unsaved changes. Save or revert them first, then apply this fix."
      );
      return;
    }
    const result = run();
    if (!result.ok) {
      void vscode.window.showErrorMessage(`S7 Lint: ${result.reason ?? "the registry edit failed."}`);
      return;
    }
    if (!reloadRuleSet()) return;
    RegistryEditorPanel.refreshAfterExternalEdit();
    relintAllOpen();
    void vscode.window
      .showInformationMessage(successMessage(result.relPath ?? ""), `Open '${reveal.name}' in registry editor`)
      .then((choice) => {
        if (choice) RegistryEditorPanel.createOrShow(context, resourcesDir, output, reveal);
      });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(MARK_PIN_OPTIONAL_COMMAND, (args: MarkPinOptionalArgs) => {
      const pins = args.pinNames.join(", ");
      applyRegistryEdit(
        () => setPinsRequired(resourcesDir, args.instructionName, args.pinNames, false, args.scl),
        (relPath) => `S7 Lint: marked ${pins} optional on '${args.instructionName}' in ${relPath}.`,
        { name: args.instructionName, scl: args.scl }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(SCAFFOLD_INSTRUCTION_COMMAND, async (args: ScaffoldInstructionArgs) => {
      // The one thing a call site genuinely cannot reveal -- it decides which
      // family file the entry is filed in, so it has to be asked rather than
      // defaulted to whatever happens to be first.
      const family = await vscode.window.showQuickPick(KNOWN_FAMILIES, {
        title: `Add '${args.instructionName}' to the instruction registry`,
        placeHolder: "Which instruction family does it belong to?",
      });
      if (!family) return;
      applyRegistryEdit(
        () =>
          scaffoldInstruction(resourcesDir, {
            instructionName: args.instructionName,
            family,
            scl: args.scl,
            callShape: args.callShape,
            instanceType: args.instanceType,
            pins: args.pins,
          }),
        (relPath) =>
          `S7 Lint: scaffolded '${args.instructionName}' in ${relPath} (confidence: shape-only). ` +
          "Complete its pin directions and data types against Siemens' documentation.",
        { name: args.instructionName, scl: args.scl }
      );
    })
  );
}

function normalizedFsPath(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Reads a related file from its unsaved open buffer when possible, then
 * falls back to disk. This keeps both directions of MLC cross-reference
 * diagnostics accurate while either sibling is being edited. */
function readDocumentOrFile(fsPath: string): string | undefined {
  const wanted = normalizedFsPath(fsPath);
  const open = vscode.workspace.textDocuments.find((doc) => normalizedFsPath(doc.uri.fsPath) === wanted);
  if (open) return open.getText();
  try {
    return fs.readFileSync(fsPath, "utf8");
  } catch {
    return undefined;
  }
}

function siblingSourceText(resPath: string): string | undefined {
  const stem = resPath.replace(/\.s7res$/i, "");
  return readDocumentOrFile(`${stem}.s7dcl`) ?? readDocumentOrFile(`${stem}.udt`);
}

function findOpenMlcSibling(doc: vscode.TextDocument): vscode.TextDocument | undefined {
  const fsPath = doc.uri.fsPath;
  const lower = fsPath.toLowerCase();
  const candidates = lower.endsWith(".s7res")
    ? [fsPath.replace(/\.s7res$/i, ".s7dcl"), fsPath.replace(/\.s7res$/i, ".udt")]
    : /\.(s7dcl|udt)$/i.test(fsPath)
      ? [siblingS7ResPath(fsPath)]
      : [];
  const wanted = new Set(candidates.map(normalizedFsPath));
  return vscode.workspace.textDocuments.find((candidate) => wanted.has(normalizedFsPath(candidate.uri.fsPath)));
}

function lintDocumentAndMlcSibling(doc: vscode.TextDocument): void {
  lintDocument(doc);
  const sibling = findOpenMlcSibling(doc);
  if (sibling) lintDocument(sibling);
}

function lintDocument(doc: vscode.TextDocument): void {
  const fsPath = doc.uri.fsPath;
  const isS7dcl = fsPath.toLowerCase().endsWith(".s7dcl");
  const isScl = fsPath.toLowerCase().endsWith(".scl");
  const isS7res = fsPath.toLowerCase().endsWith(".s7res");
  const isUdtSource = cacheManager.isUdtSource(fsPath);
  if (!isS7dcl && !isScl && !isS7res && !isUdtSource) return;

  const diagnostics: vscode.Diagnostic[] = [];

  if (isS7res) {
    const sourceText = siblingSourceText(fsPath);
    for (const d of checkS7res(doc.getText(), ruleSet, sourceText)) diagnostics.push(toVscodeDiagnostic(doc, d));
  } else if (isScl) {
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
        for (const d of checkInstructions(block, ruleSet, blockIndex)) {
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
        for (const d of checkMainSafetyBlockInterface(block, ruleSet)) {
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

  if (/\.(s7dcl|udt)$/i.test(fsPath)) {
    const resourceText = readDocumentOrFile(siblingS7ResPath(fsPath));
    for (const d of checkMlcReferences(doc.getText(), resourceText, ruleSet)) diagnostics.push(toVscodeDiagnostic(doc, d));
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
