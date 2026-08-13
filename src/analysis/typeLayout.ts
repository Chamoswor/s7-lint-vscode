import { lookupType, TypeCacheResult } from "../cache/typeCache";
import { MemberRef, TypeRef } from "../parser/typeRef";
import { RuleSet } from "../rules/types";

/**
 * A deterministic Siemens standard/non-optimized storage layout.
 *
 * `paddingBits` is omitted when the total size is known from an authoritative
 * registry size but that type's internal padding/reserve split is not. The
 * size remains usable by its enclosing STRUCT/ARRAY in that case.
 */
export interface StandardTypeLayout {
  sizeBits: number;
  paddingBits?: number;
  alignmentBits: 8 | 16;
  boolPackable: boolean;
  /** Direct member placements when this result describes a STRUCT/UDT/DB. */
  memberLayouts?: StandardMemberLayout[];
}

export interface UnavailableTypeLayout {
  unavailable: string;
  /** Every declaration path that prevents a complete size calculation. */
  unknownSizes: UnknownSizeDependency[];
  /** Per-member results remain useful even when the aggregate is unknown. */
  memberLayouts?: StandardMemberLayout[];
}

export interface StandardMemberLayout {
  name: string;
  /** Undefined after (or at) a member whose preceding storage size is unknown. */
  offsetBits?: number;
  layout: TypeLayoutResult;
}

export interface UnknownSizeDependency {
  /** Member path segments. `[]` denotes an ARRAY element. */
  path: string[];
  typeName: string;
  reason: string;
}

export type TypeLayoutResult = StandardTypeLayout | UnavailableTypeLayout;

function unavailable(typeName: string, reason: string): UnavailableTypeLayout {
  return { unavailable: `${typeName}: ${reason}`, unknownSizes: [{ path: [], typeName, reason }] };
}

function unavailableFrom(unknownSizes: UnknownSizeDependency[], memberLayouts?: StandardMemberLayout[]): UnavailableTypeLayout {
  const count = unknownSizes.length;
  return {
    unavailable: `${count} unknown-size dependenc${count === 1 ? "y" : "ies"}`,
    unknownSizes,
    memberLayouts,
  };
}

function prefixUnavailable(layout: UnavailableTypeLayout, segment: string): UnavailableTypeLayout {
  return unavailableFrom(layout.unknownSizes.map((issue) => ({ ...issue, path: [segment, ...issue.path] })));
}

export function isStandardTypeLayout(result: TypeLayoutResult): result is StandardTypeLayout {
  return "sizeBits" in result;
}

function alignUp(value: number, boundary: number): number {
  return Math.ceil(value / boundary) * boundary;
}

function addPadding(known: number | undefined, amount: number): number | undefined {
  return known === undefined ? undefined : known + amount;
}

function multiplyPadding(known: number | undefined, count: number): number | undefined {
  return known === undefined ? undefined : known * count;
}

class StandardLayoutCalculator {
  private readonly baseNames = new Map<string, string>();
  private readonly systemNames = new Map<string, string>();

  constructor(
    private readonly ruleSet: RuleSet,
    private readonly typeCache?: TypeCacheResult
  ) {
    for (const [name, entry] of Object.entries(ruleSet.baseTypes)) {
      this.baseNames.set(name.toLowerCase(), name);
      const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
      for (const alias of aliases) {
        if (typeof alias === "string" && !this.baseNames.has(alias.toLowerCase())) this.baseNames.set(alias.toLowerCase(), name);
      }
    }
    for (const name of Object.keys(ruleSet.systemTypes)) this.systemNames.set(name.toLowerCase(), name);
  }

  type(ref: TypeRef, visiting: Set<string> = new Set()): TypeLayoutResult {
    if (ref.kind === "reference") return unavailable("REF_TO", "storage depends on the target CPU and declaration context");
    if (ref.kind === "inline-struct") return this.members(ref.members, visiting);
    if (ref.kind === "array") return this.array(ref, visiting);
    return this.named(ref, visiting);
  }

  udt(name: string): TypeLayoutResult {
    const info = this.typeCache ? lookupType(this.typeCache, name) : undefined;
    if (!info || info.kind !== "udt" || !info.members) return unavailable(name, "PLC data type is not fully indexed");
    const visiting = new Set<string>([info.name.toLowerCase()]);
    return this.members(info.members, visiting);
  }

  members(members: MemberRef[], visiting: Set<string> = new Set()): TypeLayoutResult {
    // Resolve every member before calculating offsets. A missing size makes
    // all following offsets unknowable, but those later members must still
    // be visited so hover can report every blocker instead of only the first.
    const resolved = members.map((member) => ({ member, layout: this.type(member.typeRef, visiting) }));
    const unknownSizes = resolved.flatMap(({ member, layout }) =>
      isStandardTypeLayout(layout) ? [] : prefixUnavailable(layout, member.name).unknownSizes
    );

    let offset = 0;
    let paddingBits: number | undefined = 0;
    let previousWasPackedBool = false;
    let offsetKnown = true;
    const memberLayouts: StandardMemberLayout[] = [];

    for (const { member, layout } of resolved) {
      if (!isStandardTypeLayout(layout)) {
        memberLayouts.push({ name: member.name, layout });
        offsetKnown = false;
        previousWasPackedBool = false;
        continue;
      }
      if (!offsetKnown) {
        memberLayouts.push({ name: member.name, layout });
        continue;
      }
      const start = layout.boolPackable && previousWasPackedBool ? offset : alignUp(offset, layout.alignmentBits);
      memberLayouts.push({ name: member.name, offsetBits: start, layout });
      paddingBits = addPadding(paddingBits, start - offset);
      paddingBits = layout.paddingBits === undefined || paddingBits === undefined ? undefined : paddingBits + layout.paddingBits;
      offset = start + layout.sizeBits;
      previousWasPackedBool = layout.boolPackable;
    }

    if (unknownSizes.length > 0) return unavailableFrom(unknownSizes, memberLayouts);

    // Siemens STRUCT/PLC data types begin and end on a WORD boundary.
    const paddedEnd = alignUp(offset, 16);
    paddingBits = addPadding(paddingBits, paddedEnd - offset);
    return { sizeBits: paddedEnd, paddingBits, alignmentBits: 16, boolPackable: false, memberLayouts };
  }

