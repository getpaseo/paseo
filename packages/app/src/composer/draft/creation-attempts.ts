import AsyncStorage from "@react-native-async-storage/async-storage";
import { createDraftCreations } from "./creation-attempt";
import { i18n } from "@/i18n/i18next";

export const draftCreations = createDraftCreations(AsyncStorage, () =>
  i18n.t("composer.errors.creationOutcomeUnknown"),
);
