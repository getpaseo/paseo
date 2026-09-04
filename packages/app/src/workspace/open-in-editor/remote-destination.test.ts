import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  const entries = new Map<string, string>();
  return {
    entries,
    default: {
      getItem: async (key: string) => entries.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        entries.set(key, value);
      },
      removeItem: async (key: string) => {
        entries.delete(key);
      },
    },
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({ default: storage.default }));

import {
  isSshHost,
  loadEditorRemoteDestination,
  sshDestination,
  suggestSshHost,
} from "./remote-destination";

const DESTINATION_KEY = "@paseo:editor-remote-destination:srv-1";
const LEGACY_AUTHORITY_KEY = "@paseo:editor-remote-authority:srv-1";

describe("isSshHost", () => {
  it("accepts the destination forms ssh understands", () => {
    expect(isSshHost("dev")).toBe(true);
    expect(isSshHost("my-dev-host")).toBe(true);
    expect(isSshHost("build.example.com")).toBe(true);
    expect(isSshHost("me@build.example.com")).toBe(true);
    expect(isSshHost("me@build.example.com:2222")).toBe(true);
  });

  it("rejects anything that would break the URI each editor builds from it", () => {
    expect(isSshHost("")).toBe(false);
    expect(isSshHost("my host")).toBe(false);
    expect(isSshHost("dev/repo")).toBe(false);
    expect(isSshHost("ssh://dev")).toBe(false);
    // The VS Code dialect is no longer what gets stored.
    expect(isSshHost("ssh-remote+dev")).toBe(false);
  });
});

describe("sshDestination", () => {
  it("builds an ssh destination from a typed host", () => {
    expect(sshDestination("dev")).toEqual({ kind: "ssh", host: "dev" });
    expect(sshDestination("  me@build.example.com:2222  ")).toEqual({
      kind: "ssh",
      host: "me@build.example.com:2222",
    });
  });

  it("accepts a pasted VS Code authority, since the field used to ask for one", () => {
    expect(sshDestination("ssh-remote+dev")).toEqual({ kind: "ssh", host: "dev" });
  });

  it("rejects an empty or malformed host", () => {
    expect(sshDestination("")).toBeNull();
    expect(sshDestination("   ")).toBeNull();
    expect(sshDestination("my host")).toBeNull();
    expect(sshDestination("dev/repo")).toBeNull();
    expect(sshDestination("ssh-remote+")).toBeNull();
  });
});

describe("suggestSshHost", () => {
  it("prefills the field with the hostname the daemon reports", () => {
    expect(suggestSshHost("build-box")).toBe("build-box");
    expect(suggestSshHost("  dev.local  ")).toBe("dev.local");
  });

  it("suggests nothing when the hostname cannot be an SSH destination", () => {
    expect(suggestSshHost(null)).toBe("");
    expect(suggestSshHost("")).toBe("");
    expect(suggestSshHost("My MacBook Pro")).toBe("");
  });
});

describe("loadEditorRemoteDestination", () => {
  beforeEach(() => {
    storage.entries.clear();
  });

  it("reads a stored destination", async () => {
    storage.entries.set(DESTINATION_KEY, JSON.stringify({ kind: "ssh", host: "dev" }));

    await expect(loadEditorRemoteDestination("srv-1")).resolves.toEqual({
      kind: "ssh",
      host: "dev",
    });
  });

  it("returns nothing when the host has never been configured", async () => {
    await expect(loadEditorRemoteDestination("srv-1")).resolves.toBeNull();
  });

  it("migrates a value stored as a VS Code authority instead of dropping it", async () => {
    storage.entries.set(LEGACY_AUTHORITY_KEY, "ssh-remote+dev");

    await expect(loadEditorRemoteDestination("srv-1")).resolves.toEqual({
      kind: "ssh",
      host: "dev",
    });
    expect(storage.entries.get(DESTINATION_KEY)).toBe('{"kind":"ssh","host":"dev"}');
    expect(storage.entries.has(LEGACY_AUTHORITY_KEY)).toBe(false);
  });

  it("prefers a stored destination over a stale legacy authority", async () => {
    storage.entries.set(DESTINATION_KEY, JSON.stringify({ kind: "ssh", host: "new-box" }));
    storage.entries.set(LEGACY_AUTHORITY_KEY, "ssh-remote+old-box");

    await expect(loadEditorRemoteDestination("srv-1")).resolves.toEqual({
      kind: "ssh",
      host: "new-box",
    });
  });

  it("clears a legacy value it cannot migrate", async () => {
    storage.entries.set(LEGACY_AUTHORITY_KEY, "wsl+Ubuntu-22.04");

    await expect(loadEditorRemoteDestination("srv-1")).resolves.toBeNull();
    expect(storage.entries.has(LEGACY_AUTHORITY_KEY)).toBe(false);
  });
});
