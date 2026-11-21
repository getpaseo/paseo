import AsyncStorage from "@react-native-async-storage/async-storage";
import { createDraftCreations } from "./creation-attempt";
import { i18n } from "@/i18n/i18next";
import { CreationNotSentError } from "@getpaseo/client/internal/daemon-client";

export const draftCreations = createDraftCreations({
  storage: AsyncStorage,
  outcomeUnknownMessage: () => i18n.t("composer.errors.creationOutcomeUnknown"),
  isNotSent: (error) => error instanceof CreationNotSentError,
  onPersistenceError: (error) =>
    console.warn("[DraftCreation] Checkpoint persistence failed", error),
});
