# S7 Lint for VS Code

[![Download from VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=Chamoswor.s7-lint)

S7 Lint for VS Code is an extension for static analysis and editor
support for Siemens TIA Portal source and export formats.

This is an independent open-source project. It is not an official Siemens
product and is not affiliated with, endorsed by, sponsored by, or maintained by
Siemens AG. Siemens, SIMATIC, TIA Portal, and other product names are trademarks
of their respective owners.

The extension is currently version `0.1.5` and under active development. It is
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
- Accepts the two spellings TIA Portal's own external-source importer accepts:
  a local reference written without its `#` (`IF Active THEN`,
  `SecondTick(IN := ..., PT := ...)`) when the block declares that name, and
  any casing of a type name (`BYTE` and `Byte` are one type). Both are checked
  exactly like their `#`-prefixed / canonically-cased equivalents — a bare word
  the block does NOT declare is still an error.
- Builds a workspace type cache for UDT dependencies, duplicate declarations,
  circular references, array bounds, and nesting limits.
- Applies declaration-section, reference, pointer, array, and selected
  cross-parameter rules where the required context is available.

The parser and checks are deliberately conservative: when a type, target, or
expression cannot be resolved confidently, the extension avoids guessing.

### Editor support

- Context-aware completion for declarations, types, instructions, symbols, and
  top-level block templates, including dotted member completion on instance
  DATA_BLOCKs and quoted external block references. Datatype completion also
  works after `:` inside inline, UDT, and DATA_BLOCK `STRUCT ... END_STRUCT`
  declarations, with or without whitespace around the colon.
- Dotted member completion off a local tag, written `#tag.` or bare `tag.`,
  resolving through workspace FUNCTION_BLOCK/DATA_BLOCK interfaces, UDT fields,
  system-struct fields (`IEC_TIMER`, `ErrorStruct`, …), inline
  `STRUCT … END_STRUCT` fields, and instruction-instance pins — chained to any
  depth across all five, and using SCL's own parameter casing in `.scl`
  (`#edge.CLK`/`edge.Q`, not the graphical `clk`/`q`).
- Hover, definition, rename, and semantic-token providers, including instance
  DATA_BLOCK hovers that resolve to their instruction or FUNCTION_BLOCK type.
  Workspace UDT declarations and their case-insensitive references can be
  renamed directly from the type name.
  Highlighting uses standard VS Code semantic families, so the user's active
  dark or light theme controls every colour. S7-specific semantic subtypes
  retain normal-theme fallbacks while allowing independent styling. The six
  elementary families (`s7TemporalType`, `s7IntegerType`, `s7BooleanType`,
  `s7FloatType`, `s7GenericType`, and `s7TextType`) inherit `type`;
  `s7UdtType` inherits `struct`, `s7CallableType` inherits `class`, and
  `s7CallableInstance` and `s7DataBlock` inherit `variable`, while
  `s7InterfaceMember` inherits `parameter`. Direct call
  expressions remain `function`; plain/UDT-backed DATA_BLOCK storage uses
  `s7DataBlock`, while an FB/instruction instance DB uses
  `s7CallableInstance`. Fields/interface values are `property`/`parameter`;
  a resolved scalar field below an FB/FC Input, Output, or InOut path is an
  `s7InterfaceMember`, preserving the theme's parameter color through nested
  UDT access while containers and indexable segments keep their structural
  colors.
  No S7-specific colour theme is required.
  Two composable capability modifiers refine value occurrences without
  replacing those roles: `s7Container` means the value exposes structured
  members through dotted access, and `s7Indexable` means it supports `[...]`
  (`Array`, `String`, or `WString`). An `ARRAY OF` a UDT/STRUCT carries both;
  a scalar leaf carries neither. The automatic palette gives container,
  indexable, and combined members related but distinct colours, while root
  objects such as DATA_BLOCKs and callable instances keep their identity
  colour.
  Keyword-family tokens are split the way most language grammars split them,
  rather than sharing one colour: control flow (`IF`/`END_IF`/`RETURN`/…),
  type constructors (`STRUCT`/`END_STRUCT` and generic `ARRAY`/`OF`/`REF_TO`), logical
  operators (`NOT`/`AND`/`OR`/`XOR`/`MOD`), and language constants
  (`TRUE`/`FALSE`, `NULL`/`ZERO`). A pragma value is attribute data, not
  program data, so `'TRUE'` in `{ S7_Optimized_Access := 'TRUE' }` reads as
  the string it is rather than as the boolean constant.
- Type names are classified by what the type means for the thing being
  declared, identically at a declaration and at every reference. Elementary
  types are grouped as temporal (`Time`, `Date`, `DTL`, …), integer/bit
  (`Int`, `UInt`, `Byte`, `Word`, …), boolean (`Bool`), floating point
  (`Real`, `LReal`), generic/reference (`Void`, `Variant`, `Any`, `Pointer`,
  `REF_TO`, `ARRAY`/`OF`), and text (`String`, `WString`, `Char`, `WChar`).
  A Siemens record
  (`IEC_TIMER`) remains `struct.defaultLibrary`, a project PLC data type
  (`"KDT_Header"`) as `s7UdtType`, and an FB/instruction instance type
  (`"FB_Pump"`, `TON`) as `s7CallableType`. The declared instance is
  `s7CallableInstance`, becoming `function` only at a direct call site — so
  `Pump : "FB_Pump";` and `Pump(...)` read like object construction and
  invocation in other languages. A global DATA_BLOCK such as
  `"DB_IPC_Comms"` is `s7DataBlock` at its declaration and every reference,
  making global structured storage visually distinct from local variables.
  Composite declarations stay readable through the `ARRAY`/`OF`/`STRUCT`
  keywords themselves. A FUNCTION's return type is coloured on the same
  scheme (it previously had no colour at all).
  Bare, `#`-less local references and unquoted workspace-block calls resolve
  for hover, Ctrl+click, and rename exactly like their prefixed/quoted
  equivalents.
- Hovering a PLC data type or global DATA_BLOCK shows its calculated Siemens
  standard/non-optimized storage size and included padding. Hovering an
  individual declaration name in a UDT `STRUCT`, DATA_BLOCK `VAR`, or inline
  `STRUCT` additionally shows that member's size and container-relative byte
  offset; packed `BOOL` members use `byte.bit` notation. Arrays, sized
  `String`/`WString`, nested structures, and referenced UDTs participate in the
  calculation. If a dependency has no known storage size, the hover lists each
  unresolved member path instead of presenting a guessed total or offset.
- Distinct colors for the S7 datatype and object/callable subtypes activate automatically
  when a supported SCL/declaration/UDT editor becomes active. The preset is
  scoped to the current dark/light theme in User Settings, preserves unrelated
  rules, and upgrades recognized older S7 Lint values without overwriting a
  manually customized S7 selector. High-contrast themes are left unchanged.
  Run **S7 Lint: Disable Recommended Semantic Colors** (or turn off
  `tiaLint.recommendedSemanticColors.enabled`) to remove managed preset rules;
  **Install Recommended Semantic Colors** re-enables/restores the preset.
- Definition and rename support for `.s7res` multilingual resources.
- Quick fixes for explicit expression conversions and instruction/FUNCTION_BLOCK
  instances, including auto-creating a single-instance DATA_BLOCK when
  completing a member on a bare FUNCTION_BLOCK type.
- Quick fixes that repair the instruction registry itself, for the two
  diagnostics usually caused by a gap or a transcription slip in the YAML
  rather than by the checked source: marking a pin optional
  (`missing-required-pin`) and scaffolding a missing entry from its call site
  (`unknown-instruction`). Both reload the rule set and re-lint immediately,
  and can open the registry editor directly on the affected entry.
- Inline multilingual-text hints with configurable locale fallback.
- A visual **Instruction Registry Editor** (`S7 Lint: Open Instruction Registry
  Editor`) for creating, editing, moving, and deleting instruction and
  system-type entries across the registry's YAML files, with schema-driven
  validation, drag-and-drop reordering, undo/redo, and comment/formatting-
  preserving atomic saves. Saving reloads the rule set and re-lints open files
  in place, so an edited entry takes effect without reloading the window.

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
| `npm run test:semantic-colors` | automatic palette installation and migration |
| `npm run test:completion` | completion and context classification |
| `npm run test:rename` | UDT and symbol rename behavior |
| `npm run test:quickfix` | instance-generation quick fixes |
| `npm run test:manifest` | manifest-driven parser and semantic diagnostics |
| `npm run test:annotated` | exact line-annotated expression diagnostics |
| `npm run test:instance-context` | instance-type context legality (VAR sections, call shapes) |
| `npm run test:editor` | instruction registry editor's YAML document model |
| `npm run test:editor-service` | instruction registry editor's service/workspace layer |
| `npm run test:smoke` | anonymized SCL and graphical-control fixtures |

The diagnostic fixtures and their assertion contracts are documented in
[`scripts/fixtures/scl-diagnostics/`](scripts/fixtures/scl-diagnostics/README.md).

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

- Target CPU family and firmware are not project configuration inputs yet.
  [`platform-availability.NOTLOADED.yaml`](resources/type-registry/platform-availability.NOTLOADED.yaml)
  is reference data and is intentionally not loaded.
- A block's "IEC check" property is not visible in any export, so rules it
  toggles cannot be enforced by target. Where the two readings conflict, the
  permissive one is used, because reporting a hard error on code that compiles
  leaves the author nothing to act on. Bit-string arithmetic is the current
  example (see `expression-operators.yaml`).
- A FUNCTION's declared return type is not parsed, so assignments to its result
  variable are recognised but not type-checked.
- Type checks skip unresolved symbols and expression shapes for which a safe,
  single result type cannot be inferred.
- A `+` or `-` written with no space before a digit is lexed as part of the
  number, so unspaced arithmetic (`4-1`) has no operator token left to parse
  and is reported as a missing semicolon. Spaced (`4 - 1`) parses correctly.
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
