import { once } from "node:events";
import path from "node:path";
import { z } from "zod";
import { killProcessTree, spawnTsx } from "./spawn-node";

const readySchema = z.object({ port: z.number(), serverId: z.string() });

export async function startTailscaleTestDaemon(origin: string) {
  const entrypoint = path.resolve(
    __dirname,
    "../../../../server/src/server/test-utils/tailscale-daemon.ts",
  );
  const child = spawnTsx(entrypoint, [origin], {
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
      close: () => killProcessTree(child),
    };
  } catch (error) {
    await killProcessTree(child);
    throw error;
  }
}
