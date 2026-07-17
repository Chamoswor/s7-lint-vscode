# Word Logic Operations

Source: [`word-logic.s7dcl`](reference-exports/word-logic.s7dcl) (no `.s7res`).

Bitwise (word/byte/dword, not single-bit — see
[01-Bit-Logic.md](01-Bit-Logic.md) for `A`/`O`/`X` on `Bool`):

```
And( in1 :=  , in2 :=  , out =>  )
Or( in1 :=  , in2 :=  , out =>  )
Xor( in1 :=  , in2 :=  , out =>  )
Inv( in :=  , out =>  )              -- bitwise NOT
DECO( in :=  , out =>  )             -- decode: bit position -> bitmask
ENCO( in :=  , out =>  )             -- encode: bitmask -> bit position
```

Selection/multiplexing:

```
SEL( g :=  , in0 :=  , in1 :=  , out =>  )                -- binary select: g ? in1 : in0
Mux( k :=  , in0 :=  , in1 :=  , else :=  , out =>  )     -- k-indexed select, else = fallback
Demux( k :=  , in :=  , out0 =>  , out1 =>  , else =>  )  -- k-indexed distribute, else = fallback
```
