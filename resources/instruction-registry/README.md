# Instruction signature registry

This directory contains the instruction signatures used to validate LAD/FBD
exports and authored SCL. The YAML is loaded directly at runtime; it is not
generated from another directory.

The registry describes facts such as instruction name, language, call shape,
instance type, parameters, EN/ENO behavior, result type, templates, memory
constraints, confidence, and evidence category.

## Loader behavior

`src/rules/loadRules.ts` builds two independent maps:

- every YAML file except `_template.yaml` and the SCL files is merged into
  `RuleSet.instructions` for LAD/FBD lookup;
- SCL files (`SCL-*.yaml`, or the older `*-SCL.yaml` suffix form) are merged
  into `RuleSet.sclInstructions`.

The language is read from the file's basename only (`src/rules/fileLanguage.ts`):
a `SCL-`/`LAD-FBD-`/`LAD-`/`FBD-` prefix or the matching `-SCL`/... suffix. A
name that encodes neither (e.g. a typo like `SCL.-conversion.yaml`) loads into
the LAD/FBD map regardless of its `$fileLanguage`, and the Instruction Registry
Editor warns about it.

The maps are separate because SCL can use different capitalization, parameter
names, explicit pins, or instruction names. SCL lookup checks the SCL map first
and then falls back to the general map when no dedicated SCL entry exists.

### Subfolders

The loader walks this directory **recursively**, so `*.yaml` files can be
sorted into subfolders (e.g. `motion/12c-motion-axis-LAD-FBD.yaml`) for
organization without changing how they load. Only the file's basename is
meaningful: the `SCL-`/`LAD-FBD-`/etc. prefix (or suffix) rules, the
`_template.yaml` exclusion, and the merge order into `RuleSet.instructions` /
`RuleSet.sclInstructions` all apply the same way regardless of which
subfolder a file lives in. There is no naming requirement on subfolder
names themselves, and duplicate instruction keys are still not a supported
override mechanism across subfolders (see above).

`$fileLanguage` can set the default `language` for every entry in one file. An
entry-level `language` value overrides the file default.

Duplicate instruction keys within the same runtime map are not a supported
override mechanism; later files would silently replace earlier entries.

## File organization

File names encode family and language scope:

- `LAD-FBD-*.yaml` (or `*-LAD-FBD.yaml`): graphical call shapes shared by LAD and FBD.
- `LAD-*.yaml` or `FBD-*.yaml` (or the `-LAD`/`-FBD` suffix form): language-specific graphical shapes.
- `SCL-*.yaml` (or `*-SCL.yaml`): complete SCL entries with SCL spelling and calling convention.
- [`_template.yaml`](_template.yaml): copyable schema; never loaded.

Families are grouped by numeric prefix:

| Prefix | Area |
|---|---|
| `01` | bit logic |
| `02` | comparators |
| `03` | counters |
| `04` | timers |
| `05` | math |
| `06` | move and data transfer |
| `07` | word logic and selection |
| `08` | shift and rotate |
| `09` | program control |
| `10` | runtime control |
| `11` | conversions |
| `12a`–`12f` | process control, drives, and motion |
| `13a`–`13h` | S7, open, OPC UA, Modbus, serial, and TSN communication |
| `14a`–`14n` | date/time, strings, runtime symbols, I/O, diagnostics, alarms, files, and related extended families |

This split replaces the older aggregate `12-technology`, `13-communication`,
and `14-extended` files. New documentation and references must use the current
family files.

## Entry schema

Use [`_template.yaml`](_template.yaml) as the complete copyable starting point.
A shortened example is shown here:

```yaml
$fileLanguage: [SCL]

InstructionName:
  family: conversion
  callShape: box
  instanceType: null
  pins:
    - name: IN
      dir: in
      required: true
      dataTypes: [Integers]
      memoryAreas: [I, Q, M, D, L, constant]
      allowedDeclarations: [Input, Output, InOut, Static, Temp, Constant]
  result:
    kind: value
    dataTypes: [Int]
  template:
    shape: none
    keys: []
    extra: {}
  confidence: shape-only
  source: "anonymized reference fixture (signature only)"
  notes: "Concise technical behavior or scope note."
```

### Call shapes

- `box`: a normal named instruction call.
- `instance-dot`: a call requiring an instance type.
- `coil-ref`: a graphical coil form referring to a declared instance.

### Pin data types

- `dir` is `in` (`:=`) or `out` (`=>`).
- `required` describes the graphical call shape. SCL adaptation does not apply
  graphical requiredness blindly because SCL permits omitted parameters.
- `dataTypes` lists canonical type names or umbrella labels from
  [`../type-registry/category-index.yaml`](../type-registry/category-index.yaml).
