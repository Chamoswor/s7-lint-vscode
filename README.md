# TIA S7 Lint Server

TIA S7 Lint Server is a VS Code extension for static analysis and editor
support for Siemens TIA Portal source and export formats.

This is an independent open-source project. It is not an official Siemens
product and is not affiliated with, endorsed by, sponsored by, or maintained by
Siemens AG. Siemens, SIMATIC, TIA Portal, and other product names are trademarks
of their respective owners.

The extension is currently version `0.1.0` and under active development. It is
intended to catch common structural, type, symbol, and instruction-call errors
before code is imported or compiled in TIA Portal. It is not a replacement for
the target CPU and TIA Portal compiler.

## Supported files

- `.scl`: authored SCL files containing one or more block or type declarations.
- `.s7dcl`: LAD/FBD declaration exports, program blocks, and `TYPE` declarations.
- `.udt`: text-format PLC data type declarations.
- `PLC data types/**/*.xml`: XML PLC data type exports used by the workspace type
  cache.
- `.s7res`: multilingual resources used by definition, rename, and inline-hint
  support.

## Current capabilities

### Diagnostics

- Validates LAD/FBD and SCL instruction names, pins or parameters, call shape,
  language availability, templates, results, and selected memory-area rules
  against the registries under [`resources/`](resources/).
- Checks LAD/FBD rung connectivity back to `wire#powerrail`.
- Checks SCL syntax structure, undeclared identifiers, illegal member access,
  condition types, expression types, conversions, loop constraints, and
  instruction-result usage.
- Checks literals and resolvable operands against declared or expected types.
- Builds a workspace type cache for UDT dependencies, duplicate declarations,
  circular references, array bounds, and nesting limits.
- Applies declaration-section, reference, pointer, array, and selected
  cross-parameter rules where the required context is available.

The parser and checks are deliberately conservative: when a type, target, or
expression cannot be resolved confidently, the extension avoids guessing.

### Editor support

- Context-aware completion for declarations, types, instructions, symbols, and
  top-level block templates.
- Hover, definition, rename, and semantic-token providers.
- Definition and rename support for `.s7res` multilingual resources.
- Quick fixes for explicit expression conversions and instruction instances.
- Inline multilingual-text hints with configurable locale fallback.

## Knowledge bases

The YAML under `resources/` is hand-maintained source data and is loaded
directly at runtime:

- [`instruction-registry/`](resources/instruction-registry/README.md): LAD/FBD
  and SCL instruction signatures.
- [`type-registry/`](resources/type-registry/README.md): base types, system
  types, expression domains, composition rules, and declaration constraints.
- [`diagnostic-registry/`](resources/diagnostic-registry/README.md): diagnostic
  codes, severities, and message templates.
- `system-registry/`: shared memory-area and instruction-result schemas.

There is no generated mirror or synchronization step for these registries.

## Repository layout

```text
./
  src/                         extension, parsers, analysis, providers, linters
  resources/                   runtime YAML registries
  docs/fbd-knowhow/            LAD/FBD syntax and fixture-derived notes
  docs/source-document-format/ independent source-format interoperability notes
  scripts/                     test runners and stable fixtures
  syntaxes/                    VS Code language grammar and configuration
  themes/                      bundled VS Code theme
```

## Build and test

Run commands from the repository root:

```text
npm install
npm test
```

`npm test` compiles the extension and runs all regression suites:

| Command | Scope |
|---|---|
| `npm run test:completion` | completion and context classification |
| `npm run test:quickfix` | instance-generation quick fixes |
| `npm run test:manifest` | manifest-driven parser and semantic diagnostics |
| `npm run test:annotated` | exact line-annotated expression diagnostics |
| `npm run test:smoke` | anonymized SCL and graphical-control fixtures |

The diagnostic fixtures and their assertion contracts are documented in
[`scripts/fixtures/scl-diagnostics/`](scripts/fixtures/scl-diagnostics/README.md).

Press **F5** in VS Code with this directory open to launch an Extension
Development Host. The launch configuration compiles the extension first.

## Package a VSIX

```text
npm run compile
npx @vscode/vsce package
```

## Commands and settings

The extension contributes these commands:

- **TIA Lint: Rebuild Type Cache**
- **TIA Lint: Re-lint All Open Files**
- **TIA Lint: Show Loaded Rule Stats**

`tiaLint.mlcLocale` selects the preferred locale for multilingual resource
resolution. Resolution falls back to `en-US` and then to an available locale.

## Known limitations

- Target CPU family and firmware are not project configuration inputs yet.
  [`platform-availability.NOTLOADED.yaml`](resources/type-registry/platform-availability.NOTLOADED.yaml)
  is reference data and is intentionally not loaded.
- Type checks skip unresolved symbols and expression shapes for which a safe,
  single result type cannot be inferred.
- XML UDT parsing has no per-member source positions, so XML cache diagnostics
  are reported on line 1.
- The workspace type and block caches rebuild in full after relevant file
  changes rather than incrementally.
- `shape-only` registry entries provide useful call-shape validation but do not
  justify the same hard-error confidence as `confirmed-compiled` entries.

Source-format scope and attribution are documented separately in
[`docs/source-document-format/`](docs/source-document-format/README.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
