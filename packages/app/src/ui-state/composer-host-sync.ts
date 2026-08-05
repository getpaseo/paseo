import type { UserComposerAttachment } from "@/attachments/types";
import { useDraftStore } from "@/stores/draft-store";
import { toWireComposerKey } from "./keys";

const DEBOUNCE_MS = 300;

const pendingUpserts = new Map<string, ReturnType<typeof setTimeout>>();

export interface ComposerHostSyncClient {
  getUiState: (input: {
    namespace: "composer" | "review";
    key: string;
  }) => Promise<{ error: string | null; record: { text?: string; updatedAt: string } | null }>;
  upsertUiState: (input: {
    namespace: "composer" | "review";
    key: string;
    record: {
      text?: string;
      lifecycle?: "active" | "abandoned" | "sent";
      updatedAt: string;
    };
  }) => Promise<unknown>;
  clearUiState: (input: {
    namespace: "composer" | "review";
    key: string;
    updatedAt: string;
  }) => Promise<unknown>;
}

export function applyRemoteComposerRecord(input: {
  clientDraftKey: string;
  text: string;
  updatedAtIso: string;
}): void {
  const store = useDraftStore.getState();
  const existing = store.getDraftInput(input.clientDraftKey);
  // LWW: remote wins if we have no local, or remote timestamp is newer than local updatedAt.
  const localRecord = useDraftStore.getState().drafts[input.clientDraftKey];
  if (localRecord?.lifecycle === "active") {
    const localIso = new Date(localRecord.updatedAt).toISOString();
    if (localIso.localeCompare(input.updatedAtIso) > 0) {
      return;
    }
    if (localIso === input.updatedAtIso && existing?.text === input.text) {
      return;
    }
  }

  store.saveDraftInput({
    draftKey: input.clientDraftKey,
    draft: {
      text: input.text,
      attachments: existing?.attachments ?? [],
    },
  });
}

export async function hydrateComposerFromHost(input: {
  client: ComposerHostSyncClient;
  clientDraftKey: string;
}): Promise<void> {
  const wireKey = toWireComposerKey(input.clientDraftKey);
  if (!wireKey) {
    return;
  }
  const payload = await input.client.getUiState({
    namespace: "composer",
    key: wireKey,
  });
  if (payload.error || !payload.record) {
    return;
  }
  applyRemoteComposerRecord({
    clientDraftKey: input.clientDraftKey,
    text: payload.record.text ?? "",
    updatedAtIso: payload.record.updatedAt,
  });
}

export function scheduleComposerHostUpsert(input: {
  client: ComposerHostSyncClient;
  clientDraftKey: string;
  text: string;
  attachments: readonly UserComposerAttachment[];
}): void {
  const wireKey = toWireComposerKey(input.clientDraftKey);
  if (!wireKey) {
    return;
  }

  const existingTimer = pendingUpserts.get(input.clientDraftKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    pendingUpserts.delete(input.clientDraftKey);
    const updatedAt = new Date().toISOString();
    void input.client
      .upsertUiState({
        namespace: "composer",
        key: wireKey,
        record: {
          text: input.text,
          // Attachments stay device-local in Phase A; only text is authoritative on host.
          lifecycle: "active",
          updatedAt,
        },
      })
      .catch((error: unknown) => {
        console.warn("[ui-state] composer upsert failed", error);
      });
  }, DEBOUNCE_MS);

  pendingUpserts.set(input.clientDraftKey, timer);
}

export async function clearComposerOnHost(input: {
  client: ComposerHostSyncClient;
  clientDraftKey: string;
}): Promise<void> {
  const wireKey = toWireComposerKey(input.clientDraftKey);
  if (!wireKey) {
    return;
  }
  const existingTimer = pendingUpserts.get(input.clientDraftKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
    pendingUpserts.delete(input.clientDraftKey);
  }
  try {
    await input.client.clearUiState({
      namespace: "composer",
      key: wireKey,
      updatedAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.warn("[ui-state] composer clear failed", error);
  }
}

export function handleUiStateUpdatedForComposer(input: {
  message: {
    type: string;
    namespace?: string;
    key?: string;
    record?: { text?: string; updatedAt?: string } | null;
    updatedAt?: string;
  };
  /** Map wire key → open client draft keys that should receive the update. */
  resolveClientDraftKeys: (wireKey: string) => string[];
}): void {
  if (input.message.type !== "ui_state.updated") {
    return;
  }
  if (input.message.namespace !== "composer" || !input.message.key) {
    return;
  }
  const clientKeys = input.resolveClientDraftKeys(input.message.key);
  if (input.message.record == null) {
    for (const clientKey of clientKeys) {
      useDraftStore.getState().clearDraftInput({ draftKey: clientKey, lifecycle: "abandoned" });
    }
    return;
  }
  const text = input.message.record.text ?? "";
  const updatedAt = input.message.record.updatedAt ?? input.message.updatedAt ?? "";
  if (!updatedAt) {
    return;
  }
  for (const clientKey of clientKeys) {
    applyRemoteComposerRecord({
      clientDraftKey: clientKey,
      text,
      updatedAtIso: updatedAt,
    });
  }
}
