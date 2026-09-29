import { describe, expect, test } from "vitest";
import { detectRunOrigin } from "./run-origin.js";

function sources(overrides: {
  env?: NodeJS.ProcessEnv;
  isTty?: boolean;
  files?: Record<string, string>;
}) {
  const files = overrides.files ?? {};
  return {
    env: overrides.env ?? {},
    isTty: overrides.isTty ?? false,
    ppid: 42,
    readFile: (path: string) => {
      if (path in files) return files[path];
      throw new Error("ENOENT");
    },
  };
}

describe("detectRunOrigin", () => {
  test("names the systemd unit a timer ran the command in", () => {
    const cgroup = "0::/user.slice/user-1001.slice/user@1001.service/app.slice/g4-watch.service\n";
    expect(detectRunOrigin(sources({ files: { "/proc/self/cgroup": cgroup } }))).toBe(
      "systemd:g4-watch.service",
    );
  });

  test("reports a terminal as the user", () => {
    const cgroup = "0::/user.slice/user-1001.slice/session-3.scope\n";
    expect(detectRunOrigin(sources({ isTty: true, files: { "/proc/self/cgroup": cgroup } }))).toBe(
      "user:cli",
    );
  });

  test("falls back to the calling script", () => {
    const files = { "/proc/42/cmdline": "bash\0/home/x/scripts/watch_events.sh\0" };
    expect(detectRunOrigin(sources({ files }))).toBe("process:watch_events.sh");
  });

  test("leaves agents to the daemon", () => {
    expect(detectRunOrigin(sources({ env: { PASEO_AGENT_ID: "a1" } }))).toBeUndefined();
  });
});
