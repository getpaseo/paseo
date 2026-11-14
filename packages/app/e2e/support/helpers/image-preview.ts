import { expect, type Locator } from "@playwright/test";

function isReady(value: { ready(): boolean }): boolean {
  return value.ready();
}

/** Replay a queued native load payload after a real file refresh, through the image's load event. */
export async function holdNextPreviewLoad(pane: Locator, previousUrl: string) {
  const pending = await pane.evaluateHandle((container, oldUrl: string) => {
    let image: HTMLImageElement | null = null;
    let holding = true;
    const hold = (event: Event) => {
      if (holding) event.stopImmediatePropagation();
    };
    const observer = new MutationObserver(() => {
      if (image) return;
      const candidates = container.querySelectorAll<HTMLImageElement>(
        '[data-testid="image-file-preview-image"] img',
      );
      const next = Array.from(candidates).find((candidate) => candidate.src !== oldUrl);
      if (!next) return;
      image = next;
      image.addEventListener("load", hold, true);
      observer.disconnect();
    });
    observer.observe(container, { subtree: true, childList: true, attributes: true });
    return {
      ready: () => image !== null && image.complete && image.naturalWidth > 0,
      deliver(source: { url: string; width: number; height: number }) {
        if (!image) throw new Error("No pending preview load");
        // Expo's web adapter reads these fields to produce the same public onLoad
        // payload that native queues before React dispatches to the current listener.
        Object.defineProperties(image, {
          currentSrc: { configurable: true, value: source.url },
          naturalWidth: { configurable: true, value: source.width },
          naturalHeight: { configurable: true, value: source.height },
        });
        try {
          holding = false;
          image.dispatchEvent(new Event("load"));
          holding = true;
        } finally {
          Reflect.deleteProperty(image, "currentSrc");
          Reflect.deleteProperty(image, "naturalWidth");
          Reflect.deleteProperty(image, "naturalHeight");
        }
      },
      release() {
        holding = false;
        observer.disconnect();
        image?.removeEventListener("load", hold, true);
        image?.dispatchEvent(new Event("load"));
      },
    };
  }, previousUrl);
  return {
    async wait() {
      await expect.poll(() => pending.evaluate(isReady)).toBe(true);
    },
    async deliver(source: { url: string; width: number; height: number }) {
      await pending.evaluate((value, payload) => value.deliver(payload), source);
    },
    async release() {
      await pending.evaluate((value) => value.release());
      await pending.dispose();
    },
  };
}
