// Central construction point for every LintDiagnostic the linter emits.
// Before this module existed, each check inlined its own `code`/`severity`/
// message string literal -- resources/diagnostic-registry/*.yaml now holds
// that data instead (one entry per `code`, loaded into `RuleSet.diagnostics`
// by rules/loadRules.ts), and `formatDiagnostic` below is the one place that
// turns a registry entry + a call site's params into a real LintDiagnostic.
// See resources/diagnostic-registry/README.md for the YAML schema.
import { DiagnosticSpec, LintSeverity, RuleSet } from "../rules/types";

export type { LintSeverity } from "../rules/types";

/**
 * What a Quick Fix needs to repair the instruction REGISTRY itself, for the
 * two diagnostics whose usual cause is a gap or a transcription slip in the
 * YAML rather than a mistake in the checked source. Carried structurally
 * (same discipline as `implicitConversionFix`) so no consumer has to parse
 * a name back out of the diagnostic's own prose.
 *
 * `scl` picks WHICH registry half the entry lives in: a dedicated
 * `SCL-*.yaml` file (`RuleSet.sclInstructions`) or the shared LAD/FBD one
 * (`RuleSet.instructions`). The two can hold entries under the same name
 * with genuinely different pin data -- see `RuleSet.sclInstructions`'s own
 * comment -- so editing the wrong one would silently do nothing.
 */
export type RegistryFix =
  /** A pin the registry marks `required: true` but the call didn't fill.
   * Offered as "mark it optional" because a mis-transcribed `required`
   * flag is the far more common cause than a genuinely wrong call. */
  | { kind: "pin-required"; instructionName: string; pinName: string; scl: boolean }
  /** A call whose name isn't in the registry at all. `pinNames` are the
   * NAMED arguments the call site actually passes, usable to seed a
   * scaffold entry. Only set for a plain `Name(...)` call shape -- an
   * instance call would also need an `instanceType` and a matching system
   * type, which can't be derived from a call site. */
  | { kind: "unknown-instruction"; instructionName: string; scl: boolean; pinNames: string[] };

export interface LintDiagnostic {
  line: number;
  col: number;
  severity: LintSeverity;
  message: string;
  code: string;
  /** See `RegistryFix`. Undefined for every other diagnostic. */
  registryFix?: RegistryFix;
  /** For `expr-implicit-numeric-conversion` only: the exact source span of
   * the right-hand operand a Quick Fix should wrap in an explicit
   * `{rightType}_TO_{leftType}(...)` conversion call, carried structurally
   * rather than re-derived from `message`'s own prose or re-parsed from
   * raw text -- see linter/exprTypeChecks.ts's `evalBinary` (the only
   * place this gets set) and providers/exprConversionQuickFixProvider.ts
   * (the only reader). `line`/`col`/`endLine`/`endCol` mirror
   * parser/s7dclParser.ts's own `SclExprNode` position convention
   * (1-based, `end*` is the position immediately AFTER the last token).
   * Undefined for every other diagnostic. */
  implicitConversionFix?: {
    leftType: string;
    rightType: string;
    rightLine: number;
    rightCol: number;
    rightEndLine: number;
    rightEndCol: number;
  };
}

/** Values substituted into a template's `{name}` placeholders -- always
 * pre-formatted strings/numbers (e.g. a joined pin list, a quoted tag name),
 * never raw objects, since formatDiagnostic does nothing beyond a literal
 * string replace. */
export type DiagnosticParams = Record<string, string | number>;

function resolveTemplate(code: string, spec: DiagnosticSpec, variant: string | undefined): string {
  if (variant) {
    const tmpl = spec.variants?.[variant];
    if (tmpl === undefined) throw new Error(`diagnostic-registry: code '${code}' has no variant '${variant}'`);
    return tmpl;
  }
  if (spec.message === undefined) {
    throw new Error(`diagnostic-registry: code '${code}' has no base 'message' -- did you mean to pass a 'variant'?`);
  }
  return spec.message;
}

/** Builds one LintDiagnostic from a resources/diagnostic-registry/*.yaml
 * entry: looks up `code`, fills its `{name}` placeholders from `params`
 * (every placeholder in the chosen template must have a matching param --
 * an internal fill-in bug, not "don't guess" territory, so this throws
 * rather than silently emitting `{name}` literally), and applies severity.
 *
 * `options.severity` overrides the registry's own default -- for the
 * several codes whose real severity depends on a DIFFERENT registry's data
 * (e.g. an instruction-registry entry's `confidence: shape-only` downgrades
 * error to warning), that fact belongs in the calling check, not hardcoded
 * here or duplicated per-code in the diagnostic registry itself.
 *
 * `options.variant` selects one of the code's `variants` instead of its
 * base `message`, for the handful of codes whose prose genuinely differs by
 * call site rather than by a filled-in param (see the registry README's
 * "Variants vs. params" section). */
export function formatDiagnostic(
  ruleSet: RuleSet,
  code: string,
  line: number,
  col: number,
  params: DiagnosticParams = {},
  options: { severity?: LintSeverity; variant?: string } = {}
): LintDiagnostic {
  const spec = ruleSet.diagnostics[code];
  if (!spec) throw new Error(`diagnostic-registry: unknown code '${code}' -- add it to resources/diagnostic-registry/*.yaml`);
  const template = resolveTemplate(code, spec, options.variant);
  const message = template.replace(/\{(\w+)\}/g, (_full, key: string) => {
    if (!(key in params)) throw new Error(`diagnostic-registry: code '${code}' template references missing param '{${key}}'`);
    return String(params[key]);
  });
  return { line, col, severity: options.severity ?? spec.severity, code, message };
}
