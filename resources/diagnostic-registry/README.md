# Diagnostic registry

This directory is the source of truth for diagnostic codes, default
severities, and message templates emitted by the extension.

`src/rules/loadRules.ts` loads every `*.yaml` file here except
`_template.yaml` and merges the entries into one flat
`code -> DiagnosticSpec` map. File boundaries are for maintainers only and have
no runtime meaning.

## Files

| File | Primary emitter |
|---|---|
| [instruction-checks.yaml](instruction-checks.yaml) | `src/linter/instructionChecks.ts` |
| [scl-instruction-checks.yaml](scl-instruction-checks.yaml) | `src/linter/sclInstructionChecks.ts` |
| [composition-checks.yaml](composition-checks.yaml) | `src/linter/compositionChecks.ts` |
| [expr-type-checks.yaml](expr-type-checks.yaml) | `src/linter/exprTypeChecks.ts` |
| [symbol-checks.yaml](symbol-checks.yaml) | `src/linter/symbolChecks.ts` |
| [syntax-structure-checks.yaml](syntax-structure-checks.yaml) | `src/linter/synStructureChecks.ts` |
| [lad-wiring-checks.yaml](lad-wiring-checks.yaml) | `src/linter/ladWiringChecks.ts` |
| [s7res-checks.yaml](s7res-checks.yaml) | `src/linter/s7resChecks.ts` |
| [document-index.yaml](document-index.yaml) | `src/analysis/documentIndex.ts` |
| [shared.yaml](shared.yaml) | diagnostics emitted from more than one module |

Two files must not declare the same code. The loader does not provide a
supported override mechanism; a duplicate would make the later file silently
replace the earlier entry.

## Schema

Copy [`_template.yaml`](_template.yaml) when adding a diagnostic:

```yaml
some-diagnostic-code:
  severity: error
  message: "'{thing}' is invalid because {reason}."
  notes: "Optional maintainer context."
```

Allowed severities are `error`, `warning`, and `information`.

Use `variants` instead of `message` only when different call sites need
different sentence structures:

```yaml
some-contextual-code:
  severity: warning
  variants:
    assignment: "..."
    argument: "..."
```

## Placeholders and variants

`src/linter/diagnostics.ts` replaces each `{name}` placeholder with the value
provided by the caller. A missing placeholder value is an internal registry or
call-site error and throws during linting.

Use a placeholder for values inserted into one stable sentence. Use a variant
when the sentence itself changes by context. Variant keys should describe the
call site, not a data value.

### Variants vs. params

Use a `{param}` when one sentence receives different values. Use `variants`
when the sentence structure changes between call sites. Do not create variants
named after concrete type or symbol values when a placeholder is sufficient.

## Severity: default vs. override

The YAML severity is the default. Some checks intentionally override it from
other registry facts, most commonly instruction confidence:

- `confirmed-compiled` can justify an error;
- `shape-only` normally limits an uncertain check to a warning.

When a code is routinely overridden, document that behavior in its `notes`
field and keep a valid default severity in the schema.

## Where a code belongs

- A code emitted by one module belongs in that module's YAML file.
- A genuinely shared condition emitted by multiple modules belongs in
  `shared.yaml`.
- Different conditions must use different codes even when their wording is
  similar.

## Adding a diagnostic

1. Add the code to the YAML file matching the emitting module, or to
   `shared.yaml` when multiple modules describe the same condition.
2. Call `formatDiagnostic` with every required placeholder and variant.
3. Add or update a regression fixture.
4. Run `npm test` from the `LintServer` directory.
