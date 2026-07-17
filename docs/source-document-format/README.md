# Source document format notes

This directory documents the text format consumed by the parser and smoke
fixtures in this repository. It is an independent interoperability reference,
not a copy of product documentation and not a complete guide to engineering or
import workflows.

The notes cover only behavior that is useful when reading, validating, or
generating the repository's `.s7dcl` and `.s7res` fixtures:

- the outer structure of a source document;
- the relationship between code and multilingual-text files;
- how LAD, FBD, and SCL networks are represented;
- parser invariants exercised by the automated tests.

For instruction signatures and detailed LAD/FBD call shapes, use
[FBD know-how](../fbd-knowhow/00-Overview.md). The executable examples live in
[`scripts/fixtures/smoke`](../../scripts/fixtures/smoke/).

## Documents

- [File structure and resources](file-structure.md)
- [LAD, FBD, and SCL network encoding](language-encoding.md)

## Scope and verification

These notes describe observed syntax, not every feature supported by every
TIA Portal or controller version. A change is considered supported by this
project only when a fixture parses and the relevant automated checks pass.

Run the focused verification with:

```text
npm run test:smoke
```

Run `npm test` before publishing changes to the parser, registries, or fixtures.

## Independence and attribution

The prose and examples in this directory were written for this project from
the behavior of its anonymized fixtures. No vendor screenshots are included.

SIMATIC, STEP 7, and TIA Portal are product names or trademarks of Siemens AG.
Their use here identifies the format with which the project interoperates; it
does not imply affiliation, sponsorship, or vendor approval.

For product procedures, supported-version details, and authoritative safety or
import guidance, consult the documentation supplied with the installed product
or [Siemens Industry Online Support](https://support.industry.siemens.com/).
