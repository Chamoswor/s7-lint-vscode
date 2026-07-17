# SCL diagnostic fixture suite

This directory contains focused fixtures for syntax recovery and semantic
diagnostics. It is split into two assertion styles because they answer
different regression questions.

## Layout

- `positive/`: complete source files that must produce no diagnostics.
- `negative/parser/`: one malformed syntax shape per file.
- `negative/semantic/`: syntactically valid code that violates one semantic rule.
- `manifest.yaml`: expected severity and metadata for every positive/negative fixture.
- `annotated/`: compact expression-type scenarios with inline `EXPECT-*` assertions.

## Manifest suite

Run from the `LintServer` directory:

```text
npm run test:manifest
```

The manifest runner loads every listed file through the same SCL lint pipeline
as the extension. Its contract is intentionally broad:

- a positive fixture must produce exactly zero diagnostics;
- a negative fixture must produce at least one diagnostic with the declared
  severity;
- additional cascade diagnostics are currently tolerated.

The runner does not compare diagnostic codes, source ranges, or full message
text. The manifest's `rule` and `registrySource` fields document intent and
provenance; they are not assertion keys.

## Annotated expression suite

Run:

```text
npm run test:annotated
```

Each `EXPECT-PASS`, `EXPECT-WARNING`, or `EXPECT-ERROR` comment applies to the
nearest non-comment statement above it. This runner is strict on that statement
line: pass means zero diagnostics, while warning/error means exactly one
diagnostic of the requested severity.

The two files have complementary roles:

- `annotated/expression-type-valid.scl` guards accepted arithmetic,
  conversions, comparisons, Boolean expressions, and bit-string expressions.
- `annotated/expression-type-diagnostics.scl` guards rejected combinations,
  implicit-conversion warnings, nested-error propagation, and recovery after an
  earlier error.

## Adding or changing fixtures

Keep one intended defect per negative manifest file. Missing block terminators
can alter the rest of a parse tree, so unrelated defects should not share a
fixture. Add every manifest fixture to `manifest.yaml` and state the expected
severity explicitly.

For annotated scenarios, use a unique human-readable ID and place the
`EXPECT-*` marker immediately after the subject statement. Do not snapshot full
diagnostic wording; messages can improve without changing rule behavior.

The semantic cases derive from the registries under `resources/`, especially
`composition-rules.yaml`, `references.yaml`, and `section-legality.yaml`.
Unresolved coverage questions remain documented in `knownRegistryIssues` at
the end of `manifest.yaml`.
