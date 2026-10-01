import { generateKeyPairSync } from "node:crypto";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { buildFcmMessage, FcmSender } from "./fcm-sender.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ACCOUNT = JSON.stringify({
  project_id: "pandaos",
  client_email: "push@pandaos.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

describe("FCM push", () => {
  it("sends the data message expo-notifications displays and routes on tap", () => {
    expect(
      buildFcmMessage("device", {
        title: "RateMyCoworking",
        body: "Bei Supabase anmelden",
        data: { workspaceId: "wks" },
      }),
    ).toEqual({
      message: {
        token: "device",
        android: { priority: "HIGH" },
        data: {
          title: "RateMyCoworking",
          message: "Bei Supabase anmelden",
          body: JSON.stringify({ workspaceId: "wks" }),
          channelId: "default",
        },
      },
    });
  });

  it("signs in with the service account once, sends per token and drops unregistered tokens", async () => {
    const onInvalidToken = vi.fn();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes("oauth2")) {
        expect(String(init?.body)).toContain("grant_type=urn%3Aietf");
        return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }));
      }
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access");
      const token = (JSON.parse(String(init?.body)) as { message: { token: string } }).message
        .token;
      return token === "gone"
        ? new Response(
            '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}',
            { status: 404 },
          )
        : new Response("{}");
    });
    const sender = new FcmSender({
      logger: pino({ level: "silent" }),
      onInvalidToken,
      fetchImpl: fetchImpl as never,
      readAccountFile: async () => {
        const { mkdtemp, writeFile } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const dir = await mkdtemp(`${tmpdir()}/fcm-`);
        await writeFile(`${dir}/pandaos-firebase-adminsdk.json`, ACCOUNT);
        return `${dir}/pandaos-firebase-adminsdk.json`;
      },
    });

    await sender.send(["fcm:ok", "fcm:gone"], { title: "T", body: "B" });
    await sender.send(["fcm:ok"], { title: "T", body: "B" });

    expect(calls.filter((url) => url.includes("oauth2"))).toHaveLength(1);
    expect(calls.filter((url) => url.includes("projects/pandaos/messages:send"))).toHaveLength(3);
    expect(onInvalidToken).toHaveBeenCalledWith("fcm:gone");
  });
});
