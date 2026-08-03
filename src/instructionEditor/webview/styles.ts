// Webview stylesheet, injected into a <style> at startup. Uses VS Code theme
// variables throughout so the editor matches the user's active theme (light or
// dark) with no per-theme code.
export const STYLES = `
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
#root { height: 100vh; }

.app { display: grid; grid-template-columns: 300px 1fr; grid-template-rows: auto auto 1fr auto; height: 100vh; }
.toolbar { grid-column: 1 / 3; grid-row: 1 / 2; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
.banner { grid-column: 1 / 3; grid-row: 2 / 3; display: flex; align-items: center; gap: 10px; padding: 5px 10px; background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-editorWarning-foreground); border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border)); }
.toolbar .spacer { flex: 1; }
.toolbar .title { font-weight: 600; }
.toolbar .stat { opacity: 0.8; font-size: 0.9em; }
.toolbar .stat.err { color: var(--vscode-errorForeground); opacity: 1; }
.toolbar .stat.dirty { color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow)); }

button {
  font-family: inherit; font-size: inherit;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border: 1px solid transparent; border-radius: 3px; padding: 3px 10px; cursor: pointer;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.45; cursor: default; }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.ghost { background: transparent; color: var(--vscode-foreground); border-color: var(--vscode-panel-border); }
button.ghost:hover { background: var(--vscode-toolbar-hoverBackground); }

.nav { grid-row: 3 / 4; overflow: auto; border-right: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
.nav .search { position: sticky; top: 0; padding: 6px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); }
.nav .search input { width: 100%; }
.tree { padding: 4px 0; }
.row { display: flex; align-items: center; gap: 4px; padding: 2px 6px; cursor: pointer; white-space: nowrap; user-select: none; }
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.row.multiselected { background: var(--vscode-list-inactiveSelectionBackground); }
.row[draggable=true] { cursor: grab; }
.row.dragging { opacity: 0.4; }
.row.drop-before { box-shadow: inset 0 2px 0 0 var(--vscode-focusBorder); }
.row.drop-after { box-shadow: inset 0 -2px 0 0 var(--vscode-focusBorder); }
.row.drop-into { background: var(--vscode-list-dropBackground, var(--vscode-list-hoverBackground)); outline: 1px dashed var(--vscode-focusBorder); outline-offset: -1px; }
.row .twist { width: 14px; text-align: center; opacity: 0.7; }
.row .icon { opacity: 0.85; }
.row .label { overflow: hidden; text-overflow: ellipsis; }
.row .badge { margin-left: auto; font-size: 0.82em; padding: 0 5px; border-radius: 8px; }
.badge.err { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
.badge.warn { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-editorWarning-foreground); }
.badge.dot { color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow)); background: transparent; }
.lang-tag { font-size: 0.75em; opacity: 0.6; margin-left: 4px; }
.row .actions { display: none; margin-left: auto; gap: 2px; }
.row:hover .actions { display: inline-flex; }
.row .actions button { padding: 0 5px; font-size: 0.85em; line-height: 1.4; background: transparent; color: var(--vscode-foreground); border: 1px solid transparent; }
.row .actions button:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-panel-border); }
.row.selected .actions button { color: var(--vscode-list-activeSelectionForeground); }
.nav .navbar { display: flex; gap: 4px; padding: 4px 6px; }
.nav .navbar button { flex: 1; font-size: 0.85em; }

.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 200; }
.dialog { background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; padding: 16px; min-width: 340px; max-width: 90vw; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
.dialog h3 { margin: 0 0 10px; }
.dialog label { display: block; margin-bottom: 4px; font-size: 0.9em; opacity: 0.85; }
.dialog .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.dialog .err { color: var(--vscode-errorForeground); font-size: 0.85em; margin-top: 6px; min-height: 1em; }

.editor { grid-row: 3 / 4; overflow: auto; padding: 14px 18px; }
.editor .empty { opacity: 0.6; margin-top: 40px; text-align: center; }
.entry-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
.entry-head .path { opacity: 0.6; font-size: 0.85em; }
.field { margin: 10px 0; }
.field > label { display: block; font-weight: 600; margin-bottom: 3px; }
.field .req { color: var(--vscode-errorForeground); margin-left: 3px; }
.field .hint { font-weight: normal; opacity: 0.6; font-size: 0.85em; margin-left: 6px; }
.field .err-msg { color: var(--vscode-errorForeground); font-size: 0.85em; margin-top: 2px; }
.field .warn-msg { color: var(--vscode-editorWarning-foreground); font-size: 0.85em; margin-top: 2px; }

input[type=text], input[type=search], textarea, select {
  font-family: inherit; font-size: inherit;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 3px; padding: 3px 6px; width: 100%;
}
input.invalid, select.invalid { border-color: var(--vscode-inputValidation-errorBorder); }
textarea { resize: vertical; min-height: 48px; }
select { cursor: pointer; }

.row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.section { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin: 12px 0; }
.section > h3 { margin: 0; padding: 6px 10px; background: var(--vscode-sideBarSectionHeader-background); font-size: 0.95em; display: flex; align-items: center; gap: 8px; }
.section > .body { padding: 10px; }

.pin { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; margin: 8px 0; }
/* NOT scoped to '.pin' -- the same header row is reused outside a pin, by the
   Template "Extra pragmas" rows and the system-type member rows. While this
   was '.pin .pin-head', both of those lost their flex layout entirely and
   stacked their controls vertically at full width. */
.pin-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
/* The generic control rule above sets 'width: 100%', which as a flex BASE
   makes every control in this row demand the row's entire width. The row then
   has no positive free space left, so '.grow's flex-grow distributes nothing
   and the field it is on -- the pin NAME -- collapses to its minimum while the
   rest of the row overflows. Inside these header rows a control sizes from
   flex instead. */
.pin-head input[type=text], .pin-head select { width: auto; }
.pin-head .grow { flex: 1 1 0; min-width: 0; }
/* A short inline caption for a control that lives in a header row rather than
   in a '.field' block, so it reads as a labelled, editable field instead of a
   bare box ('display: block' on '.field > label' would break the row). */
.pin-head > label.inline { font-weight: 600; white-space: nowrap; flex: none; }

/* Searchable multiselect / tag control */
.ms { position: relative; }
.ms .tags { display: flex; flex-wrap: wrap; gap: 4px; padding: 3px; min-height: 26px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; background: var(--vscode-input-background); cursor: text; }
.ms .tag { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.9em; }
.ms .tag.invalid { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
.ms .tag .x { cursor: pointer; opacity: 0.7; }
.ms .tag .x:hover { opacity: 1; }
.ms input { border: none; background: transparent; flex: 1; min-width: 60px; padding: 2px; }
.ms .menu { position: absolute; z-index: 20; left: 0; right: 0; max-height: 240px; overflow: auto; background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 3px; margin-top: 2px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
.ms .menu .grp { padding: 3px 8px; opacity: 0.6; font-size: 0.8em; text-transform: uppercase; }
.ms .menu .opt { padding: 3px 10px; cursor: pointer; }
.ms .menu .opt:hover, .ms .menu .opt.active { background: var(--vscode-list-hoverBackground); }
.ms .menu .opt .desc { opacity: 0.6; font-size: 0.85em; }
.ms .menu .add { color: var(--vscode-textLink-foreground); }

/* Validation panel */
.problems { grid-column: 1 / 3; grid-row: 4 / 5; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-panel-background); max-height: 30vh; display: flex; flex-direction: column; }
.problems .head { display: flex; align-items: center; gap: 10px; padding: 4px 10px; cursor: pointer; user-select: none; }
.problems .list { overflow: auto; }
.problems .item { display: flex; gap: 8px; padding: 3px 10px; border-top: 1px solid var(--vscode-panel-border); cursor: pointer; }
.problems .item:hover { background: var(--vscode-list-hoverBackground); }
.problems .item .sev { width: 14px; text-align: center; }
.problems .item .sev.error { color: var(--vscode-errorForeground); }
.problems .item .sev.warning { color: var(--vscode-editorWarning-foreground); }
.problems .item .loc { opacity: 0.7; }
.problems .item .msg { flex: 1; }

.toast { position: fixed; bottom: 16px; right: 16px; padding: 8px 14px; border-radius: 4px; z-index: 100; box-shadow: 0 2px 10px rgba(0,0,0,0.4); }
.toast.info { background: var(--vscode-notifications-background); color: var(--vscode-notifications-foreground); border: 1px solid var(--vscode-notificationCenter-border, var(--vscode-panel-border)); }
.toast.warn { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-editorWarning-foreground); }
.toast.error { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
.mono { font-family: var(--vscode-editor-font-family, monospace); }
`;
