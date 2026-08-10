import React, { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

interface MermaidDiagramProps {
  code: string;
  fallback: ReactNode;
}

// mermaid is a large dependency (d3, cytoscape, khroma…) that only DOM
// environments can render, so it's dynamic-imported and shared across every
// diagram on the page instead of pulled into the initial web bundle.
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  mermaidPromise ??= import("mermaid").then((mod) => {
    const mermaid = mod.default;
    // `strict` (the default) runs labels through DOMPurify and refuses raw
    // HTML/script in output — required since fence content is agent- or
    // repo-authored text, not something the user typed and trusted themselves.
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    return mermaid;
  });
  return mermaidPromise;
}

let renderCounter = 0;

// mermaid.render() takes an id it uses internally for SVG element ids; unique
// per call so concurrent diagrams on the same page never collide.
function nextDiagramId(): string {
  renderCounter += 1;
  return `paseo-mermaid-${renderCounter}`;
}

export function MermaidDiagram({ code, fallback }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    async function renderDiagram() {
      try {
        const mermaid = await loadMermaid();
        const { svg } = await mermaid.render(nextDiagramId(), code);
        if (cancelled) return;
        // mermaid's documented API returns a ready-to-embed SVG string; there is
        // no non-innerHTML way to mount it, mirroring how the library's own
        // usage docs recommend consuming render() output.
        if (containerRef.current) containerRef.current.innerHTML = svg;
      } catch {
        // Invalid diagram source (bad syntax, unsupported diagram type) — fall
        // back to showing the fence as code rather than an empty box.
        if (!cancelled) setFailed(true);
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) return fallback;

  return <div ref={containerRef} style={containerStyle} data-testid="mermaid-diagram" />;
}

const containerStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
};
