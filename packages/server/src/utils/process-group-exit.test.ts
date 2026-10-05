import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { detachedProcessGroup, terminateDetachedGroup } from "./process-group-exit.js";

test.skipIf(process.platform === "win32")(
  "termination observes exit of the actual detached provider process group",
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    await once(child, "spawn");
    try {
      const group = await detachedProcessGroup(child);
      expect(group).toBe(child.pid);
      const receipt = await terminateDetachedGroup(child, group!);
      expect(receipt.pid).toBe(child.pid);
      expect(receipt.processGroupId).toBe(child.pid);
      expect(receipt.signal).toBe("SIGTERM");
      expect(() => process.kill(-group!, 0)).toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  },
);
test.skipIf(process.platform === "win32")(
  "a non-detached process cannot acquire a group termination receipt",
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    try {
      expect(await detachedProcessGroup(child)).toBeNull();
    } finally {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  },
);
