# Shift and Rotate

Source: [`shift-rotate.s7dcl`](reference-exports/shift-rotate.s7dcl) (no `.s7res`).

```
Shr( in :=  , n :=  , out =>  )   -- shift right
Shl( in :=  , n :=  , out =>  )   -- shift left
Ror( in :=  , n :=  , out =>  )   -- rotate right
Rol( in :=  , n :=  , out =>  )   -- rotate left
```

`n` is the shift/rotate count (any integer type); `in`/`out` type
determines the word width being shifted.
