// The instruction editor form: renders an EntryData as a structured, schema-
// driven form. Only relevant fields are shown (e.g. instanceType only for
// instance call shapes; result sub-fields depend on the chosen kind), each
// field uses the right control, options come from the registry-derived
// catalog, required fields are marked, and validation findings render inline.
import { html } from "./h";
import { Combo, ComboGroup } from "./controls";
import type { EntryData, SerializableCatalog } from "../messages";
import type { ValidationFinding } from "../validation";

type Path = (string | number)[];

export interface FormProps {
  entry: EntryData;
  catalog: SerializableCatalog;
  onField: (path: Path, value: unknown) => void;
  onDelete: (path: Path) => void;
  onRename: (newName: string) => void;
  /** Quick-fix for an instanceType that isn't catalogued yet: create it in
   * system-types.yaml, seeded from this instruction's pins. */
  onAddSystemType: (typeName: string) => void;
}

function pathToStr(path: Path): string {
  let s = "";
  for (const seg of path) {
    if (typeof seg === "number") s += `[${seg}]`;
    else s += s ? `.${seg}` : seg;
  }
  return s;
}
function getIn(obj: any, path: Path): any {
  let cur = obj;
  for (const k of path) {
    if (cur == null) return undefined;
    cur = cur[k as any];
  }
  return cur;
}
function toOptions(values: string[]): ComboGroup[] {
  return [{ group: "", options: values.map((v) => ({ value: v })) }];
}

export function EntryForm(props: FormProps) {
  const { entry, catalog, onField, onDelete, onRename, onAddSystemType } = props;
  const j = entry.json;
  const byPath = (path: Path): ValidationFinding[] => {
    const p = pathToStr(path);
    return entry.findings.filter((f) => f.fieldPath === p || f.fieldPath.startsWith(p + "["));
  };
  const msgs = (path: Path) =>
    byPath(path).map(
      (f) => html`<div class=${f.severity === "error" ? "err-msg" : "warn-msg"}>
        ${f.message}${f.suggestion ? html` <em>Did you mean “${f.suggestion}”?</em>` : ""}
      </div>`
    );

  const callShape = j.callShape;
  const wantsInstance = callShape === "instance-dot" || callShape === "coil-ref";

  return html`
    <div class="entry-form">
      <div class="entry-head">
        <input
          class="mono"
          style="font-size:1.15em;font-weight:600;max-width:420px"
          type="text"
          key=${entry.uid}
          value=${entry.name}
          onChange=${(e: any) => e.target.value && e.target.value !== entry.name && onRename(e.target.value)}
        />
        <span class="path">${entry.filePath}</span>
      </div>

      <div class="row-2">
        ${field("Family", true, msgs(["family"]), html`
          <${Combo} value=${j.family ?? null} groups=${toOptions(catalog.families)} allowFreeText=${true}
            placeholder="family" onChange=${(v: any) => onField(["family"], v)} />`)}
        ${field("Call shape", true, msgs(["callShape"]), html`
          <${Combo} value=${j.callShape ?? null} groups=${toOptions(catalog.callShapes)}
            placeholder="callShape" onChange=${(v: any) => onField(["callShape"], v)} />`)}
      </div>

      <div class="row-2">
        ${field("Confidence", true, msgs(["confidence"]), html`
          <${Combo} value=${j.confidence ?? null} groups=${toOptions(catalog.confidenceLevels)}
            placeholder="confidence" onChange=${(v: any) => onField(["confidence"], v)} />`)}
        ${wantsInstance
          ? field(
              "Instance type",
              false,
              html`${msgs(["instanceType"])}
                ${byPath(["instanceType"]).some((f) => f.code === "unknown-instance-type") && typeof j.instanceType === "string" &&
                html`<button class="ghost" style="margin-top:4px"
                  title="Create this type in type-registry/system-types.yaml, with members seeded from this instruction's pins"
                  onClick=${() => onAddSystemType(j.instanceType as string)}>
                  ＋ Add “${j.instanceType}” to system-types
                </button>`}`,
              html`
            <${Combo} value=${j.instanceType ?? null} groups=${toOptions(catalog.systemTypeNames)} allowFreeText=${true}
              isInvalid=${(v: string) => !catalog.systemTypeNames.includes(v)}
              placeholder="e.g. IEC_TIMER" onChange=${(v: any) => onField(["instanceType"], v)} />`
            )
          : html`<div></div>`}
      </div>

      <div class="row-2">
        ${field("Language", false, [], html`
          <${Combo} multi=${true} value=${asArr(j.language)} groups=${toOptions(catalog.languages)} allowFreeText=${true}
            placeholder="omit unless single-language confirmed" onChange=${(v: any) => setOrDelete(onField, onDelete, ["language"], v)} />`)}
        ${field("Source", false, [], html`
          <input type="text" key=${entry.uid} value=${strv(j.source)}
            onChange=${(e: any) => setOrDelete(onField, onDelete, ["source"], e.target.value)} />`)}
      </div>

      ${field("Notes", false, [], html`
        <textarea key=${entry.uid} onChange=${(e: any) => setOrDelete(onField, onDelete, ["notes"], e.target.value)}>${strv(j.notes)}</textarea>`)}

      ${PinsSection(props, byPath, msgs)}
      ${TemplateSection(props, msgs)}
      ${ResultSection(props, msgs)}

      ${entry.unknownFields.length > 0 &&
      html`<div class="section"><h3>⚠ Preserved unknown fields</h3><div class="body">
        <div class="hint">These fields aren't understood by the editor but are kept exactly as-is on save: <span class="mono">${entry.unknownFields.join(", ")}</span></div>
      </div></div>`}
    </div>
  `;
}

