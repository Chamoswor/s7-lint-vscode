// LAD-only rule: every RUNG's own `wire#X` header must trace back to
// `wire#powerrail` -- the always-present implicit left power rail every
// LAD rung effectively starts from (FBD has no such concept, per the
// scripts/fixtures/reference/lad-fbd-wiring's export pair documents an untranslatable
// "unfinished branches" network -- TIA itself refuses to compile a branch
// left dangling with no route back to the rail).
//
// The interoperability summary in
// docs/source-document-format/language-encoding.md describes the invariant:
// a LAD rung starts at the power rail or at a wire label introduced by a
// connected rung in the same network. The module tests cover a multi-branch
// graph with both a branch tap and a later merge.
//
// Built as a small directed graph over one NETWORK's own RUNGs:
//   - a RUNG's `wireHeader` is a node THIS rung starts from.
//   - a RUNG's `bodyWireLabels` (inline `wire#X` branch taps) and
//     `endWireLabel` (trailing `END_RUNG wire#X`) each DECLARE a wire --
//     reachable the moment the DECLARING rung's own header becomes
//     reachable.
// `wire#powerrail` seeds reachability; a fixpoint pass propagates it
// through however many hops of branch taps a real export nests. Any RUNG
// whose header never becomes reachable is disconnected wiring.
import { NetworkNode, ParsedBlockFile } from "../parser/s7dclParser";
import { RuleSet } from "../rules/types";
import { formatDiagnostic, LintDiagnostic } from "./diagnostics";

const POWERRAIL = "powerrail";

function checkNetworkWiringRoots(network: NetworkNode, ruleSet: RuleSet): LintDiagnostic[] {
  // Only a NETWORK confirmed LAD has a power rail at all -- FBD's box
  // wiring has no equivalent, and a network with no S7_Language pragma
  // at all isn't guessed at either way.
  const language = network.pragma?.S7_Language;
  if (!language || language.toUpperCase() !== "LAD") return [];

  const reachable = new Set<string>([POWERRAIL]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const rung of network.rungs) {
      if (!rung.wireHeader || !reachable.has(rung.wireHeader.name)) continue;
      for (const tap of rung.bodyWireLabels) {
        if (!reachable.has(tap.name)) {
          reachable.add(tap.name);
          changed = true;
        }
      }
      if (rung.endWireLabel && !reachable.has(rung.endWireLabel.name)) {
        reachable.add(rung.endWireLabel.name);
        changed = true;
      }
    }
  }

  const diags: LintDiagnostic[] = [];
  for (const rung of network.rungs) {
    if (!rung.wireHeader || rung.wireHeader.name.toLowerCase() === POWERRAIL) continue;
    if (reachable.has(rung.wireHeader.name)) continue;
    diags.push(formatDiagnostic(ruleSet, "lad-wire-not-rooted", rung.wireHeader.line, rung.wireHeader.col, { wireName: rung.wireHeader.name }));
  }
  return diags;
}

export function checkLadWiring(block: ParsedBlockFile, ruleSet: RuleSet): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  for (const network of block.networks) diags.push(...checkNetworkWiringRoots(network, ruleSet));
  return diags;
}
