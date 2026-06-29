import { createElement, type CSSProperties } from "react";

const IFRAME_STYLE: CSSProperties = {
  border: "none",
  width: "100%",
  height: "100%",
  backgroundColor: "#ffffff",
};

/**
 * Renders HTML file content live in a sandboxed iframe.
 *
 * Security: `sandbox="allow-scripts"` WITHOUT `allow-same-origin` gives the
 * frame a unique opaque origin — scripts can run for the preview, but they
 * cannot reach the parent app, its DOM, cookies, or storage. This mirrors the
 * sandboxed-iframe pattern used across the ecosystem for agent-generated HTML.
 *
 * `createElement` is used (as in browser-pane.electron.tsx) so the DOM element
 * typechecks cleanly inside this React Native + react-native-web project.
 */
export function HtmlFilePreview({ content }: { content: string }) {
  return createElement("iframe", {
    title: "HTML preview",
    srcDoc: content,
    sandbox: "allow-scripts",
    style: IFRAME_STYLE,
  });
}
