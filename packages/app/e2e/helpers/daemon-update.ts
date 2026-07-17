import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

export interface OutdatedDaemon {
  endpoint: string;
  label: string;
  serverId: string;
  close(): Promise<void>;
}

interface OutdatedDaemonReadyMessage {
  type: "ready";
  endpoint: string;
  serverId: string;
}

interface OutdatedDaemonErrorMessage {
  type: "error";
  error: string;
}

type OutdatedDaemonMessage = OutdatedDaemonReadyMessage | OutdatedDaemonErrorMessage;

export async function startOutdatedDaemon(options?: {
  desktopManaged?: boolean;
}): Promise<OutdatedDaemon> {
  const metroPort = process.env.E2E_METRO_PORT;
  if (!metroPort) {
    throw new Error("E2E_METRO_PORT is not set - globalSetup must run first");
  }

  const child = fork(
    path.resolve(__dirname, "../../../server/src/server/test-utils/outdated-daemon-process.ts"),
    {
      env: {
        ...process.env,
        E2E_METRO_PORT: metroPort,
        E2E_DESKTOP_MANAGED: options?.desktopManaged === true ? "1" : "0",
      },
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const stderr: string[] = [];
  child.stderr?.on("data", (data: Buffer) => stderr.push(data.toString("utf8")));

  try {
    const ready = await waitForDaemon(child, stderr);
    return {
      endpoint: ready.endpoint,
      label: options?.desktopManaged === true ? "outdated Desktop host" : "outdated host",
      serverId: ready.serverId,
      async close() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        await once(child, "exit");
      },
    };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

async function waitForDaemon(
  child: ChildProcess,
  stderr: string[],
): Promise<OutdatedDaemonReadyMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out starting outdated daemon. ${stderr.join("")}`));
    }, 20_000);

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Outdated daemon exited before startup (code ${String(code)}, signal ${String(signal)}). ${stderr.join("")}`,
        ),
      );
    });
    child.once("message", (message: OutdatedDaemonMessage) => {
      if (message.type === "error") {
        clearTimeout(timeout);
        reject(new Error(message.error));
        return;
      }
      clearTimeout(timeout);
      resolve(message);
    });
  });
}
