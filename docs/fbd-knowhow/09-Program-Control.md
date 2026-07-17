# Program Control Operations

Source: [`program-control.s7dcl`](reference-exports/program-control.s7dcl) (no `.s7res`).

## Labels and jumps

A `Label()` call at the top of a `NETWORK` declares a jump target for
that network; `JumpCoil` jumps to it unconditionally when the rung is
true, `I_JumpCoil` is the inverted-condition variant:

```
NETWORK
    Label()
    RUNG
        JumpCoil( )
    END_RUNG
END_NETWORK

NETWORK
    RUNG
        I_JumpCoil( )
    END_RUNG
END_NETWORK
```

## Jump list / Switch (multi-way jump)

```
JumpList( k :=  , dst0 =>  , dst1 =>  )   -- jump to dst[k]

{
    CASE0 := "==";
    CASE1 := "=="
}
Switch(
    k :=  ,
    case0 :=  ,
    case1 :=  ,
    else =>  ,
    dst0 =>  ,
    dst1 =>  
)
```
`Switch`'s `CASEn` attributes set each branch's comparison operator
(`==`, `<>`, `>=`, `<=`, `>`, `<`); `dstN` are jump-target outputs, in
the same style as `JumpList`.

## Return

```
RUNG
    ReturnCoil( )    -- unconditional early return when rung is true
END_RUNG
```
