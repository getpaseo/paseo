import { describe, it, expect } from "vitest";
import pino from "pino";

import {
  planInstallStrategy,
  runCrgInstall,
  type CommandOutput,
  type InstallEvent,
} from "./installer.js";

function makeFakeRun(
  responses: Record<string, Array<CommandOutput>>,
): (command: string, args: string[]) => AsyncIterable<CommandOutput> {
  return async function* (command: string, args: string[]) {
    const key = [command, ...args].join(" ");
    const seq = responses[key];
    if (!seq) {
      throw new Error(`Fake run has no response for: ${key}`);
    }
    for (const item of seq) yield item;
  };
}

describe("planInstallStrategy", () => {
  it("prefers pipx when available", () => {
    const s = planInstallStrategy({
      pipxAvailable: true,
      brewAvailable: true,
      python3Available: true,
      platform: "darwin",
    });
    expect(s.kind).toBe("pipx");
    if (s.kind === "pipx") {
      expect(s.args).toEqual(["install", "git+https://github.com/hubtool/code-review-graph.git"]);
    }
  });

  it("chains brew → pipx on macOS when only brew is present", () => {
    const s = planInstallStrategy({
      pipxAvailable: false,
      brewAvailable: true,
      python3Available: false,
      platform: "darwin",
    });
    expect(s.kind).toBe("brew-then-pipx");
    if (s.kind === "brew-then-pipx") {
      expect(s.steps.map((st) => st.command)).toEqual(["brew", "pipx", "pipx"]);
    }
  });

  it("bootstraps pipx via python3 when neither pipx nor brew is present", () => {
    const s = planInstallStrategy({
      pipxAvailable: false,
      brewAvailable: false,
      python3Available: true,
      platform: "darwin",
    });
    expect(s.kind).toBe("python3-bootstrap-pipx");
    if (s.kind === "python3-bootstrap-pipx") {
      expect(s.steps.map((st) => st.command)).toEqual(["python3", "python3", "python3"]);
      expect(s.steps[0]?.args).toEqual([
        "-m",
        "pip",
        "install",
        "--user",
        "--break-system-packages",
        "pipx",
      ]);
    }
  });

  it("returns unsupported on Linux when python3, pipx, and brew are all missing", () => {
    const s = planInstallStrategy({
      pipxAvailable: false,
      brewAvailable: false,
      python3Available: false,
      platform: "linux",
    });
    expect(s.kind).toBe("unsupported");
    if (s.kind === "unsupported") expect(s.reason).toMatch(/Python 3\.10\+ or pipx/);
  });

  it("returns unsupported on Windows when nothing is installed", () => {
    const s = planInstallStrategy({
      pipxAvailable: false,
      brewAvailable: false,
      python3Available: false,
      platform: "win32",
    });
    expect(s.kind).toBe("unsupported");
    if (s.kind === "unsupported") expect(s.reason).toMatch(/winget/);
  });
});

async function collect(gen: AsyncGenerator<InstallEvent>): Promise<InstallEvent[]> {
  const out: InstallEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("runCrgInstall (streaming)", () => {
  it("runs pipx install and emits plan + step + completed(success) on exit 0", async () => {
    const events = await collect(
      runCrgInstall({
        logger: pino({ enabled: false }),
        pipxAvailable: true,
        brewAvailable: false,
        python3Available: false,
        platform: "linux",
        runCommand: makeFakeRun({
          "pipx install git+https://github.com/hubtool/code-review-graph.git": [
            { kind: "stdout", text: "Downloading…\n" },
            { kind: "stdout", text: "Installed.\n" },
            { kind: "exit", exitCode: 0 },
          ],
        }),
      }),
    );
    expect(events[0]?.type).toBe("plan");
    expect(events.some((e) => e.type === "step-started")).toBe(true);
    expect(events.filter((e) => e.type === "step-output")).toHaveLength(2);
    const last = events[events.length - 1];
    expect(last).toEqual({ type: "completed", success: true });
  });

  it("reports failure and stops when a step exits non-zero", async () => {
    const events = await collect(
      runCrgInstall({
        logger: pino({ enabled: false }),
        pipxAvailable: true,
        brewAvailable: false,
        python3Available: false,
        platform: "linux",
        runCommand: makeFakeRun({
          "pipx install git+https://github.com/hubtool/code-review-graph.git": [
            { kind: "stderr", text: "pip not found\n" },
            { kind: "exit", exitCode: 1 },
          ],
        }),
      }),
    );
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "completed", success: false });
    if (last?.type === "completed") {
      expect(last.error).toContain("exited with code 1");
    }
  });

  it("stops after the first failing step in a chain", async () => {
    const events = await collect(
      runCrgInstall({
        logger: pino({ enabled: false }),
        pipxAvailable: false,
        brewAvailable: true,
        python3Available: false,
        platform: "darwin",
        runCommand: makeFakeRun({
          "brew install pipx": [{ kind: "exit", exitCode: 1 }],
          // This should never be reached:
          "pipx install git+https://github.com/hubtool/code-review-graph.git": [
            { kind: "exit", exitCode: 0 },
          ],
        }),
      }),
    );
    const stepCompleted = events.filter((e) => e.type === "step-completed");
    expect(stepCompleted).toHaveLength(1);
    expect(stepCompleted[0]).toMatchObject({ command: "brew", exitCode: 1 });
    expect(events[events.length - 1]).toMatchObject({ type: "completed", success: false });
  });

  it("runs all steps on happy chain (brew → ensurepath → pipx install)", async () => {
    const events = await collect(
      runCrgInstall({
        logger: pino({ enabled: false }),
        pipxAvailable: false,
        brewAvailable: true,
        python3Available: false,
        platform: "darwin",
        runCommand: makeFakeRun({
          "brew install pipx": [{ kind: "exit", exitCode: 0 }],
          "pipx ensurepath": [{ kind: "exit", exitCode: 0 }],
          "pipx install git+https://github.com/hubtool/code-review-graph.git": [
            { kind: "exit", exitCode: 0 },
          ],
        }),
      }),
    );
    const stepCompleted = events.filter((e) => e.type === "step-completed");
    expect(stepCompleted.map((e) => (e.type === "step-completed" ? e.command : null))).toEqual([
      "brew",
      "pipx",
      "pipx",
    ]);
    expect(events[events.length - 1]).toMatchObject({ type: "completed", success: true });
  });

  it("emits completed=false with unsupported reason when no strategy viable", async () => {
    const events = await collect(
      runCrgInstall({
        logger: pino({ enabled: false }),
        pipxAvailable: false,
        brewAvailable: false,
        python3Available: false,
        platform: "linux",
      }),
    );
    expect(events[0]?.type).toBe("plan");
    expect(events[events.length - 1]).toMatchObject({ type: "completed", success: false });
    if (events[events.length - 1]?.type === "completed") {
      expect((events[events.length - 1] as { error?: string }).error).toMatch(
        /Python 3\.10\+ or pipx/,
      );
    }
  });

  it("converts thrown runCommand errors into completed=false", async () => {
    const events = await collect(
      runCrgInstall({
        logger: pino({ enabled: false }),
        pipxAvailable: true,
        brewAvailable: false,
        python3Available: false,
        platform: "linux",
        runCommand: async function* () {
          throw new Error("ENOENT: pipx");
        },
      }),
    );
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "completed", success: false });
    if (last?.type === "completed") {
      expect(last.error).toMatch(/ENOENT/);
    }
  });
});
