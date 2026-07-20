// Schema-level enumerations that are NOT stored in any external registry file
// and therefore legitimately live in code (they are already TypeScript union
// types in src/rules/types.ts -- this is the same information, surfaced as
// selectable option lists for the editor UI).
//
// The rule from the task brief is "don't hardcode values that already exist in
// the registry files". These enums (callShape/dir/required/confidence/template
// shape/family) are part of the entry SCHEMA, not registry DATA -- there is no
// memory.yaml/base-types.yaml entry to read them from. `resultKind`, by
// contrast, DOES live in system-registry/result.yaml, so it is derived from
// there (see externalRegistries.ts) rather than being duplicated here.
import { CallShape, Confidence, PinDir, TemplateShape } from "../rules/types";

export const CALL_SHAPES: CallShape[] = ["box", "instance-dot", "coil-ref"];
export const PIN_DIRS: PinDir[] = ["in", "out", "inout"];
export const CONFIDENCE_LEVELS: Confidence[] = ["confirmed-compiled", "official-doc", "shape-only"];
export const TEMPLATE_SHAPES: TemplateShape[] = ["none", "single", "eno-pair", "bracketed"];

/** The `family` values documented in _template.yaml / README.md. Used as the
 * seed set; the live catalog additionally unions any family actually observed
 * in the loaded files (so a newly-introduced family is offered even before its
 * documentation catches up). */
export const KNOWN_FAMILIES: string[] = [
  "bit-logic",
  "comparator",
  "counter",
  "timer",
  "math",
  "move",
  "word-logic",
  "shift-rotate",
  "program-control",
  "runtime-control",
  "conversion",
  "technology",
  "extended",
  "communication",
];

/** The keys required on every entry (per _template.yaml / types.ts). Missing
 * any of these is a hard validation error. `pins` may legitimately be empty
 * but the key itself is expected. */
export const REQUIRED_ENTRY_FIELDS = ["family", "callShape", "pins", "template", "confidence"] as const;

/** Every field name the editor's schema understands at the entry level. Any
 * other top-level key on an entry is an UNKNOWN field: preserved verbatim on
 * save, but surfaced as a warning so typos are caught. */
export const KNOWN_ENTRY_FIELDS = new Set<string>([
  "family",
  "callShape",
  "instanceType",
  "pins",
  "enEno",
  "result",
  "template",
  "confidence",
  "notes",
  "source",
  "language",
]);

/** Known pin-level field names (same preserve-but-warn rule for others). */
export const KNOWN_PIN_FIELDS = new Set<string>([
  "name",
  "dir",
  "required",
  "dataTypes",
  "containerKinds",
  "memoryAreas",
  "allowedDeclarations",
  "note",
]);
