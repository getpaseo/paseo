import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentMetadata } from "@/attachments/types";
import { useDraftStore } from "@/stores/draft-store";

type ImageUpdater = AttachmentMetadata[] | ((prev: AttachmentMetadata[]) => AttachmentMetadata[]);

interface AgentInputDraft {
  text: string;
  setText: (text: string) => void;
  images: AttachmentMetadata[];
  setImages: (updater: ImageUpdater) => void;
  clear: (lifecycle: "sent" | "abandoned") => void;
  isHydrated: boolean;
}

function hasDraftContent(input: { text: string; images: AttachmentMetadata[] }): boolean {
  return input.text.trim().length > 0 || input.images.length > 0;
}

function areImagesEqual(input: {
  left: AttachmentMetadata[];
  right: AttachmentMetadata[];
}): boolean {
  if (input.left.length !== input.right.length) {
    return false;
  }

  return input.left.every((image, index) => {
    const other = input.right[index];
    return (
      image.id === other?.id &&
      image.mimeType === other?.mimeType &&
      image.storageType === other?.storageType &&
      image.storageKey === other?.storageKey
    );
  });
}

export function useAgentInputDraft(draftKey: string): AgentInputDraft {
  const [text, setText] = useState("");
  const [images, setImagesState] = useState<AttachmentMetadata[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const draftGenerationRef = useRef(0);
  const hydratedGenerationRef = useRef(0);

  const setImages = useCallback((updater: ImageUpdater) => {
    setImagesState((previousImages) => {
      if (typeof updater === "function") {
        return updater(previousImages);
      }
      return updater;
    });
  }, []);

  const clear = useCallback(
    (lifecycle: "sent" | "abandoned") => {
      const store = useDraftStore.getState();
      store.clearDraftInput({ draftKey, lifecycle });

      const generation = store.beginDraftGeneration(draftKey);
      draftGenerationRef.current = generation;
      hydratedGenerationRef.current = generation;

      setText("");
      setImagesState([]);
      setIsHydrated(true);
    },
    [draftKey],
  );

  useEffect(() => {
    const store = useDraftStore.getState();
    const generation = store.beginDraftGeneration(draftKey);
    draftGenerationRef.current = generation;
    hydratedGenerationRef.current = 0;

    setText("");
    setImagesState([]);
    setIsHydrated(false);

    let cancelled = false;

    void (async () => {
      const draft = await store.hydrateDraftInput(draftKey);
      if (cancelled) {
        return;
      }
      if (!useDraftStore.getState().isDraftGenerationCurrent({ draftKey, generation })) {
        return;
      }

      if (draft) {
        setText(draft.text);
        setImagesState(draft.images);
      }

      hydratedGenerationRef.current = generation;
      setIsHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [draftKey]);

  useEffect(() => {
    const currentGeneration = draftGenerationRef.current;
    if (currentGeneration <= 0) {
      return;
    }

    const store = useDraftStore.getState();
    const isCurrentGeneration = store.isDraftGenerationCurrent({
      draftKey,
      generation: currentGeneration,
    });
    if (!isCurrentGeneration) {
      return;
    }
    if (hydratedGenerationRef.current !== currentGeneration) {
      return;
    }

    const existing = store.getDraftInput(draftKey);
    const isSameDraft =
      existing?.text === text &&
      areImagesEqual({
        left: existing?.images ?? [],
        right: images,
      });
    if (isSameDraft) {
      return;
    }

    if (!hasDraftContent({ text, images })) {
      if (existing) {
        store.clearDraftInput({ draftKey, lifecycle: "abandoned" });
      }
      return;
    }

    store.saveDraftInput({
      draftKey,
      draft: {
        text,
        images,
      },
    });
  }, [draftKey, images, text]);

  return {
    text,
    setText,
    images,
    setImages,
    clear,
    isHydrated,
  };
}
