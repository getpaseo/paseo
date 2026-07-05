declare module "@getpaseo/server" {
  import type { ChildProcess, SpawnOptions } from "node:child_process";

  interface SpawnProcessOptions extends Omit<SpawnOptions, "env"> {
    baseEnv?: Record<string, string | undefined>;
    envMode?: "external" | "internal";
    env?: Record<string, string | undefined>;
    envOverlay?: Record<string, string | undefined>;
  }

  export function resolvePaseoHome(env?: NodeJS.ProcessEnv): string;
  export function spawnProcess(
    command: string,
    args: string[],
    options?: SpawnProcessOptions,
  ): ChildProcess;
}
