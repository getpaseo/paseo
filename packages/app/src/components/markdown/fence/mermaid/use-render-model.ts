import { useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import { MermaidColorsContext } from "./colors-context";
import {
  cacheMermaidRenderReply,
  createMermaidRenderModel,
  getMermaidRenderRequest,
  reduceMermaidRenderModel,
  resolveMermaidRenderInput,
  type DiagramColorScheme,
  type DiagramDimensions,
  type RenderedDiagram,
} from "./render-model";
import type { MarkdownPhase } from "./types";

export function useMermaidRenderModel({
  source,
  phase,
  colorScheme,
}: {
  source: string;
  phase: MarkdownPhase;
  colorScheme: DiagramColorScheme;
}) {
  const options = useContext(MermaidColorsContext);
  const renderInput = useMemo(
    () => resolveMermaidRenderInput({ source, phase, colorScheme, options }),
    [colorScheme, options, phase, source],
  );
  const [state, dispatch] = useReducer(
    reduceMermaidRenderModel,
    renderInput,
    createMermaidRenderModel,
  );
  // The iframe re-subscribes its message listener whenever `rendered` changes, so the
  // callback stays stable and reads the current model from here instead.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    dispatch({ type: "inputChanged", input: renderInput });
  }, [renderInput]);

  const rendered = useCallback(
    (response: {
      revision: number;
      source: string;
      colorScheme: DiagramColorScheme;
      dimensions: DiagramDimensions;
    }) => {
      const cached: RenderedDiagram = {
        source: response.source,
        colorScheme: response.colorScheme,
        ...response.dimensions,
      };
      cacheMermaidRenderReply(stateRef.current, cached, response.revision);
      dispatch({
        type: "rendered",
        revision: response.revision,
        source: response.source,
        colorScheme: response.colorScheme,
        dimensions: response.dimensions,
      });
    },
    [],
  );
  const renderFailed = useCallback((revision: number) => {
    dispatch({ type: "renderFailed", revision });
  }, []);

  return {
    state,
    request: getMermaidRenderRequest(state),
    rendered,
    renderFailed,
  };
}
