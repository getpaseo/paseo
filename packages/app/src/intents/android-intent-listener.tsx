import { useEffect, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { useStoreReady } from "@/app/_layout";
import { useToast } from "@/contexts/toast-context";
import { androidIntents } from "@/native/android-intents";
import { parseSharedIntentPayload } from "./shared-intent-payload";
import { stageSharedIntent, type StagedSharedIntent } from "./stage-shared-intent";

/**
 * Receives share-sheet and PROCESS_TEXT intents from the native module. The
 * prompt is staged immediately; navigation waits for the store so a cold
 * start does not lose the route to the startup redirect.
 */
export function AndroidIntentListener() {
  const router = useRouter();
  const toast = useToast();
  const { t } = useTranslation();
  const storeReady = useStoreReady();
  const [staged, setStaged] = useState<StagedSharedIntent | null>(null);

  useEffect(() => {
    if (!androidIntents.isAvailable) {
      return;
    }
    let cancelled = false;
    const handle = (raw: unknown) => {
      const payload = parseSharedIntentPayload(raw);
      if (!payload) {
        return;
      }
      void (async () => {
        const result = await stageSharedIntent(payload);
        if (!cancelled && result) {
          setStaged(result);
        }
      })();
    };
    handle(androidIntents.consumeLaunchIntent());
    const subscription = androidIntents.addIntentListener(handle);
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);

  useEffect(() => {
    if (!staged || !storeReady) {
      return;
    }
    setStaged(null);
    router.navigate(staged.route as Href);
    if (staged.skippedFiles > 0) {
      toast.error(t("intents.share.skippedFiles", { count: staged.skippedFiles }));
    }
  }, [router, staged, storeReady, t, toast]);

  return null;
}
