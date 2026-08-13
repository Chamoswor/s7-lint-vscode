// Implements the design in resources/type-registry/udt-dependency-cache.md:
// seed elementary/system/opaque type names, insert every scanned UDT
// declaration, then resolve (unknown type), detect cycles (illegal
// recursive UDTs), check array bounds, and check struct nesting depth.
// Pure/no vscode dependency -- src/cache/cacheManager.ts wires this to
// the workspace (file discovery, watching, per-file diagnostics).
import { MemberRef, TypeRef, checkArrayBounds } from "../parser/typeRef";
import { RuleSet } from "../rules/types";

export type TypeKind = "elementary" | "system" | "opaque" | "udt";

export interface TypeInfo {
  name: string;
  kind: TypeKind;
  sourceFile?: string;
  declLine?: number;
  members?: MemberRef[];
  dependencies: Set<string>;
  resolved: boolean;
}

export interface CacheDiagnostic {
  file: string;
  line: number;
  severity: "error" | "warning";
  message: string;
  code: string;
}

export interface UdtSourceFile {
  path: string;
  decls: { name: string; members: MemberRef[]; line: number }[];
}

export interface TypeCacheResult {
  types: Map<string, TypeInfo>;
  diagnostics: CacheDiagnostic[];
  /** Lower-cased type name -> the key it occupies in `types`. Siemens type
   * names (elementary, system, AND user PLC data types alike) are
   * case-INSENSITIVE: `BYTE`/`Byte`/`byte` all name the same type, and TIA
   * Portal imports source declared any of those ways. `types` stores one
   * canonical spelling per type, so a raw `types.get(asWritten)` reported
   * perfectly valid declarations as unknown -- go through `lookupType`
   * instead of indexing `types` directly. */
  canonicalNames: Map<string, string>;
}

/** Case-insensitive `types` lookup -- see `TypeCacheResult.canonicalNames`. */
export function lookupType(result: TypeCacheResult, name: string): TypeInfo | undefined {
  const exact = result.types.get(name);
  if (exact) return exact;
  const canonical = result.canonicalNames.get(name.toLowerCase());
  return canonical === undefined ? undefined : result.types.get(canonical);
}

function seed(ruleSet: RuleSet): Map<string, TypeInfo> {
  const types = new Map<string, TypeInfo>();
  for (const name of Object.keys(ruleSet.baseTypes)) {
    types.set(name, { name, kind: "elementary", dependencies: new Set(), resolved: true });
  }
  for (const [name, entry] of Object.entries(ruleSet.systemTypes)) {
    types.set(name, {
      name,
      kind: "system",
      dependencies: new Set(),
      resolved: entry.category === "system-struct" ? entry.members != null : true,
    });
  }
  // Step 1b (resources/type-registry/udt-dependency-cache.md): names
  // section-legality.yaml treats as legal but that have no base-types.yaml
  // / system-types.yaml entry. Seeding these avoids false "unknown type"
  // errors on e.g. PID_CompactControl, F_SYSINFO, AOM_IDENT.
  for (const name of ruleSet.opaqueSectionNames) {
    if (!types.has(name)) {
      types.set(name, { name, kind: "opaque", dependencies: new Set(), resolved: true });
    }
  }
  return types;
}

function visitNamedRefs(ref: TypeRef, line: number, cb: (name: string, quoted: boolean, line: number) => void): void {
  if (ref.kind === "named") {
    cb(ref.name, ref.quoted, line);
  } else if (ref.kind === "array" || ref.kind === "reference") {
    // References can't legally appear as a UDT/STRUCT member at all (see
    // references.yaml's declaration.illegal) -- this branch is realistically
    // dead for valid input, kept only so malformed input still resolves
    // the referenced type instead of silently skipping it.
    visitNamedRefs(ref.of, line, cb);
  } else {
    for (const m of ref.members) visitNamedRefs(m.typeRef, m.line ?? line, cb);
  }
}

