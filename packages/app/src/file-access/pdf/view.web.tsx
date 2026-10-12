import { useCallback, useRef } from "react";
import { pdfRuntimeHtml } from "./runtime/html.gen";
import { pdfViewInput } from "./config";
import type { PdfViewProps } from "./view.types";
const style = { flex: 1, width: "100%", height: "100%", border: 0, minHeight: 0 };
export function PdfView({ uri }: PdfViewProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const load = useCallback(() => {
    void fetch(uri)
      .then((response) => response.arrayBuffer())
      .then((buffer) => {
        frame.current?.contentWindow?.postMessage(
          {
            type: "paseo-pdf-open",
            input: { ...pdfViewInput(uri), uri: undefined, data: new Uint8Array(buffer) },
          },
          "*",
          [buffer],
        );
        return null;
      });
  }, [uri]);
  return (
    <iframe
      key={uri}
      ref={frame}
      srcDoc={pdfRuntimeHtml}
      sandbox="allow-scripts allow-forms"
      title="PDF"
      style={style}
      onLoad={load}
      data-testid="pdf-reader"
    />
  );
}
