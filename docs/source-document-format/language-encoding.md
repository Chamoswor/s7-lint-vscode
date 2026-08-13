# LAD, FBD, and SCL network encoding

Each network declares its language with `S7_Language`. The surrounding block
can prefer one language while individual networks use another.

```s7dcl
{ S7_Language := "LAD" }
NETWORK
    ...
END_NETWORK
```

## LAD

LAD is serialized as ordered rungs. `wire#powerrail` denotes a rung that starts
at the left rail. A named `wire#...` token connects branches within the same
network. The identifier has local wiring meaning; consumers must not attach
business meaning to its generated spelling.

```s7dcl
{ S7_Language := "LAD" }
NETWORK
    RUNG wire#powerrail
        Contact( #Start )
        wire#branch1
        Contact( #Permit )
        Coil( #Run )
    END_RUNG

    RUNG wire#branch1
        Contact( #Hold )
    END_RUNG
END_NETWORK
```

The sequence inside a rung represents the left-to-right graphical flow.
`END_RUNG wire#name` closes a branch into the referenced wire. Instructions
whose enable/input path belongs to a rung are serialized at that point in the
sequence.

## FBD

FBD uses the same `NETWORK` and `RUNG` boundaries, but a rung can start from an
expression rather than a power rail. Named parameters preserve the instruction
box's connections.

```s7dcl
{ S7_Language := "FBD" }
NETWORK
    RUNG #Ready
        A( in2 := #Enabled )
        Coil( #Active )
    END_RUNG
END_NETWORK
```

Calls may be preceded by an `S7_Templates` attribute when a generic instruction
needs a concrete type:

```s7dcl
RUNG #EnableDelay
    { S7_Templates := "time_type := Time" }
    "DelayInstance".TON(
        pt := #Delay,
        et => #Elapsed
    )
    Coil( #Delayed )
END_RUNG
```

The registry, not this document, defines required pins, supported template
shapes, and instruction-specific data types. See
[the instruction registry](../../resources/instruction-registry/README.md).

## SCL

An SCL network places ordinary SCL statements between `NETWORK` and
`END_NETWORK`. It does not introduce graphical `RUNG` boundaries.

```s7dcl
{ S7_Language := "SCL" }
NETWORK
    #Total := #ValueA + #ValueB;
    #Valid := #Total >= 0.0;
END_NETWORK
```

Pure authored `.scl` files can contain several top-level declarations. The
parser therefore iterates over the entire document rather than assuming one
block per file. The large
[`distributed-process-control.scl`](https://github.com/Chamoswor/s7-lint-vscode/blob/main/scripts/fixtures/smoke/distributed-process-control.scl)
fixture exercises that path.

## Mixed-language blocks

The block-level preferred language does not force every network to use that
language. A LAD- or FBD-oriented block can contain an SCL network as long as
each network carries the correct `S7_Language` attribute. Consumers should
dispatch on the network attribute, not only on `S7_PreferredLanguage` or
`S7_EditorMode` at the block level.

## Executable fixtures

The anonymized graphical examples under
[`graphical-control`](https://github.com/Chamoswor/s7-lint-vscode/tree/main/scripts/fixtures/smoke/graphical-control) in the GitHub repository cover
branches, calls, templates, contacts, coils, conversions, timers, and
cross-block instance types. Prefer extending those fixtures over pasting
screenshots or prose from external manuals.