/** Resolves a type name to its cache entry. Always the case-insensitive
 * `findType` closure from `buildTypeCache` -- passed in rather than the raw
 * `types` map so a member that spelled its UDT/elementary type in different
 * casing than the declaration still resolves (see
 * `TypeCacheResult.canonicalNames`). */
type FindType = (name: string) => TypeInfo | undefined;

function isCompositeRef(ref: TypeRef, findType: FindType): boolean {
  if (ref.kind === "inline-struct") return true;
  if (ref.kind === "named") {
    const info = findType(ref.name);
    return !!(info && info.kind === "udt" && info.members);
  }
  return false;
}

/** Max nesting depth CONTRIBUTED BY a composite ref's own members (not
 * counting the ref's own "+1" hop -- callers that DO want that hop
 * counted go through `depthOfTypeRef` instead). `visiting` guards against
 * infinite recursion through an (illegal, separately-flagged) cycle.
 * `arrayCost` is composition-rules.yaml's `struct.nestingDepthRules.
 * arrayOfStructOrUdtCost` -- threaded through rather than hardcoded so
 * the YAML stays the single source of truth for the number. */
function depthOfCompositeMembers(ref: TypeRef, findType: FindType, visiting: Set<string>, arrayCost: number): number {
  if (ref.kind === "inline-struct") {
    let max = 0;
    for (const m of ref.members) max = Math.max(max, depthOfTypeRef(m.typeRef, findType, visiting, arrayCost));
    return max;
  }
  if (ref.kind === "named") {
    const info = findType(ref.name);
    if (!info || info.kind !== "udt" || !info.members || visiting.has(info.name)) return 0;
    visiting.add(info.name);
    let max = 0;
    for (const m of info.members) max = Math.max(max, depthOfTypeRef(m.typeRef, findType, visiting, arrayCost));
    visiting.delete(info.name);
    return max;
  }
  return 0;
}

/** Nesting depth per composition-rules.yaml#struct.nestingDepthRules,
 * counted INCLUSIVELY (a bare leaf is depth 1). An `Array of STRUCT/UDT`
 * hop costs `arrayCost` levels instead of the normal 1 a plain struct/UDT
 * member hop costs -- best-effort implementation of that rule; see this
 * file's header. */
function depthOfTypeRef(ref: TypeRef, findType: FindType, visiting: Set<string>, arrayCost: number): number {
  if (ref.kind === "named") {
    const info = findType(ref.name);
    if (!info || info.kind !== "udt" || !info.members || visiting.has(info.name)) return 1;
    visiting.add(info.name);
    let max = 0;
    for (const m of info.members) max = Math.max(max, depthOfTypeRef(m.typeRef, findType, visiting, arrayCost));
    visiting.delete(info.name);
    return 1 + max;
  }
  if (ref.kind === "inline-struct") {
    let max = 0;
    for (const m of ref.members) max = Math.max(max, depthOfTypeRef(m.typeRef, findType, visiting, arrayCost));
    return 1 + max;
  }
  // array
  if (!isCompositeRef(ref.of, findType)) return 1;
  return arrayCost + depthOfCompositeMembers(ref.of, findType, visiting, arrayCost);
}

