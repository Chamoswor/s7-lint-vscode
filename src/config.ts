// Small shared helper for the extension's own settings (contributed in
// package.json's `contributes.configuration`) -- kept out of
// analysis/documentIndex.ts, which stays vscode-free so scripts/smoke-test.js
// can exercise it under plain Node.
import * as vscode from "vscode";
import { LintOptions } from "./linter/diagnostics";
import { isTargetPlatform } from "./rules/platformAvailability";

/** `tiaLint.mlcLocale`: the user's preferred locale (e.g. `en-US`, `de-DE`)
 * for resolving an `S7_MLC`/`S7_NetworkTitle`/`S7_NetworkComment`/
 * `S7_BlockTitle`/`S7_BlockComment` pragma's ID against its block's
 * `.s7res` MultiLingualTexts file. `resolveMlcText` (parser/s7resParser.ts)
 * falls back to `en-US`, then to whichever locale is present, when the
 * preferred one is missing for a given ID. */
export function getMlcLocale(scope?: vscode.Uri): string {
  return vscode.workspace.getConfiguration("tiaLint", scope).get<string>("mlcLocale", "en-US");
}

/** `tiaLint.targetPlatform` and `tiaLint.iecCheck`: what the user states
 * about the target that exported sources don't record -- see `LintOptions`.
 * A platform name the registry has no column for counts as unset. */
export function getLintOptions(scope?: vscode.Uri): LintOptions {
  const config = vscode.workspace.getConfiguration("tiaLint", scope);
  const targetPlatform = config.get<string>("targetPlatform", "");
  return {
    targetPlatform: isTargetPlatform(targetPlatform) ? targetPlatform : undefined,
    iecCheck: config.get<boolean>("iecCheck", false),
  };
}
