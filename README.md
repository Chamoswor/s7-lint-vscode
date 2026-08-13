# S7 Lint for VS Code

[![Download from VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=Chamoswor.s7-lint)

S7 Lint for VS Code is an extension for static analysis and editor
support for Siemens TIA Portal source and export formats.

This is an independent open-source project. It is not an official Siemens
product and is not affiliated with, endorsed by, sponsored by, or maintained by
Siemens AG. Siemens, SIMATIC, TIA Portal, and other product names are trademarks
of their respective owners.

The extension is currently version `0.1.6` and under active development. It is
intended to catch common structural, type, symbol, and instruction-call errors
before code is imported or compiled in TIA Portal. It is not a replacement for
the target CPU and TIA Portal compiler.

## Supported files

- `.scl`: authored SCL files containing one or more block or type declarations.
- `.s7dcl`: LAD/FBD declaration exports, program blocks, and `TYPE` declarations.
- `.udt`: text-format PLC data type declarations.
- `**/*.xml`: TIA XML exports, anywhere in the workspace. PLC data type exports
  feed the workspace type cache; DATA_BLOCK exports (`SW.Blocks.InstanceDB`/
  `GlobalDB`) feed the block index, so references to an instance DB resolve even
  though TIA writes it in a different format from the FUNCTION_BLOCK it
  instances. Every file is offered to both parsers -- they key off different
  root elements -- because export layout does not reliably separate the two.
- `.s7res`: multilingual resources with YAML/schema/duplicate-ID validation,
  MLC cross-reference diagnostics, definition, rename, and inline-hint support.

## Current capabilities

### Diagnostics

- **SCL source:** Checks syntax structure, symbols, member access, conditions,
  expressions, conversions, loops, literals, and instruction-result usage.
- **Instruction calls:** Validates LAD/FBD and SCL names, pins, parameters, call
  shapes, templates, result use, language support, and selected memory rules
  against the registries under [`resources/`](resources/).
- **Graphical networks:** Checks LAD/FBD rung connectivity back to
  `wire#powerrail`.
- **Workspace symbols and types:** Resolves PLC tags from XML exports in `.scl`
  and `.s7dcl`, and checks UDT dependencies, duplicate declarations, circular
  references, array bounds, and nesting limits.
- **Declarations and data access:** Applies section, reference, pointer, array,
  operand-type, and selected cross-parameter rules when enough context exists.
- **Multilingual resources:** Validates `.s7res` structure, IDs, text values,
  MLC references, and orphaned entries before TIA Portal import.

Bare local names without `#` and differently cased type names are recognized
the same way as by TIA Portal's external-source importer and receive the same
validation as their canonical forms.

The parser and checks are deliberately conservative: when a type, target, or
expression cannot be resolved confidently, the extension avoids guessing.

### Editor support

- **Completion:** Context-aware suggestions for declarations, data types,
  instructions, symbols, and block templates. Chained member completion works
  across local tags, UDTs, inline structures, system types, FUNCTION_BLOCKs,
  DATA_BLOCKs, and instruction instances.
- **Navigation and refactoring:** Hover, definition, and rename support for
  local and workspace symbols, including bare SCL names, UDTs, blocks, and
  instance DATA_BLOCKs.
- **Semantic highlighting:** Distinguishes elementary and project data types,
  callable types and instances, DATA_BLOCKs, interface members, containers,
  indexable values, operators, constants, and control-flow keywords. It follows
  the active VS Code theme, with an optional managed S7 color preset.
- **Storage layout:** Hover shows calculated size, padding, byte offsets, and
  packed `BOOL` bit positions for resolvable UDT, DATA_BLOCK, array, string, and
  nested-structure layouts.
- **Quick fixes:** Adds explicit conversions, generates local or single-instance
  DATA_BLOCKs, creates or repairs sibling `.s7res` files and MLC entries, and
  fixes supported instruction-registry gaps.
- **Multilingual resources:** Definition, rename, and inline text hints for
  `.s7res`, with configurable locale fallback.
- **Instruction Registry Editor:** A visual editor for instruction and system-
  type YAML with validation, drag-and-drop ordering, undo/redo, and automatic
  rule reload and re-lint after saving.

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
  scripts/                     test runners and fixtures (source repository only)
  syntaxes/                    VS Code language grammar and configuration
  themes/                      bundled VS Code theme
```

## Build and test

The published VSIX excludes `scripts/**`. Test commands are development
workflows and must be run from a source checkout. All test runners and fixtures
are available in the GitHub repository under
[`scripts/`](https://github.com/Chamoswor/s7-lint-vscode/tree/main/scripts).

Run commands from the repository root:

```text
npm install
npm test
```

`npm test` compiles the extension and runs all regression suites. The focused
commands below link to their test runners in the GitHub repository:

| Command | Scope | Test runner |
|---|---|---|
| `npm run test:s7res` | multilingual-resource diagnostics | [`test-s7res-checks.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/test-s7res-checks.js) |
| `npm run test:s7res-quickfix` | multilingual-resource quick fixes | [`test-s7res-quickfix.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/test-s7res-quickfix.js) |
| `npm run test:plc-tags` | PLC-tag resolution from XML exports | [`test-plc-tags.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/test-plc-tags.js) |
| `npm run test:semantic-colors` | automatic palette installation and migration | [`test-semantic-colors.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/test-semantic-colors.js) |
| `npm run test:completion` | completion and context classification | [`test-completion-context.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/test-completion-context.js) |
| `npm run test:rename` | UDT and symbol rename behavior | [`test-rename.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/test-rename.js) |
| `npm run test:quickfix` | instance-generation quick fixes | [`test-instance-quickfix.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/test-instance-quickfix.js) |
| `npm run test:registry-quickfix` | instruction-registry quick fixes | [`test-registry-quickfix.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/test-registry-quickfix.js) |
| `npm run test:manifest` | manifest-driven parser and semantic diagnostics | [`run-manifest-smoke-tests.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/run-manifest-smoke-tests.js) |
| `npm run test:annotated` | exact line-annotated expression diagnostics | [`run-annotated-diagnostic-tests.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/run-annotated-diagnostic-tests.js) |
| `npm run test:instance-context` | instance-type context legality (VAR sections, call shapes) | [`test-instance-type-context.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/test-instance-type-context.js) |
| `npm run test:editor` | instruction registry editor's YAML document model | [`test-instruction-editor.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/test-instruction-editor.js) |
| `npm run test:editor-service` | instruction registry editor's service/workspace layer | [`test-editor-service.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/test-editor-service.js) |
| `npm run test:smoke` | anonymized SCL and graphical-control fixtures | [`smoke-test.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/smoke-test.js) |

The optional `npm run test:highlight` command uses
[`test-semantic-highlighting.js`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/test-semantic-highlighting.js)
from the same GitHub directory.

The diagnostic fixtures and their assertion contracts are documented in
[`scripts/fixtures/scl-diagnostics/`](https://github.com/Chamoswor/s7-lint-vscode/tree/main/scripts/fixtures/scl-diagnostics).

Press **F5** in VS Code with this directory open to launch an Extension
Development Host. The launch configuration compiles and bundles the extension
first.

## Package a VSIX

```text
npm run bundle
npx @vscode/vsce package
```

## Commands and settings

The extension contributes these commands:

- **S7 Lint: Rebuild Type Cache**
- **S7 Lint: Re-lint All Open Files**
- **S7 Lint: Show Loaded Rule Stats**
- **S7 Lint: Open Instruction Registry Editor**
- **S7 Lint: Install Recommended Semantic Colors**
- **S7 Lint: Disable Recommended Semantic Colors**

Two further commands back the registry quick fixes
(`tiaLint.registryMarkPinOptional`, `tiaLint.registryScaffoldInstruction`).
They take arguments supplied by the diagnostic, so they are hidden from the
command palette and are invoked from the lightbulb only.

`tiaLint.mlcLocale` selects the preferred locale for multilingual resource
resolution. Resolution falls back to `en-US` and then to an available locale.

`tiaLint.recommendedSemanticColors.enabled` controls automatic installation of
the theme-scoped S7 semantic palette. Disabling it removes only values managed
by S7 Lint and preserves unrelated or manually customized semantic colors.

## Known limitations

- **Target-specific validation:** CPU family, firmware, and a block's IEC-check
  setting are not available from the supported project sources. Platform data
  in
  [`platform-availability.NOTLOADED.yaml`](resources/type-registry/platform-availability.NOTLOADED.yaml)
  is therefore not loaded. When IEC modes permit different results, the linter
  uses the permissive interpretation; bit-string arithmetic is one example.
- **FUNCTION result types:** The result variable is recognized, but its declared
  return type is not retained by the parser. Assignments to it are therefore
  not type-checked.
- **Incomplete type information:** Checks that require an unresolved symbol or
  an expression without one safely inferred type are skipped instead of
  guessed.
- **Operator spacing:** The lexer treats `+` or `-` immediately followed by a
  digit as part of a signed number. Consequently, `4-1` loses its subtraction
  operator and can produce a missing-semicolon diagnostic; use `4 - 1`.
- **XML source locations:** XML UDT members do not retain source positions, so
  related cache diagnostics point to line 1 instead of the exact member.
- **Workspace updates:** Relevant file changes rebuild the complete type and
  block caches rather than updating only the affected entries.
- **Registry confidence:** Checks based on `shape-only` instruction entries are
  generally warnings. Hard errors require stronger evidence such as
  `confirmed-compiled` data.

Source-format scope and attribution are documented separately in
[`docs/source-document-format/`](docs/source-document-format/README.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