  private named(ref: Extract<TypeRef, { kind: "named" }>, visiting: Set<string>): TypeLayoutResult {
    const baseName = this.baseNames.get(ref.name.toLowerCase());
    if (baseName) {
      const entry = this.ruleSet.baseTypes[baseName];
      const lower = baseName.toLowerCase();
      if (lower === "string" || lower === "wstring") {
        // STEP 7 defaults both String and WString to a maximum of 254
        // characters when no explicit [n] capacity is present.
        const capacity = ref.length ?? 254;
        const rawBits = lower === "string" ? (capacity + 2) * 8 : (capacity + 2) * 16;
        const sizeBits = alignUp(rawBits, 16);
        return { sizeBits, paddingBits: sizeBits - rawBits, alignmentBits: 16, boolPackable: false };
      }
      if (entry.sizeBits == null) return unavailable(baseName, "type registry has no fixed sizeBits value");
      const boolPackable = lower === "bool";
      return {
        sizeBits: entry.sizeBits,
        paddingBits: 0,
        alignmentBits: entry.sizeBits <= 8 ? 8 : 16,
        boolPackable,
      };
    }

    const systemName = this.systemNames.get(ref.name.toLowerCase());
    if (systemName) {
      const entry = this.ruleSet.systemTypes[systemName];
      if (entry.category === "system-alias") {
        return entry.basicDataType
          ? this.named({ kind: "named", name: entry.basicDataType, quoted: false, namespace: null }, visiting)
          : unavailable(systemName, "system alias has no underlying type in the registry");
      }
      if (typeof entry.sizeBytes === "number") {
        return { sizeBits: entry.sizeBytes * 8, alignmentBits: 16, boolPackable: false };
      }
      // A member list is useful for completion/hover, but is not proof that
      // the compiler-visible system structure is complete (several registry
      // entries intentionally contain partial member lists). Fail closed
      // unless an authoritative numeric sizeBytes accompanies it.
      const hasSizeBytes = Object.prototype.hasOwnProperty.call(entry, "sizeBytes");
      return unavailable(
        systemName,
        hasSizeBytes ? "system-type registry declares sizeBytes: null" : "system-type registry does not define sizeBytes"
      );
    }

    const info = this.typeCache ? lookupType(this.typeCache, ref.name) : undefined;
    if (!info || info.kind !== "udt" || !info.members) return unavailable(ref.name, "type has no fixed indexed layout");
    const cycleKey = info.name.toLowerCase();
    if (visiting.has(cycleKey)) return unavailable(info.name, "recursive PLC data type cannot have a finite size");
    visiting.add(cycleKey);
    const result = this.members(info.members, visiting);
    visiting.delete(cycleKey);
    return result;
  }

  private array(ref: Extract<TypeRef, { kind: "array" }>, visiting: Set<string>): TypeLayoutResult {
    if (ref.bounds.length === 0) return unavailable("ARRAY[*]", "has no compile-time element count");
    const element = this.type(ref.of, visiting);
    if (!isStandardTypeLayout(element)) return prefixUnavailable(element, "[]");

    let sizeBits = element.sizeBits;
    let paddingBits = element.paddingBits;
    // S7-SCL lays out multidimensional arrays row-by-row. Each dimension of
    // a byte-sized element ends at a BYTE boundary; other elements end at a
    // WORD boundary. The complete ARRAY is a structured value and therefore
    // begins/ends on a WORD boundary in standard storage.
    const dimensionBoundary = element.alignmentBits === 8 ? 8 : 16;
    for (let i = ref.bounds.length - 1; i >= 0; i--) {
      const [lo, hi] = ref.bounds[i];
      const count = hi - lo + 1;
      if (!Number.isSafeInteger(count) || count <= 0) return unavailable("ARRAY", `bound [${lo}..${hi}] has no positive finite length`);
      const repeated = sizeBits * count;
      if (!Number.isSafeInteger(repeated)) return unavailable("ARRAY", "size exceeds JavaScript's safe integer range");
      paddingBits = multiplyPadding(paddingBits, count);
      const aligned = alignUp(repeated, dimensionBoundary);
      paddingBits = addPadding(paddingBits, aligned - repeated);
      sizeBits = aligned;
    }
    const paddedEnd = alignUp(sizeBits, 16);
    paddingBits = addPadding(paddingBits, paddedEnd - sizeBits);
    return { sizeBits: paddedEnd, paddingBits, alignmentBits: 16, boolPackable: false };
  }
}

export function calculateStandardTypeLayout(ref: TypeRef, ruleSet: RuleSet, typeCache?: TypeCacheResult): TypeLayoutResult {
  return new StandardLayoutCalculator(ruleSet, typeCache).type(ref);
}

export function calculateStandardMemberLayout(members: MemberRef[], ruleSet: RuleSet, typeCache?: TypeCacheResult): TypeLayoutResult {
  return new StandardLayoutCalculator(ruleSet, typeCache).members(members);
}

export function calculateStandardUdtLayout(name: string, ruleSet: RuleSet, typeCache?: TypeCacheResult): TypeLayoutResult {
  return new StandardLayoutCalculator(ruleSet, typeCache).udt(name);
}
