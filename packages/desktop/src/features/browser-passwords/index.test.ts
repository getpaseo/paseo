import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry";
import {
  BrowserPasswords,
  type PasswordFrame,
  type PasswordGuestSender,
  SAVE_PASSWORD_REQUEST_EVENT,
} from "./index";
import { type PasswordCrypto, PasswordVault } from "./vault";

const PASSWORD = "correct horse battery staple";
const HOST_ID = 1;
const GUEST_ID = 10;

interface SentMessage {
  channel: string;
  payload: unknown;
}

function createCrypto(state: { available: boolean }): PasswordCrypto {
  return {
    isAvailable: () => state.available,
    encrypt: (plainText) => Buffer.from(`enc:${plainText}`, "utf8"),
    decrypt: (cipherText) => cipherText.toString("utf8").slice(4),
  };
}

describe("BrowserPasswords", () => {
  let dir: string;
  let registry: PaseoBrowserWebviewRegistry;
  let vault: PasswordVault;
  let crypto: { available: boolean };
  let clock: number;
  let nextId: number;
  let sent: SentMessage[];
  let passwords: BrowserPasswords;
  let mainFrame: PasswordFrame;
  let guest: PasswordGuestSender;

  function frame(url: string, routingId = 1): PasswordFrame {
    return { url, processId: 7, routingId };
  }

  function submit(
    payload: unknown = { username: "ada", password: PASSWORD },
    senderFrame: PasswordFrame | null = mainFrame,
    sender: PasswordGuestSender = guest,
  ): void {
    passwords.credentialsSubmitted(sender, senderFrame, payload);
  }

  function lastRequest(): Record<string, unknown> {
    const message = sent.at(-1);
    expect(message?.channel).toBe(SAVE_PASSWORD_REQUEST_EVENT);
    return message?.payload as Record<string, unknown>;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "paseo-browser-passwords-"));
    registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({
      webContentsId: GUEST_ID,
      browserId: "browser-1",
      hostWebContentsId: HOST_ID,
    });
    crypto = { available: true };
    clock = 0;
    nextId = 0;
    sent = [];
    vault = new PasswordVault({
      filePath: join(dir, "browser-passwords.json"),
      crypto: createCrypto(crypto),
      now: () => clock,
    });
    passwords = new BrowserPasswords({
      vault,
      registry,
      isHostSender: (sender) => sender.id === HOST_ID,
      randomId: () => `request-${++nextId}`,
      now: () => clock,
    });
    mainFrame = frame("https://example.com/login?next=/home");
    guest = {
      id: GUEST_ID,
      mainFrame,
      hostWebContents: {
        id: HOST_ID,
        isDestroyed: () => false,
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks the host with the frame origin and never includes the password", () => {
    submit({ username: "ada", password: PASSWORD, origin: "https://evil.test" });

    expect(sent).toHaveLength(1);
    expect(lastRequest()).toEqual({
      browserId: "browser-1",
      requestId: "request-1",
      origin: "https://example.com",
      username: "ada",
      update: false,
    });
    expect(JSON.stringify(sent)).not.toContain(PASSWORD);
  });

  it("saves only after the requesting host answers save", () => {
    submit();
    expect(vault.list()).toEqual([]);

    expect(passwords.respond({ id: HOST_ID }, { requestId: "request-1", action: "save" })).toBe(
      true,
    );
    expect(passwords.lookup(guest, mainFrame)).toEqual([{ username: "ada", password: PASSWORD }]);
    expect(passwords.respond({ id: HOST_ID }, { requestId: "request-1", action: "save" })).toBe(
      false,
    );
  });

  it("rejects senders that are not registered browser guests", () => {
    submit(undefined, mainFrame, { ...guest, id: 99 });
    expect(sent).toEqual([]);

    vault.save("https://example.com", "ada", PASSWORD);
    expect(passwords.lookup({ ...guest, id: 99 }, mainFrame)).toEqual([]);
  });

  it("rejects guests whose host is not the registered host", () => {
    const otherHost = { id: 2, isDestroyed: () => false, send: () => {} };
    submit(undefined, mainFrame, { ...guest, hostWebContents: otherHost });
    expect(sent).toEqual([]);
  });

  it("rejects subframes and missing frames", () => {
    submit(undefined, frame("https://example.com/login", 2));
    submit(undefined, null);
    expect(sent).toEqual([]);

    vault.save("https://example.com", "ada", PASSWORD);
    expect(passwords.lookup(guest, frame("https://example.com/login", 2))).toEqual([]);
  });

  it("ignores non-web origins", () => {
    const fileFrame = frame("file:///tmp/login.html");
    submit(undefined, fileFrame, { ...guest, mainFrame: fileFrame });
    expect(sent).toEqual([]);
  });

  it("only returns credentials for the guest's own origin", () => {
    vault.save("https://other.test", "ada", PASSWORD);
    expect(passwords.lookup(guest, mainFrame)).toEqual([]);
  });

  it("ignores submissions when encryption is unavailable", () => {
    crypto.available = false;
    submit();
    expect(sent).toEqual([]);
  });

  it("ignores origins marked never and unchanged passwords", () => {
    submit();
    passwords.respond({ id: HOST_ID }, { requestId: "request-1", action: "never" });
    submit();
    expect(sent).toHaveLength(1);
    expect(vault.list()).toEqual([]);

    vault.save("https://example.com", "ada", PASSWORD);
    submit();
    expect(sent).toHaveLength(1);
  });

  it("flags a changed password for a known username as an update", () => {
    vault.save("https://example.com", "ada", "old password");
    submit();
    expect(lastRequest().update).toBe(true);
  });

  it("only accepts an answer from the host that received the request", () => {
    submit();
    expect(passwords.respond({ id: 2 }, { requestId: "request-1", action: "save" })).toBe(false);
    expect(passwords.respond({ id: HOST_ID }, { requestId: "unknown", action: "save" })).toBe(
      false,
    );
    expect(vault.list()).toEqual([]);
  });

  it("forgets pending passwords after five minutes", () => {
    submit();
    clock = 5 * 60 * 1000;
    expect(passwords.respond({ id: HOST_ID }, { requestId: "request-1", action: "save" })).toBe(
      false,
    );
    expect(vault.list()).toEqual([]);
  });

  it("keeps at most twenty pending passwords and replaces repeats of one login", () => {
    for (let index = 0; index < 21; index += 1) {
      submit({ username: `user-${index}`, password: PASSWORD });
    }
    expect(passwords.respond({ id: HOST_ID }, { requestId: "request-1", action: "save" })).toBe(
      false,
    );
    expect(passwords.respond({ id: HOST_ID }, { requestId: "request-2", action: "save" })).toBe(
      true,
    );

    submit({ username: "repeat", password: "one" });
    submit({ username: "repeat", password: "two" });
    expect(passwords.respond({ id: HOST_ID }, { requestId: "request-22", action: "save" })).toBe(
      false,
    );
    expect(passwords.respond({ id: HOST_ID }, { requestId: "request-23", action: "save" })).toBe(
      true,
    );
    expect(vault.has("https://example.com", "repeat", "two")).toBe(true);
  });

  it("lists and removes saved logins for host windows only, without secrets", () => {
    vault.save("https://example.com", "ada", PASSWORD);
    expect(passwords.list({ id: HOST_ID })).toEqual({
      available: true,
      logins: [{ origin: "https://example.com", username: "ada" }],
    });
    expect(JSON.stringify(passwords.list({ id: HOST_ID }))).not.toContain(PASSWORD);
    expect(() => passwords.list({ id: GUEST_ID })).toThrow();
    expect(() =>
      passwords.remove({ id: GUEST_ID }, { origin: "https://example.com", username: "ada" }),
    ).toThrow();

    passwords.remove({ id: HOST_ID }, { origin: "https://example.com", username: "ada" });
    expect(vault.list()).toEqual([]);
  });
});
