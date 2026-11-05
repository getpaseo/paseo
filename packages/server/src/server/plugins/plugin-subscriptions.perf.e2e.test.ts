import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, expect, test } from "vitest";
import { resolveDaemonVersion } from "../daemon-version.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const PUSH_BYTES = 256 * 1024;
const TOTAL_BYTES = 100 * 1024 * 1024;
const PUSHES = TOTAL_BYTES / PUSH_BYTES;
const MIN_MEGABYTES_PER_SECOND = 200;

// One buffer, pushed until the total is out: what a capture loop looks like.
const SERVER_ENTRY = `
import { defineSubscription } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const stream = defineSubscription({
  name: "stream",
  input: z.object({ pushes: z.number().int(), bytes: z.number().int() }),
  event: z.instanceof(Uint8Array),
});

export default function contribute(server: PluginServerContext) {
  server.handle(stream, async ({ pushes, bytes }, { push, signal }) => {
    const chunk = new Uint8Array(bytes).fill(7);
    for (let sent = 0; sent < pushes && !signal.aborted; sent += 1) await push(chunk);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  });
  return () => undefined;
}
`;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test(`a plugin streams ${TOTAL_BYTES / 1024 / 1024} MiB in ${PUSH_BYTES / 1024} KiB pushes at ${MIN_MEGABYTES_PER_SECOND} MB/s without copying per frame`, async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-stream-"));
  roots.push(pluginDirectory);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: "stream",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(path.join(pluginDirectory, "index.server.ts"), SERVER_ENTRY);
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: `clid_plugin_stream_${Date.now()}`,
    appVersion: resolveDaemonVersion(import.meta.url),
  });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);

    let received = 0;
    let frames = 0;
    let copied = 0;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const baseline = process.memoryUsage().arrayBuffers;
    let peak = baseline;
    const started = performance.now();
    const subscription = client.observePluginRpc("stream", "stream", {
      pushes: PUSHES,
      bytes: PUSH_BYTES,
    });
    subscription.subscribe({
      snapshot: () => undefined,
      update: () => undefined,
      binary: (payload) => {
        received += payload.byteLength;
        frames += 1;
        // The payload is a view into the frame the socket received, not a copy of it.
        if (payload.buffer.byteLength - payload.byteLength > 1024) copied += 1;
        if (frames % 40 === 0) peak = Math.max(peak, process.memoryUsage().arrayBuffers);
        if (received >= TOTAL_BYTES) finished();
      },
    });
    await done;
    const seconds = (performance.now() - started) / 1000;
    const megabytesPerSecond = TOTAL_BYTES / 1e6 / seconds;
    process.stderr.write(
      `[plugin stream] ${frames} frames, ${(TOTAL_BYTES / 1e6).toFixed(1)} MB in ${(seconds * 1000).toFixed(0)} ms: ${megabytesPerSecond.toFixed(0)} MB/s, peak external buffers +${((peak - baseline) / 1024 / 1024).toFixed(1)} MiB\n`,
    );

    expect(frames).toBe(PUSHES);
    expect(received).toBe(TOTAL_BYTES);
    expect(copied).toBe(0);
    expect(megabytesPerSecond).toBeGreaterThanOrEqual(MIN_MEGABYTES_PER_SECOND);
    // Memory held while streaming stays bounded by in-flight frames, not by the payload total.
    expect(peak - baseline).toBeLessThan(TOTAL_BYTES / 2);
    await subscription.release();
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 120_000);
