// Data-type availability per CPU family, from
// type-registry/platform-availability.yaml. The supported source files never
// name their target CPU, so these facts apply only once the user configures
// one (`tiaLint.targetPlatform`, see config.ts).
import { resolveTypeAlias } from "./literalTypes";
import type { RuleSet } from "./types";

/** The CPU families platform-availability.yaml has a column for. */
export const TARGET_PLATFORMS = ["S7-300/400", "S7-1200", "S7-1200 G2", "S7-1500"] as const;
export type TargetPlatform = (typeof TARGET_PLATFORMS)[number];

/** Available, unavailable, or -- on an S7-1200 G2 -- available only while
 * the CPU runs in S7-1500-compatible mode. */
export type PlatformSupport = boolean | "S7-1500-compatible";

/** Lower-cased type name or alias -> its support per platform. A platform
 * missing from a row is one the registry states no fact for. */
export type PlatformAvailability = Map<string, Partial<Record<TargetPlatform, PlatformSupport>>>;

/** The categories whose rows are linted. `systemDataTypes` is left out: the
 * file's own caveat says nearly all of its rows were guessed from merged
 * table cells, and one guess (VREF) has already proved wrong. */
const LINTED_CATEGORIES = new Set([
  "binaryNumbers",
  "bitStrings",
  "integers",
  "floatingPoint",
  "timers",
  "dateAndTime",
  "characterStrings",
  "pointer",
  "parameterTypes",
  "hardwareDataTypes",
]);

/** A row the file itself marks unresolved: its legacy ANY pointer may not be
 * the `Any` section-legality.yaml allows on S7-1200. */
const UNRESOLVED_ROWS = new Set(["Any"]);

export function isTargetPlatform(value: unknown): value is TargetPlatform {
  return typeof value === "string" && (TARGET_PLATFORMS as readonly string[]).includes(value);
}

/** Builds the lookup from platform-availability.yaml's parsed content. */
export function parsePlatformAvailability(raw: unknown): PlatformAvailability {
  const availability: PlatformAvailability = new Map();
  const categories = (raw as { categories?: Record<string, Record<string, unknown> | null> } | null)?.categories ?? {};
  for (const [category, rows] of Object.entries(categories)) {
    if (!LINTED_CATEGORIES.has(category) || !rows) continue;
    for (const [typeName, row] of Object.entries(rows)) {
      if (typeName.startsWith("_") || UNRESOLVED_ROWS.has(typeName) || typeof row !== "object" || row === null) continue;
      const fields = row as Record<string, unknown>;
      const support: Partial<Record<TargetPlatform, PlatformSupport>> = {};
      for (const platform of TARGET_PLATFORMS) {
        const value = fields[platform];
        // Anything else ("unconfirmed -- see notes", a footnote) is not a fact to lint against.
        if (value === true || value === false || value === "S7-1500-compatible") support[platform] = value;
      }
      const aliases = Array.isArray(fields.aliases) ? fields.aliases.filter((alias): alias is string => typeof alias === "string") : [];
      for (const name of [typeName, ...aliases]) availability.set(name.toLowerCase(), support);
    }
  }
  return availability;
}

/** How `typeName` is supported on `platform`, or undefined when the linted
 * rows say nothing about it (a UDT, a system type, an unknown name). */
export function platformSupport(ruleSet: RuleSet, typeName: string, platform: TargetPlatform): PlatformSupport | undefined {
  const row =
    ruleSet.platformAvailability.get(typeName.toLowerCase()) ??
    ruleSet.platformAvailability.get(resolveTypeAlias(typeName, ruleSet).toLowerCase());
  return row?.[platform];
}