function field(label: string, required: boolean, messages: any, control: any) {
  return html`<div class="field">
    <label>${label}${required ? html`<span class="req" title="required">*</span>` : ""}</label>
    ${control}
    ${messages}
  </div>`;
}

function PinsSection(props: FormProps, byPath: (p: Path) => ValidationFinding[], msgs: (p: Path) => any) {
  const { entry, catalog, onField } = props;
  const pins: any[] = Array.isArray(entry.json.pins) ? entry.json.pins : [];
  const dtGroups = catalog.dataTypeGroups as ComboGroup[];
  const validDt = new Set(dtGroups.flatMap((g) => g.options.map((o) => o.value)));

  const setPins = (next: any[]) => onField(["pins"], next);
  const addPin = () => setPins([...pins, { name: "", dir: "in", required: true }]);
  const removePin = (i: number) => setPins(pins.filter((_, k) => k !== i));
  const movePin = (i: number, d: number) => {
    const next = pins.slice();
    const t = i + d;
    if (t < 0 || t >= next.length) return;
    [next[i], next[t]] = [next[t], next[i]];
    setPins(next);
  };

  return html`<div class="section"><h3>Pins <span class="hint">${pins.length}</span>
      <span style="margin-left:auto"><button class="ghost" onClick=${addPin}>+ Add pin</button></span></h3>
    <div class="body">
      ${pins.length === 0 && html`<div class="hint">No pins.</div>`}
      ${pins.map((pin, i) => html`
        <div class="pin">
          <div class="pin-head">
            <label class="inline" for=${`pin-name-${i}`}>Name</label>
            <input class="mono grow" id=${`pin-name-${i}`} type="text" placeholder="blank = positional"
              title="Pin name as Siemens documents it. Leave blank for an unnamed (positional) parameter."
              value=${strv(pin.name)}
              onChange=${(e: any) => onField(["pins", i, "name"], e.target.value === "" ? null : e.target.value)} />
            <label class="inline" for=${`pin-dir-${i}`}>Dir</label>
            <select id=${`pin-dir-${i}`} value=${pin.dir ?? "in"} onChange=${(e: any) => onField(["pins", i, "dir"], e.target.value)}>
              ${catalog.pinDirs.map((d) => html`<option value=${d} selected=${pin.dir === d}>${d}</option>`)}
            </select>
            <label style="font-weight:normal"><input type="checkbox" checked=${pin.required === true}
              onChange=${(e: any) => onField(["pins", i, "required"], e.target.checked)} /> required</label>
            <button class="ghost" title="Move up" onClick=${() => movePin(i, -1)}>↑</button>
            <button class="ghost" title="Move down" onClick=${() => movePin(i, 1)}>↓</button>
            <button class="ghost" title="Remove pin" onClick=${() => removePin(i)}>✕</button>
          </div>
          ${msgs(["pins", i, "dir"])}
          <div class="row-2">
            ${field("Data types", false, msgs(["pins", i, "dataTypes"]), html`
              <${Combo} multi=${true} value=${asArr(pin.dataTypes)} groups=${dtGroups} allowFreeText=${true}
                isInvalid=${(v: string) => !validDt.has(v)}
                placeholder="search types / labels" onChange=${(v: any) => onField(["pins", i, "dataTypes"], v)} />`)}
            ${field("Memory areas", false, msgs(["pins", i, "memoryAreas"]), html`
              <${Combo} multi=${true} value=${asArr(pin.memoryAreas)} groups=${[{ group: "", options: catalog.memoryAreas }]}
                placeholder="I, Q, M, …" onChange=${(v: any) => onField(["pins", i, "memoryAreas"], v)} />`)}
          </div>
          <div class="row-2">
            ${field("Allowed declarations", false, msgs(["pins", i, "allowedDeclarations"]), html`
              <${Combo} multi=${true} value=${asArr(pin.allowedDeclarations)} groups=${[{ group: "", options: catalog.declarationSections }]}
                placeholder="Input, InOut, …" onChange=${(v: any) => onField(["pins", i, "allowedDeclarations"], v)} />`)}
            ${field("Note", false, [], html`
              <input type="text" value=${strv(pin.note)} onChange=${(e: any) => onField(["pins", i, "note"], e.target.value)} />`)}
          </div>
        </div>`)}
    </div></div>`;
}

