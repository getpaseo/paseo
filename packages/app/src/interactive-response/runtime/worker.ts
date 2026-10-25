/* oxlint-disable unicorn/require-post-message-target-origin -- Worker messages have no target origin. */
import { z } from "zod";
import { createArtifactVM } from "./vm";

const inbound = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("init"),
    scripts: z.array(z.string().max(100000)).max(100),
    initial: z.string().max(65536).optional(),
  }),
  z.object({
    type: z.literal("event"),
    event: z.object({
      id: z.string().max(64),
      type: z.enum(["click", "input", "change"]),
      value: z.string().max(10000),
      checked: z.boolean(),
    }),
  }),
  z.object({ type: z.literal("flush"), id: z.number().int().nonnegative() }),
]);
let vm: Awaited<ReturnType<typeof createArtifactVM>> | null = null;
let initializing = false;
self.addEventListener("message", async (event: MessageEvent<unknown>) => {
  try {
    const message = inbound.parse(event.data);
    if (message.type === "init") {
      if (initializing) throw new Error("Already initialized");
      initializing = true;
      vm = await createArtifactVM(message.initial, {
        render: (markup) => self.postMessage({ type: "render", markup }),
        state: (value) => self.postMessage({ type: "state", value }),
        failed: () => self.postMessage({ type: "error" }),
      });
      vm.run(message.scripts);
      self.postMessage({ type: "ready" });
    } else if (!vm) throw new Error("Runtime not ready");
    else if (message.type === "event") vm.event(message.event);
    else {
      vm.pause();
      self.postMessage({ type: "flushed", id: message.id });
    }
  } catch {
    vm?.dispose();
    self.postMessage({ type: "error" });
  }
});
