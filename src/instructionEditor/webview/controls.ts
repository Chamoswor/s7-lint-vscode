// Reusable form controls for the editor UI. The `Combo` is a searchable
// dropdown that covers single-select, multi-select and free-text-add in one
// component -- used everywhere a field draws from a (possibly large)
// registry-derived option list, per the brief's preference for searchable
// multiselect/tag-selectors over naive checkboxes.
import { html, useEffect, useMemo, useRef, useState } from "./h";

export interface ComboOption {
  value: string;
  description?: string;
}
export interface ComboGroup {
  group: string;
  options: ComboOption[];
}

interface ComboProps {
  multi?: boolean;
  /** string[] when multi, string|null otherwise. */
  value: string[] | string | null;
  groups: ComboGroup[];
  allowFreeText?: boolean;
  placeholder?: string;
  /** Marks a currently-selected value as invalid (unknown reference). */
  isInvalid?: (v: string) => boolean;
  onChange: (next: string[] | string | null) => void;
}

export function Combo(props: ComboProps) {
  const { multi = false, groups, allowFreeText = false, placeholder, isInvalid } = props;
  const selected: string[] = multi
    ? Array.isArray(props.value)
      ? props.value
      : []
    : props.value != null
    ? [String(props.value)]
    : [];

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  const flat = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: { group: string; options: ComboOption[] }[] = [];
    for (const g of groups) {
      const opts = g.options.filter((o) => {
        if (multi && selected.includes(o.value)) return false;
        if (!q) return true;
        return o.value.toLowerCase().includes(q) || (o.description ?? "").toLowerCase().includes(q);
      });
      if (opts.length) out.push({ group: g.group, options: opts });
    }
    return out;
  }, [groups, query, selected.join(""), multi]);

  const flatValues = useMemo(() => flat.flatMap((g) => g.options.map((o) => o.value)), [flat]);
  const canAddFree = allowFreeText && query.trim().length > 0 && !flatValues.includes(query.trim()) && !selected.includes(query.trim());

  function commit(next: string[]): void {
    if (multi) props.onChange(next);
    else props.onChange(next.length ? next[next.length - 1] : null);
  }
  function addValue(v: string): void {
    const val = v.trim();
    if (!val) return;
    if (multi) {
      if (!selected.includes(val)) commit([...selected, val]);
      setQuery("");
      setActive(0);
    } else {
      commit([val]);
      setQuery("");
      setOpen(false);
    }
  }
  function removeValue(v: string): void {
    commit(selected.filter((s) => s !== v));
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, flatValues.length - 1 + (canAddFree ? 1 : 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active < flatValues.length) addValue(flatValues[active]);
      else if (canAddFree) addValue(query);
    } else if (e.key === "Backspace" && query === "" && selected.length) {
      removeValue(selected[selected.length - 1]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  let idx = -1;
  return html`
    <div class="ms" ref=${rootRef}>
      <div class="tags" onClick=${() => { setOpen(true); rootRef.current?.querySelector("input")?.focus(); }}>
        ${selected.map(
          (v) => html`
            <span class=${"tag" + (isInvalid && isInvalid(v) ? " invalid" : "")} title=${isInvalid && isInvalid(v) ? "Unknown / unrecognized reference" : ""}>
              ${v}<span class="x" onClick=${(e: MouseEvent) => { e.stopPropagation(); removeValue(v); }}>×</span>
            </span>`
        )}
        <input
          type="text"
          placeholder=${selected.length ? "" : placeholder ?? ""}
          value=${query}
          onFocus=${() => setOpen(true)}
          onInput=${(e: any) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
          onKeyDown=${onKeyDown}
        />
      </div>
      ${open &&
      html`<div class="menu">
        ${flat.length === 0 && !canAddFree && html`<div class="grp">No matches</div>`}
        ${flat.map(
          (g) => html`
            <div>
              <div class="grp">${g.group}</div>
              ${g.options.map((o) => {
                idx += 1;
                const myIdx = idx;
                return html`<div
                  class=${"opt" + (myIdx === active ? " active" : "")}
                  onMouseEnter=${() => setActive(myIdx)}
                  onClick=${() => addValue(o.value)}
                >
                  <span class="mono">${o.value}</span>
                  ${o.description && html`<span class="desc"> — ${o.description}</span>`}
                </div>`;
              })}
            </div>`
        )}
        ${canAddFree &&
        html`<div
          class=${"opt add" + (active >= flatValues.length ? " active" : "")}
          onMouseEnter=${() => setActive(flatValues.length)}
          onClick=${() => addValue(query)}
        >Add “${query.trim()}”</div>`}
      </div>`}
    </div>
  `;
}
