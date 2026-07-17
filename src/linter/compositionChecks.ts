// Checks derived from type-registry/composition-rules.yaml's `struct`
// section that operate on a whole parsed block file rather than one
// specific instruction call or pin -- currently just
// `maxStructsPerDataBlock`. A separate small file (rather than folding
// into instructionChecks.ts) since this isn't about instruction calls at
// all, just a DATA_BLOCK's own declared member shape.
import { ParsedBlockFile } from "../parser/s7dclParser";
import { TypeRef } from "../parser/typeRef";
import { RuleSet } from "../rules/types";
import { formatDiagnostic, LintDiagnostic } from "./diagnostics";

/** Recursively counts anonymous (inline) STRUCT declarations reachable
 * from `ref` -- descends into a nested inline-struct's own members and
 * into an array's element type, but does NOT follow a NAMED UDT/system-
 * type reference: referencing an already-defined PLC data type isn't
 * itself "a STRUCT declaration" the way composition-rules.yaml's
 * `maxStructsPerDataBlock` describes it (Siemens' own recommendation --
 * "use PLC data types instead of raw STRUCT" -- only makes sense read
 * this way; the referenced UDT's own internal anonymous structs, if any,
 * count toward wherever THAT UDT is actually declared, not toward every
 * block that merely references it by name). */
function countInlineStructs(ref: TypeRef): number {
  if (ref.kind === "inline-struct") {
    let count = 1;
    for (const m of ref.members) count += countInlineStructs(m.typeRef);
    return count;
  }
  if (ref.kind === "array") return countInlineStructs(ref.of);
  return 0;
}

/** composition-rules.yaml's `struct.maxStructsPerDataBlock`: a DATA_BLOCK
 * may declare at most `limit` anonymous STRUCTs (252 as of this writing,
 * on S7-1200/S7-1500) -- TIA's own recommendation past that point is to
 * use PLC data types (UDTs) instead. Flags the exact member whose own
 * (possibly multi-STRUCT, if nested) contribution first pushes the
 * running total over the limit, rather than anchoring the diagnostic at
 * the block's own declaration line (`ParsedBlockFile` doesn't track one). */
export function checkStructCountPerDataBlock(block: ParsedBlockFile, ruleSet: RuleSet): LintDiagnostic[] {
  if (block.blockType !== "DATA_BLOCK") return [];
  const limitSpec = ruleSet.composition.struct.maxStructsPerDataBlock;
  if (!limitSpec) return []; // not yet transcribed -- don't guess a limit

  let total = 0;
  for (const section of block.varSections) {
    for (const member of section.members) {
      const before = total;
      total += countInlineStructs(member.typeRef);
      if (before <= limitSpec.limit && total > limitSpec.limit) {
        return [
          formatDiagnostic(ruleSet, "too-many-structs-per-data-block", member.line ?? 1, 1, {
            blockName: block.name,
            total,
            memberName: member.name,
            limit: limitSpec.limit,
          }),
        ];
      }
    }
  }
  return [];
}
