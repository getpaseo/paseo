import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Initialize a new enhanced home without changing any existing daemon settings. */
export async function initializeEnhancedDaemonHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ daemon: { listen: "127.0.0.1:6791" } }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
