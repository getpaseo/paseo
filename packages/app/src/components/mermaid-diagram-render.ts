import mermaid from "mermaid";

export interface MermaidDiagramPalette {
  background: string;
  border: string;
  foreground: string;
  mutedForeground: string;
  primary: string;
  primaryForeground: string;
  surface: string;
}

export interface MermaidRenderResult {
  height: number;
  width: number;
}

let renderQueue = Promise.resolve();

function viewBoxSize(svg: SVGSVGElement): MermaidRenderResult {
  const viewBox = svg.viewBox.baseVal;
  if (viewBox.width > 0 && viewBox.height > 0) {
    return { width: viewBox.width, height: viewBox.height };
  }

  const bounds = svg.getBBox();
  return { width: Math.max(bounds.width, 1), height: Math.max(bounds.height, 1) };
}

async function renderIntoHost(
  id: string,
  code: string,
  palette: MermaidDiagramPalette,
  host: HTMLElement,
): Promise<MermaidRenderResult> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    maxTextSize: 20_000,
    maxEdges: 300,
    htmlLabels: false,
    theme: "base",
    themeVariables: {
      background: palette.background,
      primaryColor: palette.surface,
      primaryBorderColor: palette.border,
      primaryTextColor: palette.foreground,
      secondaryColor: palette.background,
      secondaryBorderColor: palette.border,
      secondaryTextColor: palette.foreground,
      tertiaryColor: palette.background,
      tertiaryBorderColor: palette.border,
      tertiaryTextColor: palette.foreground,
      lineColor: palette.mutedForeground,
      textColor: palette.foreground,
      mainBkg: palette.surface,
      nodeBorder: palette.border,
      clusterBkg: palette.background,
      clusterBorder: palette.border,
      edgeLabelBackground: palette.background,
      actorBkg: palette.surface,
      actorBorder: palette.border,
      actorTextColor: palette.foreground,
      signalColor: palette.foreground,
      signalTextColor: palette.foreground,
      labelBoxBkgColor: palette.background,
      labelBoxBorderColor: palette.border,
      labelTextColor: palette.foreground,
      noteBkgColor: palette.surface,
      noteBorderColor: palette.primary,
      noteTextColor: palette.foreground,
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    },
  });

  const { svg: markup } = await mermaid.render(id, code);
  host.innerHTML = markup;
  const svg = host.querySelector("svg");
  if (!svg) {
    throw new Error("Mermaid returned no SVG");
  }

  const size = viewBoxSize(svg);
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.display = "block";
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.maxWidth = "none";
  svg.setAttribute("focusable", "false");
  return size;
}

export function renderMermaidDiagram(
  id: string,
  code: string,
  palette: MermaidDiagramPalette,
  host: HTMLElement,
): Promise<MermaidRenderResult> {
  const render = () => renderIntoHost(id, code, palette, host);
  const result = renderQueue.then(render, render);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
