import { once } from "node:events";
import path from "node:path";
import { z } from "zod";
import { killProcessTree, spawnTsx } from "./spawn-node";

const readySchema = z.object({ port: z.number(), serverId: z.string() });
const ackSchema = z.object({ type: z.literal("tailscale-available-set"), available: z.boolean() });

export async function startTailscaleTestDaemon(
  origin: string,
  options?: { initialAvailable?: boolean },
) {
  const entrypoint = path.resolve(
    __dirname,
    "../../../../server/src/server/test-utils/tailscale-daemon.ts",
  );
  const initialMode = options?.initialAvailable === false ? "unavailable" : "available";
  const child = spawnTsx(entrypoint, [origin, initialMode], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const signal = AbortSignal.timeout(30_000);
  try {
    const ready = await Promise.race([
      once(child, "message", { signal }).then(([message]) => readySchema.parse(message)),
      once(child, "exit", { signal }).then(([code]) => {
        throw new Error(`Tailscale test daemon exited before startup with code ${code}`);
      }),
    ]);
    return {
      ...ready,
      tailscaleAddress: `127.0.0.2:${ready.port}`,
      async setTailscaleAvailable(available: boolean): Promise<void> {
        const ack = once(child, "message", { signal: AbortSignal.timeout(10_000) }).then(
          ([message]) => ackSchema.parse(message),
        );
        child.send({ type: "set-tailscale-available", available });
        const result = await ack;
        if (result.available !== available) {
          throw new Error(`Expected tailscaleAvailable=${String(available)}`);
        }
      },
      close: () => killProcessTree(child),
    };
  } catch (error) {
    await killProcessTree(child);
    throw error;
  }
}
