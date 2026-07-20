// Shared Preact + htm binding for the webview UI. Importing `html` from here
// (rather than re-binding htm in every module) keeps one hyperscript factory.
import { h } from "preact";
import htm from "htm";

export const html = htm.bind(h);
export { h };
export * from "preact/hooks";
