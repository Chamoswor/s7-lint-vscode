# Instruction signature registry

This directory contains the instruction signatures used to validate LAD/FBD
exports and authored SCL. The YAML is loaded directly at runtime; it is not
generated from another directory.

The registry describes facts such as instruction name, language, call shape,
instance type, parameters, EN/ENO behavior, result type, templates, memory
constraints, confidence, and evidence category.

## Loader behavior

`src/rules/loadRules.ts` builds two independent maps:

- every YAML file except `_template.yaml` and `*-SCL.yaml` is merged into
  `RuleSet.instructions` for LAD/FBD lookup;
- `*-SCL.yaml` files are merged into `RuleSet.sclInstructions`.

The maps are separate because SCL can use different capitalization, parameter
names, explicit pins, or instruction names. SCL lookup checks the SCL map first
and then falls back to the general map when no dedicated SCL entry exists.

### Subfolders

The loader walks this directory **recursively**, so `*.yaml` files can be
sorted into subfolders (e.g. `motion/12c-motion-axis-LAD-FBD.yaml`) for
organization without changing how they load. Only the file's basename is
meaningful: the `-SCL.yaml`/`-LAD-FBD.yaml`/etc. suffix rules, the
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

- `*-LAD-FBD.yaml`: graphical call shapes shared by LAD and FBD.
- `*-LAD.yaml` or `*-FBD.yaml`: language-specific graphical shapes.
- `*-SCL.yaml`: complete SCL entries with SCL spelling and calling convention.
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
5. Add or update a fixture and run `npm test` from the repository root.

Focused fixture contracts are documented in
[`../../scripts/fixtures/scl-diagnostics/`](../../scripts/fixtures/scl-diagnostics/README.md).

## Current limitations

- Target CPU and firmware are not configured, so platform-specific narrowing
  is not generally enforceable.
- Some families contain `shape-only` entries with intentionally incomplete
  type or EN/ENO metadata.
- Complex expressions are checked only where the parser and symbol resolver can
  infer a safe type; unresolved cases are skipped rather than guessed.
