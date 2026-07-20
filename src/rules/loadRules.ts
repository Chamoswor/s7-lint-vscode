// Loads the bundled YAML knowledge base directly from ./resources into
// typed in-memory maps. The resources directory is the canonical source.
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { isSclFile } from "./fileLanguage";
import {
  AnyPointerRegistry,
  BaseTypeRegistry,
  BcdFormatRegistry,
  CategoryIndex,
  CompositionRules,
  DiagnosticRegistry,
  ExpressionOperatorRules,
  InstructionEntry,
  InstructionRegistry,
  MemoryAreaRegistry,
  PointerTypeRegistry,
  ReferencesRegistry,
  ResultSchema,
  RuleSet,
  SectionLegality,
  SymbolicRuntimeAccessRegistry,
  SystemRegistry,
  SystemTypeRegistry,
} from "./types";

function readYaml<T>(filePath: string): T {
  const text = fs.readFileSync(filePath, "utf-8");
  return yaml.load(text) as T;
}

/** Reserved key (never a real instruction name -- those are all plain PLC
 * identifiers) a family file can set ONCE to default every entry in that
 * file to a given `language` instead of repeating it on each one --
 * see instruction-registry/README.md's "Per-language instructions". An
 * entry's OWN `language` field (if it sets one) always wins over this. */
const FILE_LANGUAGE_KEY = "$fileLanguage";

// SCL files are routed into `RuleSet.sclInstructions` (a SEPARATE map from
// `RuleSet.instructions`) so e.g. an SCL-cased `TP` entry doesn't collide with
// the graphical (LAD/FBD) `TP` entry in the shared map. Which files are "SCL"
// is decided by `isSclFile` (basename prefix `SCL-*.yaml` OR suffix
// `*-SCL.yaml`) -- see rules/fileLanguage.ts. (Previously this keyed only off
// the `-SCL.yaml` suffix, which matched none of the repo's prefix-named files,
// so every SCL entry fell into the general map and silently collided with its
// LAD/FBD namesake.)

/** A reference/copy-me schema file, not real registry data -- never a real
 * instruction name (all of those are plain PLC identifiers), so it can't
 * collide with one either; see its own header comment. Excluded here
 * independently of the real registry entries. */
const TEMPLATE_FILE = "_template.yaml";

/** Recursively lists every file under `dir`, so instruction-registry entries
 * can be sorted into subfolders (e.g. `motion/12c-motion-axis-LAD-FBD.yaml`)
 * without changing how they load -- see instruction-registry/README.md's
 * "Subfolders" section. Only the file's basename (not its subfolder path)
 * is meaningful to callers, matching the flat layout's naming rules. */
function listFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function loadInstructionRegistry(dir: string, includeFile: (fileName: string) => boolean): InstructionRegistry {
  const merged: InstructionRegistry = {};
  for (const filePath of listFilesRecursive(dir)) {
    const file = path.basename(filePath);
    if (file === TEMPLATE_FILE) continue;
    if (!file.endsWith(".yaml") || !includeFile(file)) continue;
    const parsed = readYaml<Record<string, unknown>>(filePath);
    const fileLanguage = parsed[FILE_LANGUAGE_KEY] as string[] | undefined;
    for (const [name, value] of Object.entries(parsed)) {
      if (name === FILE_LANGUAGE_KEY) continue;
      const entry = value as InstructionEntry;
      merged[name] = fileLanguage && !entry.language ? { ...entry, language: fileLanguage } : entry;
    }
  }
  return merged;
}

/** Names section-legality.yaml treats as legal in a VAR_* section but that
 * have no base-types.yaml / system-types.yaml entry -- see
 * resources/type-registry/udt-dependency-cache.md's Build algorithm step 1b. */
