import type { MermaidDiagramOptions } from "@getpaseo/plugin/client/ui";
import { parseMermaidRuntimeStyle, runtimeStyleOf } from "./options";
import { containsUnsafeMermaidSource } from "./source-policy";
import type { MarkdownPhase } from "./types";

export type DiagramColorScheme = "light" | "dark";

export interface DiagramDimensions {
  height: number;
  width: number;
}

export interface RenderedDiagram extends DiagramDimensions {
  source: string;
  colorScheme: DiagramColorScheme;
}

export interface MermaidRenderInput {
  source: string;
  phase: MarkdownPhase;
  colorScheme: DiagramColorScheme;
  styleKey?: string;
  rejected: boolean;
  cached: RenderedDiagram | null;
}

export interface MermaidRenderRequest {
  revision: number;
  source: string;
  colorScheme: DiagramColorScheme;
}

export interface MermaidRenderModel {
  revision: number;
  source: string;
  phase: MarkdownPhase;
  colorScheme: DiagramColorScheme;
  styleKey: string;
  status: "pending" | "rendered" | "failed" | "rejected";
  visible: RenderedDiagram | null;
}

export type MermaidRenderAction =
  | { type: "inputChanged"; input: MermaidRenderInput }
  | {
      type: "rendered";
      revision: number;
      source: string;
      colorScheme: DiagramColorScheme;
      dimensions: DiagramDimensions;
    }
  | { type: "renderFailed"; revision: number };

function reduceRendered(
  state: MermaidRenderModel,
  action: Extract<MermaidRenderAction, { type: "rendered" }>,
): MermaidRenderModel {
  if (action.colorScheme !== state.colorScheme) {
    return state;
  }
  if (action.revision !== state.revision || action.source !== state.source) {
    const isStreamingPrefix =
      state.phase === "streaming" &&
      action.revision < state.revision &&
      state.source.startsWith(action.source);
    const isNewerPreview =
      state.visible === null || action.source.length > state.visible.source.length;
    if (!isStreamingPrefix || !isNewerPreview) {
      return state;
    }
    return {
      ...state,
      visible: {
        source: action.source,
        colorScheme: action.colorScheme,
        ...action.dimensions,
      },
    };
  }
  return {
    ...state,
    status: "rendered",
    visible: {
      source: action.source,
      colorScheme: action.colorScheme,
      ...action.dimensions,
    },
  };
}

const renderCache = new Map<string, RenderedDiagram>();
const RENDER_CACHE_LIMIT = 50;

export function getMermaidStyleKey(options: MermaidDiagramOptions | undefined): string {
  return JSON.stringify(runtimeStyleOf(options)) ?? "";
}

function cacheKey(source: string, colorScheme: DiagramColorScheme, styleKey: string): string {
  return `${colorScheme}\u0000${styleKey}\u0000${source}`;
}

export function readCachedMermaidRender(
  source: string,
  colorScheme: DiagramColorScheme,
  styleKey: string,
): RenderedDiagram | null {
  return renderCache.get(cacheKey(source, colorScheme, styleKey)) ?? null;
}

export function cacheMermaidRender(rendered: RenderedDiagram, styleKey: string): void {
  if (renderCache.size >= RENDER_CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) {
      renderCache.delete(oldest);
    }
  }
  renderCache.set(cacheKey(rendered.source, rendered.colorScheme, styleKey), rendered);
}

/**
 * A reply is only cached while its revision is current: revisions bump whenever the style
 * changes, and a reply to an older revision was rendered with a style the model has since
 * dropped, so its dimensions would land under the wrong key.
 */
export function cacheMermaidRenderReply(
  model: MermaidRenderModel,
  rendered: RenderedDiagram,
  revision: number,
): void {
  if (revision !== model.revision) return;
  cacheMermaidRender(rendered, model.styleKey);
}

export function resolveMermaidRenderInput({
  source,
  phase,
  colorScheme,
  options,
}: {
  source: string;
  phase: MarkdownPhase;
  colorScheme: DiagramColorScheme;
  options?: MermaidDiagramOptions;
}): MermaidRenderInput {
  const styleKey = getMermaidStyleKey(options);
  return {
    source,
    phase,
    colorScheme,
    styleKey,
    // The sandbox drops a render message it cannot parse, and the host would then wait
    // forever for a reply, so a style it would reject never becomes a request.
    rejected:
      containsUnsafeMermaidSource(source) ||
      parseMermaidRuntimeStyle(runtimeStyleOf(options)) === null,
    cached: readCachedMermaidRender(source, colorScheme, styleKey),
  };
}

export function createMermaidRenderModel(input: MermaidRenderInput): MermaidRenderModel {
  const styleKey = input.styleKey ?? "";
  if (input.rejected) {
    return {
      revision: 1,
      source: input.source,
      phase: input.phase,
      colorScheme: input.colorScheme,
      styleKey,
      status: "rejected",
      visible: input.phase === "complete" ? null : input.cached,
    };
  }
  return {
    revision: 1,
    source: input.source,
    phase: input.phase,
    colorScheme: input.colorScheme,
    styleKey,
    status: "pending",
    visible: input.cached,
  };
}

export function reduceMermaidRenderModel(
  state: MermaidRenderModel,
  action: MermaidRenderAction,
): MermaidRenderModel {
  if (action.type === "rendered") {
    return reduceRendered(state, action);
  }

  if (action.type === "renderFailed") {
    if (action.revision !== state.revision) {
      return state;
    }
    return {
      ...state,
      status: "failed",
      visible: state.phase === "complete" ? null : state.visible,
    };
  }

  const { input } = action;
  const styleKey = input.styleKey ?? "";
  const isSameRender =
    input.source === state.source &&
    input.colorScheme === state.colorScheme &&
    styleKey === state.styleKey;
  if (isSameRender) {
    if (input.phase === state.phase) {
      return state;
    }
    const finalFailure = input.phase === "complete" && state.status === "failed";
    return {
      ...state,
      phase: input.phase,
      visible: finalFailure ? null : state.visible,
    };
  }

  if (input.rejected) {
    return {
      revision: state.revision + 1,
      source: input.source,
      phase: input.phase,
      colorScheme: input.colorScheme,
      styleKey,
      status: "rejected",
      visible: input.phase === "complete" ? null : (input.cached ?? state.visible),
    };
  }

  return {
    revision: state.revision + 1,
    source: input.source,
    phase: input.phase,
    colorScheme: input.colorScheme,
    styleKey,
    status: "pending",
    visible: input.cached ?? state.visible,
  };
}

export function getMermaidRenderRequest(state: MermaidRenderModel): MermaidRenderRequest | null {
  if (state.status !== "pending") {
    return null;
  }
  return {
    revision: state.revision,
    source: state.source,
    colorScheme: state.colorScheme,
  };
}
