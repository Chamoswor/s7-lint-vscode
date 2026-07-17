# Move Operations

Source: [`move.s7dcl`](reference-exports/move.s7dcl) (no `.s7res`).

```
Move( in :=  , out1 =>  )                  -- basic assignment, most common
Deserialize( srcArray :=  , ret_val =>  , dstVariable =>  , pos :=  )
Serialize( srcVariable :=  , ret_val =>  , dstArray =>  , pos :=  )
MoveBlockI( IN :=  , COUNT :=  , OUT =>  )         -- interruptible block move
MoveBlockVariant( src :=  , count :=  , srcIndex :=  , dstIndex :=  , ret_val =>  , dst =>  )
MoveBlockU( IN :=  , COUNT :=  , OUT =>  )         -- uninterruptible block move
AssignAttempt( in :=  , out =>  )                  -- Move with ENO on type mismatch
FillBlockI( IN :=  , COUNT :=  , OUT =>  )
FillBlockU( IN :=  , COUNT :=  , OUT =>  )
SCATTER( in :=  , out =>  )                        -- struct → individual tags
ScatterBlock( in :=  , countIn :=  , out =>  )
GATHER( in :=  , out =>  )                         -- individual tags → struct
GatherBlock( in :=  , countOut :=  , out =>  )
Swap( in :=  , out =>  )                           -- byte swap
VariantGet( src :=  , dst =>  )
VariantPut( src :=  , dst :=  )
CountOfElements( in :=  , ret_val =>  )
```

`Lower_Bound` / `Upper_Bound` (array dimension bounds) need an explicit
ENO flag rather than a type template:

```
{ S7_GenerateENO := "TRUE" }
Lower_Bound( arr :=  , dim :=  , out =>  )
{ S7_GenerateENO := "TRUE" }
Upper_Bound( arr :=  , dim :=  , out =>  )
```
