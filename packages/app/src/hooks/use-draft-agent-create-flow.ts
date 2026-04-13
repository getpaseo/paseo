import { useCallback, useMemo, useReducer } from "react";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import {
  generateMessageId,
  type StreamItem,
  type UserMessageImageAttachment,
} from "@/types/stream";

const EMPTY_STREAM_ITEMS: StreamItem[] = [];

type CreateAttempt = {
  clientMessageId: string;
  text: string;
  timestamp: Date;
  images?: UserMessageImageAttachment[];
};

type DraftAgentMachineState =
  | { tag: "draft"; errorMessage: string }
  | { tag: "creating"; attempt: CreateAttempt };

type DraftAgentMachineEvent =
  | { type: "DRAFT_SET_ERROR"; message: string }
  | { type: "SUBMIT"; attempt: CreateAttempt }
  | { type: "CREATE_FAILED"; message: string };

function assertNever(value: never): never {
  throw new Error(`Unhandled state: ${JSON.stringify(value)}`);
}

function reducer(
  state: DraftAgentMachineState,
  event: DraftAgentMachineEvent,
): DraftAgentMachineState {
  switch (event.type) {
    case "DRAFT_SET_ERROR": {
      if (state.tag !== "draft") {
        return state;
      }
      return { ...state, errorMessage: event.message };
    }
    case "SUBMIT": {
      return { tag: "creating", attempt: event.attempt };
    }
    case "CREATE_FAILED": {
      if (state.tag !== "creating") {
        return state;
      }
      return { tag: "draft", errorMessage: event.message };
    }
    default:
      return assertNever(event);
  }
}

type CreateRequestResult<TCreateResult> = {
  agentId: string | null;
  result: TCreateResult;
};

type SubmitContext = {
  text: string;
  images?: UserMessageImageAttachment[];
};

type CreateRequestContext = {
  attempt: CreateAttempt;
  text: string;
  images?: UserMessageImageAttachment[];
};

interface UseDraftAgentCreateFlowOptions<TDraftAgent, TCreateResult> {
  draftId: string;
  getPendingServerId: () => string | null;
  validateBeforeSubmit?: (ctx: SubmitContext) => string | null;
  onBeforeSubmit?: (ctx: CreateRequestContext) => void;
  onCreateStart?: () => void;
  createRequest: (ctx: CreateRequestContext) => Promise<CreateRequestResult<TCreateResult>>;
  buildDraftAgent: (attempt: CreateAttempt) => TDraftAgent;
  onCreateSuccess: (ctx: { result: TCreateResult; attempt: CreateAttempt }) => Promise<void> | void;
  onCreateError?: (error: Error) => void;
}

export function useDraftAgentCreateFlow<TDraftAgent, TCreateResult>({
  draftId,
  getPendingServerId,
  validateBeforeSubmit,
  onBeforeSubmit,
  onCreateStart,
  createRequest,
  buildDraftAgent,
  onCreateSuccess,
  onCreateError,
}: UseDraftAgentCreateFlowOptions<TDraftAgent, TCreateResult>) {
  const [machine, dispatch] = useReducer(reducer, {
    tag: "draft",
    errorMessage: "",
  } as DraftAgentMachineState);

  const setPendingCreateAttempt = useCreateFlowStore((state) => state.setPending);
  const updatePendingAgentId = useCreateFlowStore((state) => state.updateAgentId);
  const markPendingCreateLifecycle = useCreateFlowStore((state) => state.markLifecycle);
  const clearPendingCreateAttempt = useCreateFlowStore((state) => state.clear);

  const formErrorMessage = machine.tag === "draft" ? machine.errorMessage : "";
  const isSubmitting = machine.tag === "creating";

  const optimisticStreamItems = useMemo<StreamItem[]>(() => {
    if (machine.tag !== "creating") {
      return EMPTY_STREAM_ITEMS;
    }

    return [
      {
        kind: "user_message",
        id: machine.attempt.clientMessageId,
        text: machine.attempt.text,
        timestamp: machine.attempt.timestamp,
        ...(machine.attempt.images && machine.attempt.images.length > 0
          ? { images: machine.attempt.images }
          : {}),
      },
    ];
  }, [machine]);

  const draftAgent = useMemo<TDraftAgent | null>(() => {
    if (machine.tag !== "creating") {
      return null;
    }
    return buildDraftAgent(machine.attempt);
  }, [buildDraftAgent, machine]);

  const handleCreateFromInput = useCallback(
    async ({ text, images }: SubmitContext) => {
      if (isSubmitting) {
        throw new Error("Already loading");
      }

      dispatch({ type: "DRAFT_SET_ERROR", message: "" });

      const trimmedPrompt = text.trim();
      if (!trimmedPrompt) {
        const error = new Error("Initial prompt is required");
        dispatch({ type: "DRAFT_SET_ERROR", message: error.message });
        throw error;
      }

      const validationError = validateBeforeSubmit?.({ text: trimmedPrompt, images });
      if (validationError) {
        const error = new Error(validationError);
        dispatch({ type: "DRAFT_SET_ERROR", message: validationError });
        throw error;
      }

      const pendingServerId = getPendingServerId();
      if (!pendingServerId) {
        const error = new Error("No host selected");
        dispatch({ type: "DRAFT_SET_ERROR", message: error.message });
        throw error;
      }

      const attempt: CreateAttempt = {
        clientMessageId: generateMessageId(),
        text: trimmedPrompt,
        timestamp: new Date(),
        ...(images && images.length > 0 ? { images } : {}),
      };

      setPendingCreateAttempt({
        draftId,
        serverId: pendingServerId,
        agentId: null,
        clientMessageId: attempt.clientMessageId,
        text: attempt.text,
        timestamp: attempt.timestamp.getTime(),
        ...(attempt.images && attempt.images.length > 0 ? { images: attempt.images } : {}),
      });

      onBeforeSubmit?.({ attempt, text: trimmedPrompt, images });
      dispatch({ type: "SUBMIT", attempt });
      onCreateStart?.();

      try {
        const createResult = await createRequest({
          attempt,
          text: trimmedPrompt,
          images,
        });

        if (createResult.agentId) {
          updatePendingAgentId({ draftId, agentId: createResult.agentId });
        }

        await onCreateSuccess({ result: createResult.result, attempt });
      } catch (error) {
        const resolved = error instanceof Error ? error : new Error("Failed to create agent");
        dispatch({ type: "CREATE_FAILED", message: resolved.message });
        markPendingCreateLifecycle({ draftId, lifecycle: "abandoned" });
        clearPendingCreateAttempt({ draftId });
        onCreateError?.(resolved);
        throw error;
      }
    },
    [
      clearPendingCreateAttempt,
      createRequest,
      draftId,
      getPendingServerId,
      isSubmitting,
      markPendingCreateLifecycle,
      onBeforeSubmit,
      onCreateError,
      onCreateStart,
      onCreateSuccess,
      setPendingCreateAttempt,
      updatePendingAgentId,
      validateBeforeSubmit,
    ],
  );

  return {
    machine,
    formErrorMessage,
    isSubmitting,
    optimisticStreamItems,
    draftAgent,
    handleCreateFromInput,
  };
}

export type { CreateAttempt as DraftCreateAttempt };
