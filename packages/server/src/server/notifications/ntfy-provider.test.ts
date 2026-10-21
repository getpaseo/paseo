import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NtfyProvider } from "./ntfy-provider.js";
import { resolveNotificationConfig } from "./notification-config.js";
import { createNotificationHttpFake, createNotificationTestLogger } from "./test-utils.js";

describe("ntfy provider reliability", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });
  it("does not replay queued private content to a changed ntfy destination", async () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-ntfy-"));
    homes.push(home);
    const fake = createNotificationHttpFake([{ status: 503 }]);
    const config = resolveNotificationConfig({
      PASEO_NOTIFICATION_PROVIDER: "ntfy",
      PASEO_NTFY_URL: "https://ntfy.example.com",
      PASEO_NTFY_TOPIC: "old",
      PASEO_NTFY_TOKEN: "token",
    });
    let now = 0;
    const options = {
      config: config.ntfy,
      logger: createNotificationTestLogger().logger,
      filePath: join(home, "queue.json"),
      http: fake.request,
      now: () => now,
      automatic: false,
    };
    const first = new NtfyProvider(options);
    await first.send("event", { title: "Done", message: "private", priority: "default" });
    await first.close();
    now = 10_000;
    const changed = new NtfyProvider({ ...options, config: { ...config.ntfy, topic: "new" } });
    await changed.drain();
    expect(fake.requests).toHaveLength(1);
    await changed.close();
  });
  it.each([503, 429, 401, 403])(
    "handles HTTP %s with appropriate retries and safe logs",
    async (status) => {
      const home = mkdtempSync(join(tmpdir(), "paseo-ntfy-"));
      homes.push(home);
      const fake = createNotificationHttpFake([
        { status, headers: { "Retry-After": "3" }, body: { error: "private-bearer" } },
        { body: { id: "message", event: "message" } },
      ]);
      const config = resolveNotificationConfig({
        PASEO_NOTIFICATION_PROVIDER: "ntfy",
        PASEO_NTFY_URL: "https://ntfy.example.com",
        PASEO_NTFY_TOPIC: "agents",
        PASEO_NTFY_TOKEN: "private-bearer",
      });
      let now = 0;
      const { logger, records } = createNotificationTestLogger();
      const provider = new NtfyProvider({
        config: config.ntfy,
        logger,
        filePath: join(home, "queue.json"),
        http: fake.request,
        now: () => now,
        automatic: false,
      });
      await provider.send("event", {
        title: "عنوان\nآزمایش",
        message: "UTF-8 ✓",
        priority: "urgent",
      });
      now = 3000;
      await provider.drain();
      expect(fake.requests).toHaveLength(status >= 500 || status === 429 ? 2 : 1);
      expect(JSON.parse(fake.requests[0].init.body as string)).toMatchObject({
        priority: 5,
        message: "UTF-8 ✓",
      });
      expect(records.join("\n")).not.toContain("private-bearer");
      await provider.close();
    },
  );
});