- An empty or omitted `dataTypes` value means the fact is not established and
  must not be guessed.
- `"*"` means the source explicitly allows every data type.
- `allowedDeclarations` takes precedence over `memoryAreas` when both are
  present, following `resources/system-registry/memory.yaml`.

Use canonical casing from the type registry. Category labels are expanded from
`category-index.yaml`; consumers must not parse a Markdown table to infer them.

### Repeated pins

Some instructions accept a consecutively numbered run of the same parameter:
MIN/MAX take `IN3` through `IN32` after the fixed `IN1`/`IN2`, and a graphical
ADD box grows `in3`, `in4`, ... as inputs are inserted. Model the run as one pin
whose `name` is the stem, plus `repeat`:

```yaml
- name: IN
  repeat: { from: 3, to: 32 }
  dir: in
  required: false
```

- A call parameter matches when it is the stem followed by an index from
  `from` through `to`, without leading zeros. Fixed pins are matched first, so
  the stem may share a prefix with fixed pins such as `IN1` or `INELSE`.
- Omit `to` when no source states the upper limit; every index from `from`
  upward is then accepted rather than guessed.
- `required` applies to fixed pins only; a repeated run is never reported as
  missing.
- Hovers show the run as `IN3..IN32`.

### Container-kind addressing

`containerKinds` captures cases where an addressed scalar must belong to an
`Array` or `Struct`. Omit the field when no container requirement has been
established; an empty list must not be used as a guess.

### EN/ENO metadata

- Omit `enEno` when support has not been established. Do not infer
  `present: false` from missing evidence.
- `result` describes the value produced by a call when known. Supported kinds
  include `none`, `value`, `inferred`, and `type-expression`; detailed result
  rules live in `resources/system-registry/result.yaml`.
- `template` records `S7_Templates` shape, keys, and extra pragmas used by
  graphical exports. SCL adaptation does not require graphical templates.

### Confidence and provenance

- `confirmed-compiled`: verified against compiling evidence and suitable for
  hard validation where the relevant fact is confirmed.
- `official-doc`: transcribed from instruction documentation, but not verified
  by a compiling fixture. Compile-dependent diagnostics remain warnings.
- `shape-only`: useful for name and call-shape coverage, but uncertain template
  or type facts must not become hard errors.

Use a repository-relative path for public in-repository evidence. Otherwise use
one of these normalized labels:

- `anonymized compiling fixture evidence`
- `anonymized reference fixture (signature only)`
- `official instruction documentation (paraphrased)`

Keep `notes` to a concise technical paraphrase of behavior, limitations, or
unresolved scope. Do not include copied documentation prose, customer data,
private filenames, export network IDs, work-log dates, or maintainer history.

## Per-language instructions

LAD and FBD share many calls, but language-specific files are used where names
or shapes differ. SCL has additional differences:

### SCL as a third language

- native operators and statements replace many graphical boxes;
- parameter names and instruction capitalization can differ;
- parameter names are matched case-insensitively, as TIA Portal does. Entries
  still use TIA's displayed spelling (`IN1`, `L`, `P`), because completion and
  hovers show it;
- graphical implicit pins may become explicit SCL parameters;
- stateful FB instructions are called through instances;
- `S7_Templates` pragmas do not apply to authored SCL calls.

A missing dedicated SCL entry does not prove that the graphical signature is
fully verified for SCL; it only means lookup currently falls back to the general
map.

## Adding or changing an entry

1. Start from `_template.yaml` and place the entry in the correct family and
   language file.
2. Record only facts supported by documentation, a compiling export, or an
   anonymized fixture. Leave uncertain optional fields absent.
3. Put reusable type facts in
   [`type-registry/`](../type-registry/README.md), not in instruction prose.
4. Put user-facing diagnostic wording in
   [`diagnostic-registry/`](../diagnostic-registry/README.md).
5. Add or update a fixture and run `npm test` from a checkout of the GitHub
   repository. The test source is under
   [`scripts/`](https://github.com/Chamoswor/s7-lint-vscode/tree/main/scripts).

Focused fixture contracts are documented in
[`scripts/fixtures/scl-diagnostics/`](https://github.com/Chamoswor/s7-lint-vscode/tree/main/scripts/fixtures/scl-diagnostics).

## Current limitations

- Target CPU and firmware are not configured, so platform-specific narrowing
  is not generally enforceable.
- Some families contain `shape-only` entries with intentionally incomplete
  type or EN/ENO metadata.
- Complex expressions are checked only where the parser and symbol resolver can
  infer a safe type; unresolved cases are skipped rather than guessed.
