// Editor form for one type-registry/system-types.yaml entry.
//
// The schema differs from an instruction entry (see that file's own header):
// `category` selects the shape -- `system-struct` carries a `members` list of
// TypeRefs (or null = "not yet mapped from a real TIA reference"), while
// `system-alias` carries a single `basicDataType` parent. Only the fields
// relevant to the chosen category are shown.
import { html } from "./h";
import { Combo, ComboGroup } from "./controls";
import type { SerializableCatalog, SystemTypeData } from "../messages";
import type { ValidationFinding } from "../validation";

type Path = (string | number)[];

export interface SystemTypeFormProps {
  data: SystemTypeData;
  catalog: SerializableCatalog;
  onField: (path: Path, value: unknown) => void;
  onDelete: (path: Path) => void;
  onRename: (newName: string) => void;
  onRemove: () => void;
}

function pathToStr(path: Path): string {
  let s = "";
  for (const seg of path) {
    if (typeof seg === "number") s += `[${seg}]`;
    else s += s ? `.${seg}` : seg;
  }
  return s;
}
function strv(v: unknown): string {
  return v == null ? "" : String(v);
}
function asArr(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

export function SystemTypeForm(props: SystemTypeFormProps) {
  const { data, catalog, onField, onDelete, onRename, onRemove } = props;
  const j = data.json;
  const byPath = (path: Path): ValidationFinding[] => {
    const p = pathToStr(path);
    return data.findings.filter((f) => f.fieldPath === p || f.fieldPath.startsWith(p + "["));
  };
  const msgs = (path: Path) =>
    byPath(path).map(
      (f) => html`<div class=${f.severity === "error" ? "err-msg" : "warn-msg"}>
        ${f.message}${f.suggestion ? html` <em>Did you mean “${f.suggestion}”?</em>` : ""}
      </div>`
    );
  const field = (label: string, required: boolean, messages: any, control: any) => html`<div class="field">
    <label>${label}${required ? html`<span class="req">*</span>` : ""}</label>
    ${control}${messages}
  </div>`;

  // Type options for member/alias references: base types grouped by category
  // plus system types -- reuses the catalog's own grouping.
  const typeGroups = catalog.dataTypeGroups.filter((g) => g.group !== "Wildcard" && g.group !== "Umbrella labels") as ComboGroup[];
  const isAlias = j.category === "system-alias";
  const members: any[] = Array.isArray(j.members) ? j.members : [];
  const setMembers = (next: any[]) => onField(["members"], next);

  return html`
    <div class="entry-form">
      <div class="entry-head">
        <input class="mono" style="font-size:1.15em;font-weight:600;max-width:420px" type="text"
          key=${data.name} value=${data.name}
          onChange=${(e: any) => e.target.value && e.target.value !== data.name && onRename(e.target.value)} />
        <span class="path">type-registry/system-types.yaml</span>
        <span style="margin-left:auto"><button class="ghost" onClick=${onRemove}>✕ Delete type</button></span>
      </div>

      <div class="row-2">
        ${field("Category", true, msgs(["category"]), html`
          <select value=${strv(j.category)} onChange=${(e: any) => onField(["category"], e.target.value)}>
            <option value="system-struct" selected=${j.category === "system-struct"}>system-struct</option>
            <option value="system-alias" selected=${j.category === "system-alias"}>system-alias</option>
          </select>`)}
        ${field("Size (bytes)", false, msgs(["sizeBytes"]), html`
          <input type="text" inputmode="numeric" key=${data.name} value=${strv(j.sizeBytes)}
            onChange=${(e: any) => {
              const t = e.target.value.trim();
              if (t === "") onDelete(["sizeBytes"]);
              else if (!Number.isNaN(Number(t))) onField(["sizeBytes"], Number(t));
            }} />`)}
      </div>

      ${field("Description", false, [], html`
        <input type="text" key=${data.name} value=${strv(j.description)}
          onChange=${(e: any) => onField(["description"], e.target.value)} />`)}

      ${isAlias
        ? field("Basic data type", true, msgs(["basicDataType"]), html`
            <${Combo} value=${j.basicDataType ?? null} groups=${typeGroups} allowFreeText=${true}
              placeholder="e.g. UInt (or another system type)"
              onChange=${(v: any) => onField(["basicDataType"], v)} />`)
        : MembersEditor({ members, typeGroups, msgs, setMembers, onField, onDelete })}

      ${field("Used by instructions", false, [], html`
        <${Combo} multi=${true} value=${asArr(j.usedByInstructions)} groups=${[{ group: "", options: [] }]} allowFreeText=${true}
          placeholder="e.g. TP, TON" onChange=${(v: any) => (v && (v as string[]).length ? onField(["usedByInstructions"], v) : onDelete(["usedByInstructions"]))} />`)}

      <div class="row-2">
        ${field("Confidence", false, [], html`
          <${Combo} value=${j.confidence ?? null} groups=${[{ group: "", options: catalog.confidenceLevels.map((v) => ({ value: v })) }]}
            onChange=${(v: any) => onField(["confidence"], v)} />`)}
        ${field("Source", false, [], html`
          <input type="text" key=${data.name} value=${strv(j.source)}
            onChange=${(e: any) => onField(["source"], e.target.value)} />`)}
      </div>

      ${field("Notes", false, [], html`
        <textarea key=${data.name} onChange=${(e: any) => (e.target.value ? onField(["notes"], e.target.value) : onDelete(["notes"]))}>${strv(j.notes)}</textarea>`)}

      ${data.unknownFields.length > 0 &&
      html`<div class="section"><h3>⚠ Preserved unknown fields</h3><div class="body">
        <div class="hint">Kept exactly as-is on save: <span class="mono">${data.unknownFields.join(", ")}</span></div>
      </div></div>`}
    </div>`;
}

/** `members` editor for a system-struct. `null` is this file's documented
 * "not yet mapped from a real TIA reference" state -- kept distinct from an
 * empty list, which would wrongly claim the struct has no members. */
function MembersEditor(p: {
  members: any[];
  typeGroups: ComboGroup[];
  msgs: (path: Path) => any;
  setMembers: (next: any[]) => void;
  onField: (path: Path, value: unknown) => void;
  onDelete: (path: Path) => void;
}) {
  const { members, typeGroups, msgs, setMembers, onField } = p;
  const notMapped = members.length === 0;
  const add = () => setMembers([...members, { name: "", type: { kind: "named", name: "Bool" } }]);
  const remove = (i: number) => setMembers(members.filter((_, k) => k !== i));
  const move = (i: number, d: number) => {
    const next = members.slice();
    const t = i + d;
    if (t < 0 || t >= next.length) return;
    [next[i], next[t]] = [next[t], next[i]];
    setMembers(next);
  };
  return html`<div class="section">
    <h3>Members <span class="hint">${notMapped ? "not yet mapped (null)" : `${members.length}`}</span>
      <span style="margin-left:auto"><button class="ghost" onClick=${add}>+ Add member</button></span></h3>
    <div class="body">
      ${notMapped && html`<div class="hint">
        <code>members: null</code> — this struct's field list hasn't been transcribed from a real TIA
        reference yet. Add members below (e.g. from the TIA Interface editor / instance DB view).
      </div>`}
      ${msgs(["members"])}
      ${members.map((m, i) => html`
        <div class="pin-head" style="margin:6px 0">
          <input class="mono" type="text" placeholder="member name" value=${m?.name ?? ""}
            onChange=${(e: any) => onField(["members", i, "name"], e.target.value)} />
          <div class="grow">
            <${Combo} value=${m?.type?.name ?? null} groups=${typeGroups} allowFreeText=${true}
              placeholder="type" onChange=${(v: any) => onField(["members", i, "type"], { kind: "named", name: v })} />
          </div>
          <button class="ghost" title="Move up" onClick=${() => move(i, -1)}>↑</button>
          <button class="ghost" title="Move down" onClick=${() => move(i, 1)}>↓</button>
          <button class="ghost" title="Remove member" onClick=${() => remove(i)}>✕</button>
        </div>
        ${msgs(["members", i, "type", "name"])}`)}
    </div>
  </div>`;
}
