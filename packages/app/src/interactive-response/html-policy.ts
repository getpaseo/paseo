import { parseDocument, DomUtils } from "htmlparser2";

// Scripted srcdoc frames can navigate themselves despite connect-src 'none'.
// Keep generated code inert until a runtime can enforce offline execution.
export function inertArtifactHtml(html: string): { html: string; scripted: boolean } {
  if (html.length > 100000) throw new Error("HTML artifact too large");
  const document = parseDocument(html);
  let scripted = false;
  const allowed = new Set([
    "div",
    "span",
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "ul",
    "ol",
    "li",
    "table",
    "thead",
    "tbody",
    "tr",
    "td",
    "th",
    "strong",
    "em",
    "b",
    "i",
    "br",
    "hr",
    "pre",
    "code",
    "style",
    "section",
    "article",
    "header",
    "footer",
    "main",
    "label",
    "button",
    "input",
    "select",
    "option",
    "svg",
    "path",
    "circle",
    "rect",
    "line",
    "polyline",
    "text",
    "g",
    "img",
  ]);
  function clean(nodes: typeof document.children): void {
    for (const node of nodes.slice()) {
      if (node.type === "script") {
        scripted = true;
        DomUtils.removeElement(node);
        continue;
      }
      if (node.type === "tag" || node.type === "style") {
        if (!allowed.has(node.name)) {
          if (node.name === "html" || node.name === "body" || node.name === "head") {
            clean(node.children);
            node.name = "div";
            continue;
          }
          DomUtils.removeElement(node);
          continue;
        }
        for (const name of Object.keys(node.attribs)) {
          if (
            node.name === "img" &&
            name === "src" &&
            /^data:image\/(png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+$/.test(node.attribs[name]!)
          )
            continue;
          if (name.toLowerCase().startsWith("on")) scripted = true;
          if (
            !/^(class|id|style|title|aria-label|role|type|value|placeholder|disabled|viewBox|viewbox|d|fill|stroke|stroke-width|x|y|x1|x2|y1|y2|cx|cy|r|width|height|points|alt)$/.test(
              name,
            )
          )
            delete node.attribs[name];
        }
        clean(node.children);
      } else if ("children" in node) clean(node.children);
    }
  }
  clean(document.children);
  return {
    scripted,
    html: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; connect-src 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;margin:12px;color:#333;background:#f9f7f4}*{box-sizing:border-box;max-width:100%}</style></head><body>${DomUtils.getInnerHTML(document)}</body></html>`,
  };
}
