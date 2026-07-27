export type AssistantImageLifecycle =
  | { status: "loading"; uri: string | null; aspectRatio: number | null }
  | { status: "loaded"; uri: string; aspectRatio: number }
  | { status: "failed"; message: string };

export type AssistantImageLifecycleEvent =
  | { type: "preview_created"; uri: string; aspectRatio: number | null }
  | { type: "preview_released" }
  | { type: "image_loaded"; uri: string; aspectRatio: number }
  | { type: "failed"; uri: string; message: string };

export function createAssistantImageLifecycle(): AssistantImageLifecycle {
  return { status: "loading", uri: null, aspectRatio: null };
}

export function transitionAssistantImageLifecycle(
  state: AssistantImageLifecycle,
  event: AssistantImageLifecycleEvent,
): AssistantImageLifecycle {
  if (event.type === "image_loaded") {
    if (state.status !== "loading" || state.uri !== event.uri) {
      return state;
    }
    return {
      status: "loaded",
      uri: event.uri,
      aspectRatio: event.aspectRatio,
    };
  }
  if (event.type === "failed") {
    if (state.status === "failed" || state.uri !== event.uri) {
      return state;
    }
    return { status: "failed", message: event.message };
  }
  if (event.type === "preview_created") {
    return { status: "loading", uri: event.uri, aspectRatio: event.aspectRatio };
  }
  if (event.type === "preview_released") {
    return { status: "loading", uri: null, aspectRatio: null };
  }
  return state;
}
