import { afterEach, describe, expect, it } from "vitest";
import type { ToastApi } from "@/components/toast-host";
import { setAppToastApi } from "@/contexts/app-toast";
import { createPluginNotifier } from "./notify";

function recordingToast() {
  const shown: Array<{ content: unknown; variant: string | undefined }> = [];
  const errors: string[] = [];
  const api: ToastApi = {
    show: (content, options) => shown.push({ content, variant: options?.variant }),
    copied: () => undefined,
    error: (message) => errors.push(message),
  };
  return { api, shown, errors };
}

describe("plugin notifier", () => {
  afterEach(() => setAppToastApi(null));

  it("routes each level to the app toast", () => {
    const toast = recordingToast();
    setAppToastApi(toast.api);

    const notify = createPluginNotifier();
    notify.success("Captured");
    notify.info("Working");
    notify.error("Capture failed");

    expect(toast.shown).toEqual([
      { content: "Captured", variant: "success" },
      { content: "Working", variant: "info" },
    ]);
    expect(toast.errors).toEqual(["Capture failed"]);
  });

  it("drops blank messages", () => {
    const toast = recordingToast();
    setAppToastApi(toast.api);

    const notify = createPluginNotifier();
    notify.success("   ");
    notify.error("");

    expect(toast.shown).toEqual([]);
    expect(toast.errors).toEqual([]);
  });

  it("stays silent before the app shell mounts", () => {
    const notify = createPluginNotifier();
    expect(() => notify.success("Captured")).not.toThrow();
  });
});
