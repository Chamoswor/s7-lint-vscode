// Loads the external, authoritative registry files and turns them into the
// grouped/searchable option catalogs the editor UI binds its dropdowns and
// multiselects to. These files are READ-ONLY inputs -- the editor never writes
// them -- so js-yaml (the linter's own loader) is used here, not the
// comment-preserving eemeli path reserved for editable instruction files.
//
// Everything selectable that "already exists in a registry file" is derived
// here from that file, so changing e.g. memory.yaml's memoryAreas or
// base-types.yaml's type list changes the editor's offered choices with no
// code change -- exactly the dynamic behavior the task brief requires.
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import {
  BaseTypeRegistry,
  BcdFormatRegistry,
  CategoryIndex,
  MemoryAreaRegistry,
  ResultSchema,
  SystemTypeRegistry,
} from "../rules/types";
import { EXTERNAL_REGISTRY_FILES } from "./registryPaths";

export interface Option {
  value: string;
  /** Human label; defaults to value when omitted. */
  label?: string;
  description?: string;
}

export interface OptionGroup {
  group: string;
  options: Option[];
}

/** Everything the editor UI needs to render type/memory/result/category
 * choices, plus the sets validation checks references against. */
export interface OptionCatalog {
  /** Legal pin/EN-ENO memory areas (memory.yaml `memoryAreas` keys). */
  memoryAreas: Option[];
  /** Legal `allowedDeclarations` sections (memory.yaml `declarationMapping`). */
  declarationSections: Option[];
  /** result.yaml-derived choices. */
  resultKinds: Option[];
  resultInferenceRules: Option[];
  resultTransforms: Option[];
  resultUsageContexts: Option[];
  /** Type-name reference sets, for validation. */
  baseTypeNames: Set<string>;
  systemTypeNames: Set<string>;
  bcdFormatNames: Set<string>;
  umbrellaLabelNames: Set<string>;
  categoryNames: string[];
  /** Grouped, searchable options for a pin's `dataTypes` multiselect:
   * umbrella labels first, then base types grouped by their category, then
   * system types, then the explicit "all types" wildcard. */
  dataTypeGroups: OptionGroup[];
  /** Every value legal in a pin `dataTypes` list -- for validation. */
  validPinDataTypes: Set<string>;
  /** Every value legal as a `template.keys` type reference or `S7_Templates`
   * value referencing a type (base + system + bcd formats). */
  validTemplateTypeNames: Set<string>;
}

function loadYaml<T>(file: string): T {
  return yaml.load(fs.readFileSync(file, "utf-8")) as T;
}

function keysAsOptions(obj: Record<string, unknown> | undefined, describe?: (v: unknown) => string | undefined): Option[] {
  if (!obj) return [];
  return Object.keys(obj).map((value) => {
    const description = describe ? describe(obj[value]) : undefined;
    return description ? { value, description } : { value };
  });
}

/** Overrides let the editor build the catalog from BUFFERED (unsaved) registry
 * content instead of what's on disk -- so a system type the user just added in
 * the editor immediately counts as "known" for validation and dropdowns,
 * before Save. */
export interface CatalogOverrides {
  systemTypes?: SystemTypeRegistry;
}

