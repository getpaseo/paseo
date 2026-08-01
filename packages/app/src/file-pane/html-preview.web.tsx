import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { withPreviewCsp } from "./html-preview-csp";

// `allow-scripts` alone: the file gets an opaque origin, so a plan page can run
// its own scripts (Excalidraw, charts) but cannot reach the Paseo app's DOM,
// cookies, or storage, and cannot navigate the top window. Agent-written HTML is
// not trusted markup. No popup tokens — a preview is a viewer, not a browser, and
// escaping the sandbox to open one buys nothing for reading a local plan. The same
// isolation means storage APIs throw inside the frame; pages that want to persist
// state have to export.
//
// A sandboxed frame may still navigate *itself*, and nothing in CSP stops that
// (see html-preview-csp.ts). That is the one hole left on web, it is bounded to
// the page's own contents, and it is documented in SECURITY.md rather than papered
// over with a directive browsers ignore.
const SANDBOX = "allow-scripts";

const iframeStyle = {
  flex: 1,
  minHeight: 0,
  border: "none",
  backgroundColor: "white",
} as const;

export function FileHtmlPreview({ html, testID }: { html: string; testID?: string }) {
  const { t } = useTranslation();
  const document = useMemo(() => withPreviewCsp(html), [html]);
  return (
    <iframe
      data-testid={testID}
      title={t("panels.file.editor.preview")}
      srcDoc={document}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      style={iframeStyle}
    />
  );
}