export function buildTypeCache(ruleSet: RuleSet, files: UdtSourceFile[]): TypeCacheResult {
  const types = seed(ruleSet);
  const diagnostics: CacheDiagnostic[] = [];
  // Kept in lockstep with `types` from here on -- see
  // `TypeCacheResult.canonicalNames`. Seeded names win over a later UDT of
  // the same (case-insensitively equal) name, which is exactly what the
  // `reserved-name` check below already enforces.
  const canonicalNames = new Map<string, string>();
  for (const name of types.keys()) {
    if (!canonicalNames.has(name.toLowerCase())) canonicalNames.set(name.toLowerCase(), name);
  }
  const findType = (name: string): TypeInfo | undefined => {
    const exact = types.get(name);
    if (exact) return exact;
    const canonical = canonicalNames.get(name.toLowerCase());
    return canonical === undefined ? undefined : types.get(canonical);
  };
  const limits = ruleSet.composition.array.index.valueLimits;
  const nestingRules = ruleSet.composition.struct.nestingDepthRules;
  const nestingWarnDepth = nestingRules?.baseLimit ?? ruleSet.composition.struct.maxNestingDepth;
  const nestingErrorDepth = nestingRules?.extendedLimit ?? nestingWarnDepth;
  const arrayOfStructCost = nestingRules?.arrayOfStructOrUdtCost ?? 1;

  // Insert (step 4): every UDT declaration, flagging duplicates.
  for (const file of files) {
    for (const decl of file.decls) {
      const existing = findType(decl.name);
      if (existing && existing.kind === "udt") {
        diagnostics.push({
          file: file.path,
          line: decl.line,
          severity: "error",
          code: "duplicate-declaration",
          message: `Duplicate PLC data type declaration '${decl.name}' -- also declared in ${existing.sourceFile}.`,
        });
        if (existing.sourceFile && existing.sourceFile !== file.path) {
          diagnostics.push({
            file: existing.sourceFile,
            line: existing.declLine ?? 1,
            severity: "error",
            code: "duplicate-declaration",
            message: `Duplicate PLC data type declaration '${decl.name}' -- also declared in ${file.path}.`,
          });
        }
        continue; // keep the first-seen declaration authoritative
      }
      if (existing && existing.kind !== "udt") {
        diagnostics.push({
          file: file.path,
          line: decl.line,
          severity: "error",
          code: "reserved-name",
          message: `'${decl.name}' collides with a built-in ${existing.kind} type name -- a PLC data type cannot reuse it.`,
        });
        continue;
      }
      types.set(decl.name, {
        name: decl.name,
        kind: "udt",
        sourceFile: file.path,
        declLine: decl.line,
        members: decl.members,
        dependencies: new Set(),
        resolved: false,
      });
      canonicalNames.set(decl.name.toLowerCase(), decl.name);
    }
  }

  // Resolve (step 5) + array bounds (step 7): walk each UDT's members.
  for (const info of types.values()) {
    if (info.kind !== "udt" || !info.members || !info.sourceFile) continue;
    let allResolved = true;
    for (const m of info.members) {
      const memberLine = m.line ?? info.declLine ?? 1;
      visitNamedRefs(m.typeRef, memberLine, (depName, quoted, depLine) => {
        const dep = findType(depName);
        // Record the CANONICAL name so cycle detection (which indexes
        // `types` by dependency name) still finds the node when the member
        // spelled its type in different casing.
        info.dependencies.add(dep?.name ?? depName);
        if (!dep) {
          allResolved = false;
          diagnostics.push({
            file: info.sourceFile!,
            line: depLine,
            severity: quoted ? "error" : "warning",
            code: "unknown-type",
            message: quoted
              ? `Unknown PLC data type "${depName}" -- not declared anywhere in the scanned workspace. Check for a typo or a UDT that hasn't been imported yet.`
              : `Unknown type '${depName}' -- not a recognized elementary type, system type, or section-legality opaque name. Might be a real Siemens type not yet catalogued in this extension's rules -- see LintServer/README.md.`,
          });
        }
      });
      for (const issue of checkArrayBounds(m.typeRef, limits)) {
        diagnostics.push({
          file: info.sourceFile!,
          line: memberLine,
          severity: "error",
          code: "array-bounds",
          message: issue.message,
        });
      }
    }
    info.resolved = allResolved;
  }

  // Cycle detection (step 6): DFS over udt-kind nodes only.
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const info of types.values()) if (info.kind === "udt") color.set(info.name, WHITE);

  const reportedCycles = new Set<string>();
  const cycleMembers = new Set<string>();
  function dfs(name: string, stack: string[]): void {
    color.set(name, GRAY);
    stack.push(name);
    const info = types.get(name);
    if (info) {
      for (const dep of info.dependencies) {
        const depInfo = types.get(dep);
        if (!depInfo || depInfo.kind !== "udt") continue;
        const depColor = color.get(dep);
        if (depColor === GRAY) {
          const cycleStart = stack.indexOf(dep);
          const cyclePath = [...stack.slice(cycleStart), dep];
          const key = [...new Set(cyclePath)].sort().join(">");
          if (!reportedCycles.has(key)) {
            reportedCycles.add(key);
            for (const cn of new Set(cyclePath)) {
              cycleMembers.add(cn);
              const cInfo = types.get(cn);
              if (cInfo?.sourceFile) {
                diagnostics.push({
                  file: cInfo.sourceFile,
                  line: cInfo.declLine ?? 1,
                  severity: "error",
                  code: "circular-dependency",
                  message: `Circular PLC data type dependency: ${cyclePath.join(" -> ")}. TIA disallows recursive/self-referencing UDTs.`,
                });
              }
            }
          }
        } else if (depColor === WHITE) {
          dfs(dep, stack);
        }
      }
    }
    stack.pop();
    color.set(name, BLACK);
  }
  for (const name of color.keys()) {
    if (color.get(name) === WHITE) dfs(name, []);
  }

  // Nesting depth (step 8), skipped for any UDT already flagged in a cycle
  // (depth is meaningless/infinite there).
  for (const info of types.values()) {
    if (info.kind !== "udt" || !info.members || !info.sourceFile) continue;
    if (!info.resolved) continue;
    if (cycleMembers.has(info.name)) continue; // depth is meaningless/unbounded inside an (already-flagged) cycle
    // PRE-EXISTING BUG FIXED HERE: `visiting` must start EMPTY. Both
    // depthOfCompositeMembers/depthOfTypeRef's own "named" branches add
    // `ref.name` to `visiting` THEMSELVES right before recursing into that
    // type's members (and remove it after) -- that's what makes the guard
    // correctly detect a NESTED self-reference. Seeding `visiting` with
    // `info.name` up front (as this line used to) pre-poisons it with the
    // very name the very first "named" check is about to test, so
    // `visiting.has(ref.name)` was always true on the FIRST call and every
    // UDT's nesting depth silently computed as exactly 1, forever -- this
    // diagnostic could never actually fire. Safe to start empty: any UDT
    // reachable from here already passed the separate cycle-detection pass
    // above (the `cycleMembers.has` check just above skips cyclic ones).
    const depth = 1 + depthOfCompositeMembers({ kind: "named", name: info.name, quoted: false, namespace: null }, findType, new Set<string>(), arrayOfStructCost);
    const firmwareGate = Object.entries(nestingRules?.extendedLimitFirmwareGate ?? {})
      .map(([platform, floor]) => `${platform} FW${floor}`)
      .join(" / ");
    if (depth > nestingErrorDepth) {
      diagnostics.push({
        file: info.sourceFile,
        line: info.declLine ?? 1,
        severity: "error",
        code: "nesting-depth",
        message: `Struct nesting depth ${depth} exceeds even the extended ${nestingErrorDepth}-level ceiling (${firmwareGate}) -- see composition-rules.yaml#struct.maxNestingDepthNote.`,
      });
    } else if (depth > nestingWarnDepth) {
      diagnostics.push({
        file: info.sourceFile,
        line: info.declLine ?? 1,
        severity: "warning",
        code: "nesting-depth",
        message: `Struct nesting depth ${depth} exceeds the base ${nestingWarnDepth}-level ceiling -- legal only on ${firmwareGate} (ceiling ${nestingErrorDepth}) or in an InOut-section member (ceiling ${nestingWarnDepth + (nestingRules?.inOutSectionBonus ?? 0)}). Confirm the target firmware/section before treating this as fine.`,
      });
    }
  }

  return { types, diagnostics, canonicalNames };
}
