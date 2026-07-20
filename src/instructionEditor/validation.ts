// Validation for instruction-registry entries -- both a single entry (used for
// live, in-editor feedback) and the whole registry (duplicate names, empty
// files). Findings are structured (file/entry/fieldPath/allowed/suggestion) so
// the UI error panel can render concrete, actionable messages and deep-link to
// the offending field, as the task brief requires.
//
// This is NEW logic: the linter validates instruction CALL SITES against an
// entry, but nothing today validates an ENTRY ITSELF at authoring time
// (loadRules.ts blind-casts the YAML). It reuses the same reference data the
// linter uses (memory areas, base/system types, result kinds) via the
// OptionCatalog, so "valid" here means the same thing it means at lint time.
import { OptionCatalog } from "./externalRegistries";
import {
  CALL_SHAPES,
  CONFIDENCE_LEVELS,
  KNOWN_ENTRY_FIELDS,
  KNOWN_PIN_FIELDS,
  PIN_DIRS,
  REQUIRED_ENTRY_FIELDS,
  TEMPLATE_SHAPES,
} from "./schemaEnums";

export type Severity = "error" | "warning";

export interface ValidationFinding {
  severity: Severity;
  code: string;
  /** relPath of the file (set by whole-registry validation). */
  file?: string;
  /** Instruction name and stable uid (set by whole-registry validation). */
  entry?: string;
  entryUid?: string;
  /** Dotted/bracketed path within the entry, e.g. `pins[0].dataTypes[1]`. */
  fieldPath: string;
  message: string;
  /** Legal values, when the problem is an out-of-set value. */
  allowed?: string[];
  suggestion?: string;
}

/** Precomputed sets/derived data an entry check needs, built once per session
 * (or per registry reload) from the option catalog + observed families. */
export interface ValidationContext {
  catalog: OptionCatalog;
  memoryAreaSet: Set<string>;
  declarationSet: Set<string>;
  resultKindSet: Set<string>;
  resultInferenceRuleSet: Set<string>;
  resultTransformSet: Set<string>;
  resultUsageContextSet: Set<string>;
  concreteTypeSet: Set<string>;
  familySet: Set<string>;
}

