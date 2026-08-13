// Per-block symbol table: resolves a `#tag(.member)*` reference (an
// `OperandRef`, see parser/s7dclParser.ts) to its ultimately-declared
// TypeRef, walking through this block's own VAR sections, then -- for
// each further `.member` segment -- a UDT/STRUCT member, a system-type
// (e.g. IEC_TIMER) member, a cross-file FB/FC/OB/DB instance's own VAR
// member (via BlockIndex), or a timer/counter/edge-instance's own
// instruction-registry pin (via documentIndex.ts's
// resolveInstanceTypeToInstructionNames/listInstanceMembers).
//
// This supersedes documentIndex.ts's own inline member-chain logic
// (consumeBaseTagOrWire/walkOperandRef) for TYPE-RESOLUTION purposes --
// that logic stops after one dot and never consults the UDT type cache
// at all, so a chain like `#Data.Alarms.MFCAlarms.X` never resolved
// there. documentIndex.ts keeps its own logic for hover/rename span
// classification (a different, position-anchored concern) -- adopting
// this module there is a separate follow-up, not done here.
//
// Deliberately conservative: a step this module can't model yet (array
// indexing, an inline STRUCT with no name to re-look-up, a quoted member
// name) stops the walk with `unresolved-path`, NEVER a hard error -- only
// a completely undeclared BASE segment is `undeclared`. See
// linter/symbolChecks.ts for the checks built on top of this.
import { BlockIndex, BlockInfo } from "./blockIndex";
import { isDotAccessLegal, resolveInstanceTypeToInstructionNames, listInstanceMembers } from "./documentIndex";
import { lookupType, TypeCacheResult } from "../cache/typeCache";
import { ParsedBlockFile } from "../parser/s7dclParser";
import {
  TypeRef,
  typeRefDereferencedTopLevelName,
  typeRefTopLevelName,
} from "../parser/typeRef";
import { RuleSet, SystemTypeMemberTypeRef } from "../rules/types";

export type ResolvedSymbol =
  | { kind: "resolved"; typeRef: TypeRef }
  | { kind: "unresolved-path" }
  | { kind: "undeclared" }
  /** A `.member` step DID resolve to a real declared member, but reading it
   * via dot notation isn't legal here -- either `memberName` is declared
   * VAR_TEMP/VAR_CONSTANT (not externally exposed at all), or `blockType`
   * is `FUNCTION` (no instance data whatsoever, dot access into one is
   * never legal regardless of section) -- see
   * `analysis/documentIndex.ts`'s `isDotAccessLegal`. Distinct from
   * `unresolved-path` (member genuinely not found / can't verify) -- this
   * one IS a real, reportable error. See `linter/symbolChecks.ts`'s
   * `checkIllegalDotAccess`. */
  | { kind: "illegal-dot-access"; blockName: string; blockType: string; section: string; memberName: string }
  /** ONLY reachable from an EXTERNAL `"Name".member` reference (never a
   * local `#instance.member` one): `segments[0]` resolved to a real
   * workspace block, but it's the block's OWN type declaration
   * (`FUNCTION_BLOCK`/`FUNCTION`/`ORGANIZATION_BLOCK`), not a genuine
   * DATA_BLOCK instance. Confirmed against real TIA Portal behavior:
   * dotting a bare FUNCTION_BLOCK's quoted TYPE name offers "Create
   * (multi)instance"/"Create parameter instance" actions, never member
   * access -- an external instance reference is only ever legitimate when
   * it names an actual DATA_BLOCK (whether a plain global DB, or an FB's
   * own generated external instance DB, which TIA itself always exports
   * AS a DATA_BLOCK, not as the FUNCTION_BLOCK declaration itself).
   * `#localInstance.member` is unaffected -- a declared local/STATIC
   * instance variable IS a genuine instance by construction, so
   * `resolveMember`'s cross-file branch keeps using the full
   * `isDotAccessLegal` allow-list for that case. */
  | { kind: "illegal-external-block-type"; blockName: string; blockType: string };

/** Converts a system-types.yaml member's own `SystemTypeMemberTypeRef`
 * shape (a separate, YAML-native type-registry format) into this
 * parser's own `TypeRef` shape, so the walk below can treat a
 * system-struct member (e.g. an `IEC_TIMER`'s `PT`) exactly like any
 * other step once found. */
function systemTypeRefToTypeRef(ref: SystemTypeMemberTypeRef): TypeRef {
  if (ref.kind === "array") {
    return { kind: "array", bounds: ref.bounds ?? [], of: systemTypeRefToTypeRef(ref.of!) };
  }
  if (ref.kind === "inline-struct") {
    return {
      kind: "inline-struct",
      members: (ref.members ?? []).map((m) => ({ name: m.name, typeRef: systemTypeRefToTypeRef(m.typeRef) })),
    };
  }
  return { kind: "named", name: ref.name ?? "", quoted: false, namespace: null };
}