/** Loads all external registries and assembles the option catalog. */
export function loadOptionCatalog(resourcesDir: string, overrides?: CatalogOverrides): OptionCatalog {
  const p = (rel: string) => path.join(resourcesDir, rel);
  const memory = loadYaml<MemoryAreaRegistry>(p(EXTERNAL_REGISTRY_FILES.memory));
  const result = loadYaml<ResultSchema>(p(EXTERNAL_REGISTRY_FILES.result));
  const baseTypes = loadYaml<BaseTypeRegistry>(p(EXTERNAL_REGISTRY_FILES.baseTypes));
  const systemTypes = overrides?.systemTypes ?? loadYaml<SystemTypeRegistry>(p(EXTERNAL_REGISTRY_FILES.systemTypes));
  const categoryIndex = loadYaml<CategoryIndex>(p(EXTERNAL_REGISTRY_FILES.categoryIndex));
  const bcdFormats = loadYaml<BcdFormatRegistry>(p(EXTERNAL_REGISTRY_FILES.bcdFormats));

  const memoryAreas = keysAsOptions(
    memory.memoryAreas as unknown as Record<string, unknown>,
    (v) => (v as { description?: string })?.description
  );
  const declarationSections = keysAsOptions(memory.declarationMapping as unknown as Record<string, unknown>);

  const resultKinds = keysAsOptions(
    result.resultKinds as unknown as Record<string, unknown>,
    (v) => (v as { description?: string })?.description
  );
  const resultInferenceRules = keysAsOptions(
    result.inferenceRules as unknown as Record<string, unknown>,
    (v) => (v as { description?: string })?.description
  );
  const resultTransforms = keysAsOptions(
    result.transforms as unknown as Record<string, unknown>,
    (v) => (v as { description?: string })?.description
  );
  const resultUsageContexts = keysAsOptions(
    result.usageContexts as unknown as Record<string, unknown>,
    (v) => (v as { description?: string })?.description
  );

  const baseTypeNames = new Set(Object.keys(baseTypes));
  const systemTypeNames = new Set(Object.keys(systemTypes));
  const bcdFormatNames = new Set(Object.keys(bcdFormats));
  const umbrellaLabelNames = new Set(Object.keys(categoryIndex.umbrellaLabels ?? {}));
  const categoryNames = Object.keys(categoryIndex.categoriesByType ?? {});

  // Grouped data-type options: umbrella labels, then base types grouped by
  // their own `category`, then system types. Base-type grouping uses each
  // type's `category` field so a new type appears under the right heading
  // automatically.
  const byCategory = new Map<string, Option[]>();
  for (const [name, entry] of Object.entries(baseTypes)) {
    const cat = (entry as { category?: string }).category ?? "other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push({ value: name });
  }
  const dataTypeGroups: OptionGroup[] = [];
  if (umbrellaLabelNames.size) {
    dataTypeGroups.push({
      group: "Umbrella labels",
      options: [...umbrellaLabelNames].map((value) => ({ value })),
    });
  }
  for (const [cat, options] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    dataTypeGroups.push({ group: `Base types: ${cat}`, options });
  }
  if (systemTypeNames.size) {
    dataTypeGroups.push({
      group: "System types",
      options: [...systemTypeNames].map((value) => ({ value })),
    });
  }
  // BCD formats are NOT declarable data types (bcd-formats.yaml sets
  // `notAValidDatatype: true`), but that prohibition is about VAR/STRUCT
  // DECLARATIONS. That same file documents them as legitimate on a conversion
  // instruction's pins ("the format a conversion instruction reads/writes",
  // naming Convert explicitly) -- which is exactly what an instruction pin's
  // `dataTypes` list describes. So they belong here, in their own group so the
  // distinction stays visible.
  if (bcdFormatNames.size) {
    dataTypeGroups.push({
      group: "BCD formats (conversion instructions only)",
      options: [...bcdFormatNames].map((value) => ({
        value,
        description: "Numeric format for conversion instructions; not declarable in a VAR/STRUCT",
      })),
    });
  }
  dataTypeGroups.push({
    group: "Wildcard",
    options: [{ value: "*", description: "Source explicitly allows every data type" }],
  });

  // A pin dataTypes value may be an umbrella label, a base type, a system
  // type, a BCD conversion format, or the "*" wildcard. (Array/Struct/Any etc.
  // are base types.)
  const validPinDataTypes = new Set<string>(["*"]);
  for (const s of umbrellaLabelNames) validPinDataTypes.add(s);
  for (const s of baseTypeNames) validPinDataTypes.add(s);
  for (const s of systemTypeNames) validPinDataTypes.add(s);
  for (const s of bcdFormatNames) validPinDataTypes.add(s);

  // Template keys/values that name a type resolve against concrete type names
  // (base + system) plus BCD formats (legal only as S7_Templates values).
  const validTemplateTypeNames = new Set<string>();
  for (const s of baseTypeNames) validTemplateTypeNames.add(s);
  for (const s of systemTypeNames) validTemplateTypeNames.add(s);
  for (const s of bcdFormatNames) validTemplateTypeNames.add(s);

  return {
    memoryAreas,
    declarationSections,
    resultKinds,
    resultInferenceRules,
    resultTransforms,
    resultUsageContexts,
    baseTypeNames,
    systemTypeNames,
    bcdFormatNames,
    umbrellaLabelNames,
    categoryNames,
    dataTypeGroups,
    validPinDataTypes,
    validTemplateTypeNames,
  };
}