function computeOpaqueNames(
  sectionLegality: SectionLegality,
  baseTypes: BaseTypeRegistry,
  systemTypes: SystemTypeRegistry
): Set<string> {
  const names = new Set<string>(sectionLegality.allSections.datatypes);
  for (const section of Object.values(sectionLegality.sections)) {
    for (const n of section.additionalDatatypes) names.add(n);
  }
  names.delete("Array[0..1] of"); // placeholder, not a real name -- see section-legality.yaml's trailing comment
  const opaque = new Set<string>();
  for (const n of names) {
    if (!(n in baseTypes) && !(n in systemTypes)) opaque.add(n);
  }
  return opaque;
}

function loadSystemRegistry(resourcesDir: string): SystemRegistry {
  const systemDir = path.join(resourcesDir, "system-registry");
  return {
    memory: readYaml<MemoryAreaRegistry>(path.join(systemDir, "memory.yaml")),
    result: readYaml<ResultSchema>(path.join(systemDir, "result.yaml")),
  };
}

/** Loads every `*.yaml` file in resources/diagnostic-registry/ into one
 * flat code -> DiagnosticSpec map -- same "one file per source module,
 * merged into a single map" shape `loadInstructionRegistry` uses, but
 * without that function's per-file `$fileLanguage` default (a diagnostic
 * code's severity/message never varies by which file it happens to be
 * declared in). Two files declaring the same code is a registry bug (a
 * copy-paste of an existing code into the wrong file) -- the later file
 * silently wins, same "trust the data" discipline `loadInstructionRegistry`
 * itself applies rather than adding a runtime duplicate-key guard here. */
function loadDiagnosticRegistry(resourcesDir: string): DiagnosticRegistry {
  const dir = path.join(resourcesDir, "diagnostic-registry");
  const merged: DiagnosticRegistry = {};
  for (const file of fs.readdirSync(dir)) {
    if (file === TEMPLATE_FILE || !file.endsWith(".yaml")) continue;
    Object.assign(merged, readYaml<DiagnosticRegistry>(path.join(dir, file)));
  }
  return merged;
}

export function loadRuleSet(resourcesDir: string): RuleSet {
  const typeDir = path.join(resourcesDir, "type-registry");
  const instrDir = path.join(resourcesDir, "instruction-registry");

  const baseTypes = readYaml<BaseTypeRegistry>(path.join(typeDir, "base-types.yaml"));
  const systemTypes = readYaml<SystemTypeRegistry>(path.join(typeDir, "system-types.yaml"));
  const sectionLegality = readYaml<SectionLegality>(path.join(typeDir, "section-legality.yaml"));
  const composition = readYaml<CompositionRules>(path.join(typeDir, "composition-rules.yaml"));
  const categoryIndex = readYaml<CategoryIndex>(path.join(typeDir, "category-index.yaml"));
  const bcdFormats = readYaml<BcdFormatRegistry>(path.join(typeDir, "bcd-formats.yaml"));
  const instructions = loadInstructionRegistry(instrDir, (f) => !isSclFile(f));
  const sclInstructions = loadInstructionRegistry(instrDir, (f) => isSclFile(f));
  const anyPointer = readYaml<AnyPointerRegistry>(path.join(typeDir, "any-pointer.yaml"));
  const pointerType = readYaml<PointerTypeRegistry>(path.join(typeDir, "pointer-type.yaml"));
  const references = readYaml<ReferencesRegistry>(path.join(typeDir, "references.yaml"));
  const symbolicRuntimeAccess = readYaml<SymbolicRuntimeAccessRegistry>(path.join(typeDir, "symbolic-runtime-access.yaml"));
  const exprOperators = readYaml<ExpressionOperatorRules>(path.join(typeDir, "expression-operators.yaml"));

  return {
    instructions,
    sclInstructions,
    baseTypes,
    systemTypes,
    sectionLegality,
    composition,
    categoryIndex,
    bcdFormats,
    opaqueSectionNames: computeOpaqueNames(sectionLegality, baseTypes, systemTypes),
    systemRegistry: loadSystemRegistry(resourcesDir),
    anyPointer,
    pointerType,
    references,
    symbolicRuntimeAccess,
    exprOperators,
    diagnostics: loadDiagnosticRegistry(resourcesDir),
  };
}