/** Case-insensitive name comparison -- SCL identifiers (tags, members,
 * types) are all case-insensitive; only their DECLARED spelling is
 * preserved. */
function nameEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Case-insensitive key lookup into a plain registry record. */
function findCaseInsensitive<T>(record: Record<string, T>, key: string): T | undefined {
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Every symbol declared anywhere in `block`'s own VAR sections is
 * visible to the whole body -- SCL/FBD don't have nested lexical scoping
 * within one block, so a single flat map covers it. Keyed lower-case (see
 * `nameEq`); look up through `lookupLocalDecl`. */
function buildLocalDeclMap(block: ParsedBlockFile): Map<string, TypeRef> {
  const map = new Map<string, TypeRef>();
  for (const section of block.varSections) {
    for (const member of section.members) {
      map.set(member.name.toLowerCase(), member.typeRef);
    }
  }
  return map;
}

/** The type name to key the NEXT step's member lookup off of -- drills
 * through `array`/`reference` the same way `documentIndex.ts`'s own
 * resolution does, so `Array[0..1] of "MyUdt"` and `REF_TO "MyUdt"` both
 * still let a `.member` access continue into `MyUdt`'s own members. */
function stepLookupName(typeRef: TypeRef): string | null {
  return typeRefDereferencedTopLevelName(typeRef) ?? typeRefTopLevelName(typeRef);
}

type MemberStepResult =
  | { kind: "ok"; typeRef: TypeRef }
  | { kind: "illegal"; blockName: string; blockType: string; section: string; memberName: string }
  | { kind: "not-found" };

/** Resolves ONE `.member` step against a SPECIFIC workspace block (found
 * via BlockIndex), enforcing `isDotAccessLegal` -- shared by
 * `resolveMember`'s own cross-file-block branch (stepping FROM a
 * locally-typed tag's instance type) and `resolveOperandRef`'s external-
 * reference entry point (stepping FROM a bare `"Name"` reference, which
 * IS the block itself, not a typed local tag) -- so `#localInstance.member`
 * and `"External".member` enforce the exact same rule rather than two
 * copies that could drift apart. */
function resolveBlockMember(target: BlockInfo, memberName: string): MemberStepResult {
  const blockVar = target.vars.get(memberName) ?? [...target.vars.values()].find((v) => nameEq(v.name, memberName));
  if (!blockVar) return { kind: "not-found" };
  if (!isDotAccessLegal(target.blockType, blockVar.section)) {
    return { kind: "illegal", blockName: target.name, blockType: target.blockType, section: blockVar.section, memberName };
  }
  return { kind: "ok", typeRef: blockVar.member.typeRef };
}

/** Resolves one `.member` step against whatever `currentTypeRef` names,
 * trying (in order) a UDT, a system-struct, a cross-file block instance,
 * and a timer/counter/edge-instance's own instruction pin. `"not-found"`
 * means none of these know about `memberName` (a real gap, or a step this
 * module doesn't model) -- `"illegal"` (only ever from the cross-file
 * block-instance branch, via `resolveBlockMember`) means the member EXISTS
 * but dot-notation access into it isn't legal here. */
function resolveMember(
  currentTypeRef: TypeRef,
  memberName: string,
  blockIndex: BlockIndex,
  typeCache: TypeCacheResult,
  ruleSet: RuleSet
): MemberStepResult {
  const lookupName = stepLookupName(currentTypeRef);
  if (!lookupName) return { kind: "not-found" };

  // Type AND member names are both case-insensitive in SCL (`byte`/`BYTE`,
  // `#hdr.flags`/`#hdr.Flags` -- TIA Portal resolves and imports all of
  // them), so neither side of this walk may compare with `===` on raw
  // source spelling. See `TypeCacheResult.canonicalNames`.
  const udt = lookupType(typeCache, lookupName);
  if (udt && udt.kind === "udt" && udt.members) {
    const member = udt.members.find((m) => nameEq(m.name, memberName));
    if (member) return { kind: "ok", typeRef: member.typeRef };
  }

  const systemType = ruleSet.systemTypes[lookupName] ?? findCaseInsensitive(ruleSet.systemTypes, lookupName);
  if (systemType && systemType.category === "system-struct" && systemType.members) {
    const member = systemType.members.find((m) => nameEq(m.name, memberName));
    if (member) return { kind: "ok", typeRef: systemTypeRefToTypeRef(member.type) };
  }

  const block = blockIndex.get(lookupName);
  if (block) {
    const result = resolveBlockMember(block, memberName);
    if (result.kind !== "not-found") return result; // "ok" or "illegal" -- this branch owns the answer either way
  }

  const instrNames = resolveInstanceTypeToInstructionNames(ruleSet, lookupName);
  if (instrNames.length > 0) {
    const pin = listInstanceMembers(ruleSet, lookupName).find((p) => p.name.toLowerCase() === memberName.toLowerCase());
    if (pin) {
      // Instruction-registry pins only carry a `dataTypes` list, not a
      // real `TypeRef` -- synthesize a plain named TypeRef from the
      // first candidate so the caller's own top-level-name check still
      // works (e.g. for a Bool-condition check on `#tonX.Q`). Ambiguous
      // (multiple legal dataTypes) resolves to the first one; good
      // enough for "is this Bool" style checks, not exact for others.
      const first = pin.dataTypes[0];
      if (first) return { kind: "ok", typeRef: { kind: "named", name: first, quoted: false, namespace: null } };
    }
  }

  return { kind: "not-found" };
}

/** Resolves an `OperandRef`'s `segments` (tag name, then every
 * `.member`) against `block`'s own declarations plus the workspace's
 * BlockIndex/type cache/instruction registry. See file header for the
 * overall approach and its deliberate limits.
 *
 * `isExternal` (see `OperandRef.external`) means `segments[0]` is a bare
 * double-quoted `"Name"` reference -- a WORKSPACE BLOCK's own name (a
 * global DATA_BLOCK, a plain FUNCTION, or an FB's own external instance
 * DB), resolved directly via BlockIndex instead of `block`'s own local VAR
 * declarations. The first `.member` step off of it is resolved the exact
 * same section-legality-checked way `resolveMember`'s cross-file-block
 * branch already resolves a LOCAL `#instance.member` step, via the shared
 * `resolveBlockMember` -- so `"External".member` and `#localInstance.member`
 * enforce the identical rule. */
export function resolveOperandRef(
  segments: string[],
  block: ParsedBlockFile,
  blockIndex: BlockIndex,
  typeCache: TypeCacheResult,
  ruleSet: RuleSet,
  isExternal = false
): ResolvedSymbol {
  if (segments.length === 0) return { kind: "unresolved-path" };

  let currentTypeRef: TypeRef;
  let startIndex: number;

  if (isExternal) {
    const target = blockIndex.get(segments[0]);
    if (!target) return { kind: "undeclared" };
    if (segments.length === 1) {
      // A bare external reference with no `.member` at all -- nothing
      // further to resolve; report its own name as a plain (quoted) named
      // type, same convention parser/typeRef.ts's own quoted-type-reference
      // parsing already uses.
      return { kind: "resolved", typeRef: { kind: "named", name: target.name, quoted: true, namespace: null } };
    }
    // An external quoted reference can only legitimately dot into a real
    // DATA_BLOCK instance -- confirmed against TIA Portal's own behavior
    // (see `illegal-external-block-type`'s own doc comment): a
    // FUNCTION_BLOCK/FUNCTION/ORGANIZATION_BLOCK resolved here is the
    // block's OWN type declaration, not a verifiable instance, so dot
    // access is rejected outright regardless of section -- `#localInstance.
    // member` (a genuine local instance by construction) is unaffected,
    // see `resolveMember`'s own cross-file branch below.
    if (target.blockType !== "DATA_BLOCK") {
      return { kind: "illegal-external-block-type", blockName: target.name, blockType: target.blockType };
    }
    const first = resolveBlockMember(target, segments[1]);
    if (first.kind === "illegal") {
      return { kind: "illegal-dot-access", blockName: first.blockName, blockType: first.blockType, section: first.section, memberName: first.memberName };
    }
    if (first.kind === "not-found") return { kind: "unresolved-path" };
    currentTypeRef = first.typeRef;
    startIndex = 2;
  } else {
    const localDecls = buildLocalDeclMap(block);
    const localTypeRef = localDecls.get(segments[0].toLowerCase());
    if (!localTypeRef) {
      // A FUNCTION's return value is addressed through the function's OWN
      // name (`#TheFunction := ...`), which is IEC 61131-3's result-variable
      // convention and is never declared in a VAR section -- so treating it
      // as an undeclared tag flagged the one legal way to return a value.
      // Scoped to a FUNCTION: a FUNCTION_BLOCK has no result variable, so a
      // `#SameNameAsTheFB` there really is undeclared.
      if (block.blockType === "FUNCTION" && nameEq(segments[0], block.name)) {
        return { kind: "unresolved-path" };
      }
      return { kind: "undeclared" };
    }
    currentTypeRef = localTypeRef;
    startIndex = 1;
  }

  for (let i = startIndex; i < segments.length; i++) {
    const next = resolveMember(currentTypeRef, segments[i], blockIndex, typeCache, ruleSet);
    if (next.kind === "illegal") {
      return { kind: "illegal-dot-access", blockName: next.blockName, blockType: next.blockType, section: next.section, memberName: next.memberName };
    }
    if (next.kind === "not-found") return { kind: "unresolved-path" };
    currentTypeRef = next.typeRef;
  }

  return { kind: "resolved", typeRef: currentTypeRef };
}
