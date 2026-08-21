import { describe, expect, test } from "vitest";

import {
  HermesProfileManager,
  profileNameForAgent,
  type HermesProfileCommand,
} from "./hermes-profile-manager.js";

class FakeHermesProfileCommand implements HermesProfileCommand {
  readonly profiles = new Map<string, string>();
  readonly creates: Array<{
    profile: string;
    sourceProfile: string;
  }> = [];
  readonly runtimeState: Array<{
    profile: string;
    sourceProfile: string;
    includeRuntimeState: boolean;
    runtimeSessionId?: string;
  }> = [];
  readonly hardens: string[] = [];
  failNextCreate = false;

  async profileHome(profile: string): Promise<string | null> {
    return this.profiles.get(profile) ?? null;
  }

  async createProfile(profile: string, sourceProfile: string): Promise<string> {
    const existing = this.profiles.get(profile);
    if (existing) return existing;
    this.creates.push({ profile, sourceProfile });
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("clone failed");
    }
    const home = `/profiles/${profile}`;
    this.profiles.set(profile, home);
    return home;
  }

  async deleteProfile(profile: string): Promise<void> {
    this.profiles.delete(profile);
  }

  async hardenProfile(profile: string): Promise<void> {
    this.hardens.push(profile);
  }

  async ensureRuntimeState(
    profile: string,
    sourceProfile: string,
    _home: string,
    includeRuntimeState: boolean,
    runtimeSessionId?: string,
  ): Promise<void> {
    this.runtimeState.push({ profile, sourceProfile, includeRuntimeState, runtimeSessionId });
  }
}

describe("HermesProfileManager", () => {
  test("assigns every concurrent Paseo agent its own Hermes profile", async () => {
    const command = new FakeHermesProfileCommand();
    const manager = new HermesProfileManager({ command, sourceProfile: "default" });

    const assignments = await Promise.all(
      Array.from({ length: 10 }, (_, index) => manager.prepare(`agent-${index + 1}`)),
    );

    expect(new Set(assignments.map(({ profile }) => profile)).size).toBe(10);
    expect(new Set(assignments.map(({ home }) => home)).size).toBe(10);
    expect(assignments.every(({ profile }) => profile.startsWith("paseo-"))).toBe(true);
    expect(command.creates).toHaveLength(10);
    expect(command.hardens).toHaveLength(10);
    expect(command.creates.every(({ sourceProfile }) => sourceProfile === "default")).toBe(true);
    expect(command.runtimeState.every(({ includeRuntimeState }) => !includeRuntimeState)).toBe(
      true,
    );
  });

  test("coalesces concurrent preparation for the same agent", async () => {
    const command = new FakeHermesProfileCommand();
    const manager = new HermesProfileManager({ command });

    const assignments = await Promise.all(
      Array.from({ length: 10 }, () => manager.prepare("same-agent")),
    );

    expect(new Set(assignments.map(({ profile }) => profile)).size).toBe(1);
    expect(command.creates).toHaveLength(1);
  });

  test("reuses the deterministic profile after a daemon restart", async () => {
    const command = new FakeHermesProfileCommand();
    const firstManager = new HermesProfileManager({ command });
    const first = await firstManager.prepare("resumable-agent");

    const restartedManager = new HermesProfileManager({ command });
    const resumed = await restartedManager.prepare("resumable-agent");

    expect(resumed).toEqual(first);
    expect(command.creates).toHaveLength(1);
    expect(command.hardens).toEqual([first.profile, first.profile]);
  });

  test("retries a failed clone without changing the assigned profile", async () => {
    const command = new FakeHermesProfileCommand();
    command.failNextCreate = true;
    const manager = new HermesProfileManager({ command });

    await expect(manager.prepare("retry-agent")).rejects.toThrow("clone failed");
    const assignment = await manager.prepare("retry-agent");

    expect(command.creates).toHaveLength(2);
    expect(command.creates[0]?.profile).toBe(command.creates[1]?.profile);
    expect(assignment.profile).toBe(command.creates[0]?.profile);
  });

  test("rehardens an existing profile before every launch", async () => {
    const command = new FakeHermesProfileCommand();
    const profile = profileNameForAgent("existing-agent");
    command.profiles.set(profile, `/profiles/${profile}`);
    const manager = new HermesProfileManager({ command });

    await manager.prepare("existing-agent");
    await manager.prepare("existing-agent");

    expect(command.creates).toEqual([]);
    expect(command.hardens).toEqual([profile, profile]);
  });

  test("copies legacy runtime state only when first preparing a resumed agent", async () => {
    const command = new FakeHermesProfileCommand();
    const manager = new HermesProfileManager({ command });

    const assignment = await manager.prepare("legacy-agent", {
      includeRuntimeState: true,
      runtimeSessionId: "legacy-native-session",
    });

    expect(command.runtimeState).toEqual([
      {
        profile: assignment.profile,
        sourceProfile: "default",
        includeRuntimeState: true,
        runtimeSessionId: "legacy-native-session",
      },
    ]);
    expect(command.hardens).toEqual([assignment.profile]);
  });
});
