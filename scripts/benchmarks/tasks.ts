export interface BenchmarkTaskDefinition {
  id: string;
  description: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const appWorkspace = "packages/app";
const desktopBenchmarkEnvironment = {
  E2E_DESKTOP_RUNTIME: "1",
  PASEO_DESKTOP_BENCHMARK: "1",
};

function appTsxTask(script: string): Pick<BenchmarkTaskDefinition, "command" | "args" | "cwd"> {
  return {
    command: npxCommand,
    args: ["--no-install", "tsx", "--tsconfig", "tsconfig.json", script],
    cwd: appWorkspace,
  };
}

function appPlaywrightTask(
  spec: string,
  env: Record<string, string> = {},
): Pick<BenchmarkTaskDefinition, "command" | "args" | "cwd" | "env"> {
  return {
    command: npxCommand,
    args: ["--no-install", "playwright", "test", spec, "--project", "browser"],
    cwd: appWorkspace,
    env: { ...desktopBenchmarkEnvironment, ...env },
  };
}

export const benchmarkTasks: BenchmarkTaskDefinition[] = [
  {
    id: "agent-stream-reducer",
    description: "Measure assistant chunk reduction across scheduled client reducer flushes",
    ...appTsxTask("scripts/benchmark-agent-stream-reducer.ts"),
  },
  {
    id: "draft-attachment-gc",
    description: "Measure the full-session attachment GC scan paid by repeated draft changes",
    ...appTsxTask("scripts/benchmark-draft-attachment-gc.ts"),
  },
  {
    id: "desktop-interaction",
    description: "Measure heavy Desktop tab switching, retained DOM/AX nodes, React, and heap",
    ...appPlaywrightTask("e2e/desktop-interaction.benchmark.spec.ts"),
  },
  {
    id: "desktop-streaming",
    description: "Measure 64KiB to 1MiB live streams through reducer, React, and browser feedback",
    ...appPlaywrightTask("e2e/desktop-streaming.benchmark.spec.ts", {
      PASEO_MARKDOWN_BENCHMARK: "0",
    }),
  },
  {
    id: "desktop-markdown",
    description: "Measure deterministic Markdown parsing, highlighting, rendering, and feedback",
    ...appPlaywrightTask("e2e/desktop-streaming.benchmark.spec.ts", {
      PASEO_MARKDOWN_BENCHMARK: "1",
    }),
  },
  {
    id: "desktop-css-interactions",
    description: "Measure Desktop tab hover feedback, React commits, frames, DOM, and AX nodes",
    ...appPlaywrightTask("e2e/desktop-css-interactions.benchmark.spec.ts"),
  },
  {
    id: "desktop-css-interaction-audit",
    description: "Count JS-driven hover and press interaction debt by Desktop UI area",
    command: process.execPath,
    args: ["scripts/audit-desktop-css-interactions.mjs"],
    cwd: appWorkspace,
  },
];
