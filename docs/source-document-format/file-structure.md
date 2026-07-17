# File structure and resources

## File roles

An exported source document can use two complementary text files:

| Extension | Role |
| --- | --- |
| `.s7dcl` | Block/type declaration, interface, attributes, and executable networks |
| `.s7res` | Optional multilingual text addressed by identifiers used in the code file |

The code file is the parser's primary input. A resource file is useful only
when the code contains matching text identifiers; it does not add executable
logic.

## Common `.s7dcl` order

A program block normally has these layers:

1. an optional attribute block in braces;
2. a declaration keyword and block name;
3. zero or more `VAR_*` sections;
4. one or more language-labelled `NETWORK` sections;
5. the terminator matching the declaration keyword.

This project accepts attributes without depending on their generated values.
The anonymized fixtures therefore use neutral text for generated metadata.

```s7dcl
{
    S7_Optimized := "TRUE";
    S7_PreferredLanguage := "FBD";
    S7_Version := "0.1"
}
FUNCTION_BLOCK "FB_Example"
    VAR_INPUT
        Enable : Bool;
    END_VAR
    VAR_OUTPUT
        Active : Bool;
    END_VAR

    { S7_Language := "FBD" }
    NETWORK
        RUNG #Enable
            Coil( #Active )
        END_RUNG
    END_NETWORK
END_FUNCTION_BLOCK
```

The declaration and terminator pairs used by the parser are:

| Declaration | Terminator |
| --- | --- |
| `ORGANIZATION_BLOCK` | `END_ORGANIZATION_BLOCK` |
| `FUNCTION_BLOCK` | `END_FUNCTION_BLOCK` |
| `FUNCTION` | `END_FUNCTION` |
| `DATA_BLOCK` | `END_DATA_BLOCK` |
| `TYPE` | `END_TYPE` |

Functions can declare a return type after the quoted name. A `TYPE` contains a
type declaration rather than executable networks. A data block contains data
and therefore does not require a network body.

## Interface sections

The familiar declaration sections retain their SCL spelling, including
`VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT`, `VAR_TEMP`, `VAR_CONSTANT`, and `VAR`.
The legal sections depend on the surrounding block kind. That legality is
validated by the project's symbol and composition checks rather than inferred
from file extension alone.

Names inside a source document, not the file-system path, identify blocks to
the parser. The smoke fixtures nevertheless keep each file name equal to its
quoted declaration name because this makes navigation and review unambiguous.

## `.s7res` sidecars

Resource files are YAML. Each item maps one generated identifier to one or more
language tags:

```yaml
MultiLingualTexts:
  - id: Fixture_Title
    en-US: 'Generic control block'
    nb-NO: 'Generisk kontrollblokk'
```

Use normal YAML quoting rules. In particular, quote text when `#` or `:` could
be interpreted as YAML syntax, when whitespace at either end is significant,
or when an empty string is intended. Use block-scalar syntax for multiline
text.

The current smoke suite does not load `.s7res` files. Resource sidecars should
only be added when a test explicitly exercises resource resolution; otherwise
they add provenance and maintenance cost without increasing parser coverage.

## Round-trip cautions

This reference deliberately does not promise lossless round-tripping through a
particular product version. Generated numbers, editor settings, protected
content, comments, and project-only attributes can have different export or
import behavior. Validate important attributes in the engineering tool after
an import, and treat its installed documentation as authoritative.