function TemplateSection(props: FormProps, msgs: (p: Path) => any) {
  const { entry, catalog, onField } = props;
  const tpl: any = entry.json.template ?? {};
  const extra: Record<string, string> = tpl.extra && typeof tpl.extra === "object" ? tpl.extra : {};
  const extraRows = Object.entries(extra);
  const setExtra = (obj: Record<string, string>) => onField(["template", "extra"], obj);
  return html`<div class="section"><h3>Template</h3><div class="body">
    <div class="row-2">
      ${field("Shape", true, msgs(["template", "shape"]), html`
        <select value=${tpl.shape ?? "none"} onChange=${(e: any) => onField(["template", "shape"], e.target.value)}>
          ${catalog.templateShapes.map((s) => html`<option value=${s} selected=${tpl.shape === s}>${s}</option>`)}
        </select>`)}
      ${field("Keys", false, msgs(["template", "keys"]), html`
        <${Combo} multi=${true} value=${asArr(tpl.keys)} groups=${[{ group: "", options: [] }]} allowFreeText=${true}
          placeholder="e.g. SrcType, DestType" onChange=${(v: any) => onField(["template", "keys"], v)} />`)}
    </div>
    <div class="field"><label>Extra pragmas <span class="hint">key := value</span></label>
      ${extraRows.map(
        ([k, v], i) => html`<div class="pin-head" style="margin:4px 0">
          <input class="mono" type="text" value=${k} onChange=${(e: any) => {
            const next: Record<string, string> = {};
            extraRows.forEach(([kk, vv], ii) => { next[ii === i ? e.target.value : kk] = vv; });
            setExtra(next);
          }} />
          <input class="mono grow" type="text" value=${v} onChange=${(e: any) => setExtra({ ...extra, [k]: e.target.value })} />
          <button class="ghost" onClick=${() => { const n = { ...extra }; delete n[k]; setExtra(n); }}>✕</button>
        </div>`
      )}
      <button class="ghost" onClick=${() => setExtra({ ...extra, ["S7_Key" + (extraRows.length + 1)]: "" })}>+ Add pragma</button>
    </div>
  </div></div>`;
}

function ResultSection(props: FormProps, msgs: (p: Path) => any) {
  const { entry, catalog, onField, onDelete } = props;
  const has = entry.json.result != null;
  const res: any = entry.json.result ?? {};
  const kind = res.kind;
  return html`<div class="section"><h3>Result
      <span style="margin-left:auto">${has
        ? html`<button class="ghost" onClick=${() => onDelete(["result"])}>Remove (→ kind: none)</button>`
        : html`<button class="ghost" onClick=${() => onField(["result"], { kind: "none" })}>+ Add result</button>`}</span></h3>
    ${has &&
    html`<div class="body">
      ${field("Kind", true, msgs(["result", "kind"]), html`
        <select value=${kind ?? "none"} onChange=${(e: any) => onField(["result", "kind"], e.target.value)}>
          ${catalog.resultKinds.map((k) => html`<option value=${k.value} selected=${kind === k.value}>${k.value}</option>`)}
        </select>`)}
      ${kind === "value" &&
      field("Data types", true, msgs(["result", "dataTypes"]), html`
        <${Combo} multi=${true} value=${asArr(res.dataTypes)} groups=${catalog.dataTypeGroups as ComboGroup[]} allowFreeText=${true}
          onChange=${(v: any) => onField(["result", "dataTypes"], v)} />`)}
      ${kind === "inferred" &&
      field("Rule", false, msgs(["result", "rule"]), html`
        <${Combo} value=${res.rule ?? null} groups=${[{ group: "", options: catalog.resultInferenceRules }]}
          onChange=${(v: any) => onField(["result", "rule"], v)} />`)}
    </div>`}
  </div>`;
}

// --- small helpers ------------------------------------------------------
function strv(v: unknown): string {
  return v == null ? "" : String(v);
}
function asArr(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}
/** Set a value, or delete the field when the value is empty -- keeps optional
 * fields absent rather than writing empty strings/arrays that would dirty the
 * file needlessly. */
function setOrDelete(onField: FormProps["onField"], onDelete: FormProps["onDelete"], path: Path, value: unknown): void {
  const empty = value == null || value === "" || (Array.isArray(value) && value.length === 0);
  if (empty) onDelete(path);
  else onField(path, value);
}
