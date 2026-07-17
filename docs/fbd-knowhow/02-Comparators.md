# Comparator Operations

Source: [`comparators.s7dcl`](reference-exports/comparators.s7dcl) / [`comparators.s7res`](reference-exports/comparators.s7res).

All comparison contacts are generic and need an explicit `S7_Templates`
attribute naming the compared type immediately before the box:

```
{ S7_Templates := "SrcType := Int" }
EQ_Contact( in1 := #Num1, in2 := #Num2 )   -- CMP ==: Equal
Coil( #S1 )
```

Same shape for all six: `EQ_Contact` (`==`), `NE_Contact` (`<>`),
`GE_Contact` (`>=`), `LE_Contact` (`<=`), `GT_Contact` (`>`),
`LT_Contact` (`<`). `SrcType` can be any comparable type actually used
(`Int`, `DInt`, `Time`, `Real`, ...) — set it to match the operands'
real type, not always `Int`.

## Range checks

```
{ S7_Templates := "SrcType := Int" }
InRange( min := #Num1, in := #Num2, max := #Num3 )    -- IN_RANGE
Coil( #S1 )

{ S7_Templates := "SrcType := Int" }
OutRange( min := #Num1, in := #Num2, max := #Num3 )   -- OUT_RANGE
Coil( #S1 )
```

## Floating-point validity

No template needed — these are Real-only:

```
RUNG
    OK( #Real1 )       -- OK: is Real1 a valid (non-NaN/non-inf) float?
    Coil( #S1 )
END_RUNG
RUNG
    NOK( #Real1 )      -- NOT_OK: is Real1 an invalid float?
    Coil( #S1 )
END_RUNG
```