export function makeValidationContext(catalog: OptionCatalog, families: Iterable<string>): ValidationContext {
  const concreteTypeSet = new Set<string>([...catalog.baseTypeNames, ...catalog.systemTypeNames]);
  return {
    catalog,
    memoryAreaSet: new Set(catalog.memoryAreas.map((o) => o.value)),
    declarationSet: new Set(catalog.declarationSections.map((o) => o.value)),
    resultKindSet: new Set(catalog.resultKinds.map((o) => o.value)),
    resultInferenceRuleSet: new Set(catalog.resultInferenceRules.map((o) => o.value)),
    resultTransformSet: new Set(catalog.resultTransforms.map((o) => o.value)),
    resultUsageContextSet: new Set(catalog.resultUsageContexts.map((o) => o.value)),
    concreteTypeSet,
    familySet: new Set(families),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Suggest the closest allowed value (single edit-distance-ish) for a typo. */
function suggest(value: string, allowed: Iterable<string>): string | undefined {
  const lower = value.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const a of allowed) {
    if (a.toLowerCase() === lower) return a; // case-only difference
    const score = editDistance(lower, a.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best && bestScore <= 2 ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

/** Validate one entry's plain-JS value. Returns findings without file/entry
 * identity set (the whole-registry pass fills those in). */
export function validateEntry(entry: Record<string, unknown>, ctx: ValidationContext): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const add = (f: ValidationFinding) => out.push(f);

  // Required fields.
  for (const field of REQUIRED_ENTRY_FIELDS) {
    if (!(field in entry)) {
      add({ severity: "error", code: "missing-required-field", fieldPath: field, message: `Missing required field '${field}'.` });
    }
  }

  // Unknown (preserved) top-level fields.
  for (const key of Object.keys(entry)) {
    if (!KNOWN_ENTRY_FIELDS.has(key)) {
      add({
        severity: "warning",
        code: "unknown-field",
        fieldPath: key,
        message: `Unknown field '${key}' is preserved on save but not understood by the editor.`,
        suggestion: suggest(key, KNOWN_ENTRY_FIELDS),
      });
    }
  }

  // Enum-ish scalar fields.
  checkEnum(entry.family, "family", ctx.familySet, "warning", "unknown-family", add);
  checkEnum(entry.callShape, "callShape", new Set(CALL_SHAPES), "error", "invalid-call-shape", add);
  checkEnum(entry.confidence, "confidence", new Set(CONFIDENCE_LEVELS), "error", "invalid-confidence", add);

  // instanceType vs callShape.
  const callShape = entry.callShape;
  if (callShape === "instance-dot" || callShape === "coil-ref") {
    const it = entry.instanceType;
    if (it == null) {
      // A coil/instance call may instead take its instance as a PIN OPERAND --
      // e.g. PT_Coil/RT_Coil accept any of the four IEC timer structures via
      // their `timer` pin, so a single entry-level instanceType would be wrong
      // and the registry deliberately leaves it null. Only flag entries where
      // no pin carries an instance type either.
      const pinCarriesInstance =
        Array.isArray(entry.pins) &&
        entry.pins.some(
          (p) =>
            isObj(p) &&
            Array.isArray(p.dataTypes) &&
            p.dataTypes.some((t) => typeof t === "string" && ctx.catalog.systemTypeNames.has(t))
        );
      if (!pinCarriesInstance) {
        add({
          severity: "warning",
          code: "missing-instance-type",
          fieldPath: "instanceType",
          message: `callShape '${callShape}' usually requires an instanceType (or a pin that carries the instance type).`,
        });
      }
    } else if (typeof it === "string" && !ctx.catalog.systemTypeNames.has(it)) {
      add({ severity: "warning", code: "unknown-instance-type", fieldPath: "instanceType", message: `instanceType '${it}' is not a known system type.`, allowed: [...ctx.catalog.systemTypeNames], suggestion: suggest(it, ctx.catalog.systemTypeNames) });
    }
  }

  // Template.
  if ("template" in entry) validateTemplate(entry.template, ctx, add);

  // Pins.
  if ("pins" in entry) {
    if (!Array.isArray(entry.pins)) {
      add({ severity: "error", code: "invalid-pins", fieldPath: "pins", message: "'pins' must be a list." });
    } else {
      entry.pins.forEach((pin, i) => validatePin(pin, `pins[${i}]`, ctx, add));
    }
  }

  // enEno.
  if ("enEno" in entry && entry.enEno != null) validateEnEno(entry.enEno, ctx, add);

  // result.
  if ("result" in entry && entry.result != null) validateResult(entry.result, entry, ctx, add);

  return out;
}

function checkEnum(
  value: unknown,
  fieldPath: string,
  allowed: Set<string>,
  severity: Severity,
  code: string,
  add: (f: ValidationFinding) => void
): void {
  if (value == null) return; // absence handled by required-field check
  if (typeof value !== "string" || !allowed.has(value)) {
    add({
      severity,
      code,
      fieldPath,
      message: `Invalid ${fieldPath} '${String(value)}'.`,
      allowed: [...allowed],
      suggestion: typeof value === "string" ? suggest(value, allowed) : undefined,
    });
  }
}

function validateTemplate(template: unknown, _ctx: ValidationContext, add: (f: ValidationFinding) => void): void {
  if (!isObj(template)) {
    add({ severity: "error", code: "invalid-template", fieldPath: "template", message: "'template' must be a mapping." });
    return;
  }
  checkEnum(template.shape, "template.shape", new Set(TEMPLATE_SHAPES), "error", "invalid-template-shape", add);
  if ("keys" in template && !Array.isArray(template.keys)) {
    add({ severity: "error", code: "invalid-template-keys", fieldPath: "template.keys", message: "'template.keys' must be a list." });
  }
  if ("extra" in template && !isObj(template.extra)) {
    add({ severity: "error", code: "invalid-template-extra", fieldPath: "template.extra", message: "'template.extra' must be a mapping." });
  }
}

function validatePin(pin: unknown, at: string, ctx: ValidationContext, add: (f: ValidationFinding) => void): void {
  if (!isObj(pin)) {
    add({ severity: "error", code: "invalid-pin", fieldPath: at, message: "Each pin must be a mapping." });
    return;
  }
  // name: string | null.
  if ("name" in pin && pin.name != null && typeof pin.name !== "string") {
    add({ severity: "error", code: "invalid-pin-name", fieldPath: `${at}.name`, message: "Pin 'name' must be a string or null." });
  }
  checkEnum(pin.dir, `${at}.dir`, new Set(PIN_DIRS), "error", "invalid-pin-dir", add);
  if ("required" in pin && typeof pin.required !== "boolean") {
    add({ severity: "error", code: "invalid-pin-required", fieldPath: `${at}.required`, message: "Pin 'required' must be a boolean." });
  }
  // Unknown TYPE references are warnings, not errors: the type registry is
  // deliberately incomplete (README "Current limitations" -- shape-only
  // entries, uncatalogued instance types like TON_TIME), and the linter's own
  // discipline is never to hard-error an uncertain type fact. Memory areas and
  // declaration sections, by contrast, are small CLOSED enums, so a value
  // outside them is a genuine error.
  checkStringListRefs(pin.dataTypes, `${at}.dataTypes`, ctx.catalog.validPinDataTypes, "warning", "unknown-data-type", add);
  checkStringListRefs(pin.memoryAreas, `${at}.memoryAreas`, ctx.memoryAreaSet, "error", "unknown-memory-area", add);
  checkStringListRefs(pin.allowedDeclarations, `${at}.allowedDeclarations`, ctx.declarationSet, "error", "unknown-declaration-section", add);

  for (const key of Object.keys(pin)) {
    if (!KNOWN_PIN_FIELDS.has(key)) {
      add({ severity: "warning", code: "unknown-pin-field", fieldPath: `${at}.${key}`, message: `Unknown pin field '${key}' preserved on save.`, suggestion: suggest(key, KNOWN_PIN_FIELDS) });
    }
  }
}

function checkStringListRefs(
  value: unknown,
  fieldPath: string,
  allowed: Set<string>,
  severity: Severity,
  code: string,
  add: (f: ValidationFinding) => void
): void {
  if (value == null) return;
  if (!Array.isArray(value)) {
    add({ severity: "error", code: "invalid-list", fieldPath, message: `'${fieldPath}' must be a list.` });
    return;
  }
  value.forEach((item, i) => {
    if (typeof item !== "string") {
      add({ severity: "error", code: "invalid-list-item", fieldPath: `${fieldPath}[${i}]`, message: `Value must be a string.` });
      return;
    }
    if (!allowed.has(item)) {
      add({
        severity,
        code,
        fieldPath: `${fieldPath}[${i}]`,
        message: `'${item}' is not a recognized value for ${fieldPath}.`,
        allowed: [...allowed],
        suggestion: suggest(item, allowed),
      });
    }
  });
}

function validateEnEno(enEno: unknown, ctx: ValidationContext, add: (f: ValidationFinding) => void): void {
  if (!isObj(enEno)) {
    add({ severity: "error", code: "invalid-eneno", fieldPath: "enEno", message: "'enEno' must be a mapping." });
    return;
  }
  for (const side of ["en", "eno"] as const) {
    const s = enEno[side];
    if (s == null) continue;
    if (!isObj(s)) {
      add({ severity: "error", code: "invalid-eneno-side", fieldPath: `enEno.${side}`, message: `'enEno.${side}' must be a mapping.` });
      continue;
    }
    if ("present" in s && typeof s.present !== "boolean") {
      add({ severity: "error", code: "invalid-eneno-present", fieldPath: `enEno.${side}.present`, message: "'present' must be a boolean." });
    }
    const ma = s.memoryArea;
    if (ma != null && isObj(ma)) {
      for (const [platform, areas] of Object.entries(ma)) {
        checkStringListRefs(areas, `enEno.${side}.memoryArea.${platform}`, ctx.memoryAreaSet, "error", "unknown-memory-area", add);
      }
    }
  }
}

/** Validate one system-types.yaml entry (now editable from the editor).
 * Mirrors that file's own documented schema: `category` selects the shape --
 * `system-struct` carries `members` (a TypeRef list, or null meaning "not yet
 * mapped"), `system-alias` carries `basicDataType` pointing at a base type or
 * another system type. Unknown type references are warnings, consistent with
 * the instruction-entry rules. */
export function validateSystemType(name: string, entry: Record<string, unknown>, catalog: OptionCatalog): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const add = (f: ValidationFinding) => out.push(f);
  const knownTypeName = (t: string) => catalog.baseTypeNames.has(t) || catalog.systemTypeNames.has(t);

  const category = entry.category;
  if (category == null) {
    add({ severity: "error", code: "missing-required-field", fieldPath: "category", message: "Missing required field 'category'." });
  } else if (category !== "system-struct" && category !== "system-alias") {
    add({
      severity: "error",
      code: "invalid-system-type-category",
      fieldPath: "category",
      message: `Invalid category '${String(category)}'.`,
      allowed: ["system-struct", "system-alias"],
      suggestion: typeof category === "string" ? suggest(category, ["system-struct", "system-alias"]) : undefined,
    });
  }

  if (category === "system-alias") {
    const basic = entry.basicDataType;
    if (typeof basic !== "string" || !basic) {
      add({ severity: "error", code: "missing-basic-data-type", fieldPath: "basicDataType", message: "A 'system-alias' requires 'basicDataType'." });
    } else if (!knownTypeName(basic)) {
      add({
        severity: "warning",
        code: "unknown-data-type",
        fieldPath: "basicDataType",
        message: `'${basic}' is not a known base or system type.`,
        suggestion: suggest(basic, [...catalog.baseTypeNames, ...catalog.systemTypeNames]),
      });
    } else if (basic === name) {
      add({ severity: "error", code: "self-referential-alias", fieldPath: "basicDataType", message: "An alias cannot point at itself." });
    }
  }

  if (category === "system-struct" && "members" in entry && entry.members != null) {
    if (!Array.isArray(entry.members)) {
      add({ severity: "error", code: "invalid-members", fieldPath: "members", message: "'members' must be a list (or null when not yet mapped)." });
    } else {
      entry.members.forEach((m, i) => {
        const at = `members[${i}]`;
        if (!isObj(m)) {
          add({ severity: "error", code: "invalid-member", fieldPath: at, message: "Each member must be a mapping." });
          return;
        }
        if (typeof m.name !== "string" || !m.name) {
          add({ severity: "error", code: "invalid-member-name", fieldPath: `${at}.name`, message: "Member 'name' is required." });
        }
        const t = m.type;
        if (!isObj(t)) {
          add({ severity: "error", code: "invalid-member-type", fieldPath: `${at}.type`, message: "Member 'type' must be a TypeRef mapping, e.g. { kind: named, name: Bool }." });
          return;
        }
        if (t.kind === "named") {
          const tn = t.name;
          if (typeof tn !== "string" || !tn) {
            add({ severity: "error", code: "invalid-member-type", fieldPath: `${at}.type.name`, message: "A named TypeRef requires 'name'." });
          } else if (!knownTypeName(tn)) {
            add({
              severity: "warning",
              code: "unknown-data-type",
              fieldPath: `${at}.type.name`,
              message: `'${tn}' is not a known base or system type.`,
              suggestion: suggest(tn, [...catalog.baseTypeNames, ...catalog.systemTypeNames]),
            });
          }
        } else if (t.kind !== "array" && t.kind !== "inline-struct") {
          add({
            severity: "error",
            code: "invalid-member-type-kind",
            fieldPath: `${at}.type.kind`,
            message: `Invalid TypeRef kind '${String(t.kind)}'.`,
            allowed: ["named", "array", "inline-struct"],
          });
        }
      });
    }
  }

  if ("sizeBytes" in entry && entry.sizeBytes != null && typeof entry.sizeBytes !== "number") {
    add({ severity: "error", code: "invalid-size-bytes", fieldPath: "sizeBytes", message: "'sizeBytes' must be a number." });
  }
  if ("usedByInstructions" in entry && entry.usedByInstructions != null && !Array.isArray(entry.usedByInstructions)) {
    add({ severity: "error", code: "invalid-list", fieldPath: "usedByInstructions", message: "'usedByInstructions' must be a list." });
  }
  return out;
}

function validateResult(result: unknown, _entry: Record<string, unknown>, ctx: ValidationContext, add: (f: ValidationFinding) => void): void {
  if (!isObj(result)) {
    add({ severity: "error", code: "invalid-result", fieldPath: "result", message: "'result' must be a mapping." });
    return;
  }
  const kind = result.kind;
  checkEnum(kind, "result.kind", ctx.resultKindSet, "error", "invalid-result-kind", add);

  if (kind === "value") {
    if (!("dataTypes" in result)) {
      add({ severity: "error", code: "result-missing-datatypes", fieldPath: "result.dataTypes", message: "result kind 'value' requires 'dataTypes'." });
    } else {
      // Same rationale as pin dataTypes: unknown type reference -> warning.
      checkStringListRefs(result.dataTypes, "result.dataTypes", ctx.concreteTypeSet, "warning", "unknown-data-type", add);
    }
  }
  if (kind === "inferred") {
    if (typeof result.rule === "string" && !ctx.resultInferenceRuleSet.has(result.rule)) {
      add({ severity: "error", code: "unknown-inference-rule", fieldPath: "result.rule", message: `Unknown inference rule '${result.rule}'.`, allowed: [...ctx.resultInferenceRuleSet], suggestion: suggest(result.rule, ctx.resultInferenceRuleSet) });
    }
  }
  if (typeof result.transform === "string" && !ctx.resultTransformSet.has(result.transform)) {
    add({ severity: "error", code: "unknown-transform", fieldPath: "result.transform", message: `Unknown transform '${result.transform}'.`, allowed: [...ctx.resultTransformSet], suggestion: suggest(result.transform, ctx.resultTransformSet) });
  }
  if (isObj(result.usage) && Array.isArray(result.usage.allowedContexts)) {
    checkStringListRefs(result.usage.allowedContexts, "result.usage.allowedContexts", ctx.resultUsageContextSet, "warning", "unknown-usage-context", add);
  }
}
