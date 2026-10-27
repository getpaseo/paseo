import createDOMPurify from "dompurify";
import morphdom from "morphdom";
import {
  artifactAllowedTags,
  artifactAllowedAttributes,
  isArtifactImageSource,
} from "../html-policy";

// Runs only in the trusted iframe/WebView shell, using its own HTML parser.
const purifier = createDOMPurify(window);
purifier.addHook("uponSanitizeAttribute", (node, attribute) => {
  if (
    attribute.attrName === "src" &&
    (node.nodeName !== "IMG" || !isArtifactImageSource(attribute.attrValue))
  )
    attribute.keepAttr = false;
});

export function renderArtifact(root: HTMLElement, markup: string): void {
  if (!purifier.isSupported) throw new Error("DOM sanitization unavailable");
  if (markup.length > 100000) throw new Error("HTML artifact too large");
  const fragment = purifier.sanitize(markup, {
    ALLOWED_TAGS: artifactAllowedTags,
    ALLOWED_ATTR: [...artifactAllowedAttributes, "src"],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    FORCE_BODY: true,
    RETURN_DOM_FRAGMENT: true,
  });
  const target = document.createElement("div");
  target.append(fragment);
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && root.contains(active) ? active.id : "";
  const textInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  const start = textInput ? active.selectionStart : null;
  const end = textInput ? active.selectionEnd : null;
  // Pass sanitized nodes, never a string: reparsing could change HTML/SVG context.
  morphdom(root, target, { childrenOnly: true });
  const replacement = focused ? document.getElementById(focused) : null;
  if (replacement instanceof HTMLElement && root.contains(replacement)) {
    replacement.focus({ preventScroll: true });
    if (
      start !== null &&
      end !== null &&
      (replacement instanceof HTMLInputElement || replacement instanceof HTMLTextAreaElement)
    )
      replacement.setSelectionRange(start, end);
  }
}
