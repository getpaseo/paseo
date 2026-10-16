import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// The existing provider hooks own the card; use their source and native session id.
export async function endVibeIslandSession(
  source: { provider: string; sessionId: string; cwd: string },
  bridge = path.join(homedir(), ".vibe-island", "bin", "vibe-island-bridge"),
): Promise<void> {
  try {
    try {
      await access(bridge, constants.X_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await new Promise<void>((resolve) => {
      const child = execFile(
        bridge,
        ["--source", source.provider],
        {
          timeout: 2000,
          killSignal: "SIGKILL",
          maxBuffer: 16384,
          windowsHide: true,
        },
        (error) => {
          if (error) console.warn("[paseo-workflow] Vibe Island SessionEnd failed", error);
          resolve();
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(
        JSON.stringify({
          hook_event_name: "SessionEnd",
          session_id: source.sessionId,
          cwd: source.cwd,
        }),
      );
    });
  } catch (error) {
    console.warn("[paseo-workflow] Vibe Island SessionEnd failed", error);
  }
}
