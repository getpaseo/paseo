import { useEffect, useState } from "react";
import { documentFrameSandbox } from "./sandbox";

const frameStyle = { flex: 1, minHeight: 0, border: "none", backgroundColor: "white" } as const;

interface ResolvedDocument {
  url: string;
  sandbox: string | null;
}

export function DocumentFrame({ url, testID }: { url: string; testID?: string }) {
  const [document, setDocument] = useState<ResolvedDocument | null>(null);

  useEffect(() => {
    if (!url.startsWith("blob:")) return;
    const lifetime = new AbortController();
    void fetch(url, { signal: lifetime.signal })
      .then(async (response) => {
        const sandbox = documentFrameSandbox(response.headers.get("content-type"));
        await response.body?.cancel();
        if (!lifetime.signal.aborted) setDocument({ url, sandbox });
        return undefined;
      })
      .catch(() => {
        if (!lifetime.signal.aborted) setDocument({ url, sandbox: "" });
      });
    return () => lifetime.abort();
  }, [url]);

  if (!url.startsWith("blob:") || document?.url !== url) return null;
  return (
    <iframe
      title="Document preview"
      data-testid={testID}
      src={url}
      sandbox={document.sandbox ?? undefined}
      referrerPolicy="no-referrer"
      style={frameStyle}
    />
  );
}
