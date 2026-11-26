import { describe, expect, test } from "vitest";
import {
  createOsSocketOwnerVerifier,
  findDarwinLoopbackSocketUid,
  findLinuxLoopbackSocketUid,
  parseWindowsLoopbackSocketOwner,
} from "./socket-owner.js";

describe("OS loopback socket owner verification", () => {
  test("parses Linux /proc/net/tcp for matching 127.0.0.1 client->server connection UID", () => {
    // 127.0.0.1 in little-endian hex is 0100007F.
    // clientPort = 45678 = 0xB26E, serverPort = 1080 = 0x0438
    const sample = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:0438 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0",
      "   1: 0100007F:B26E 0100007F:0438 01 00000000:00000000 00:00000000 00000000  1001        0 12346 1 0000000000000000 20 4 30 10 -1",
      "   2: 0100007F:0438 0100007F:B26E 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1 0000000000000000 20 4 30 10 -1",
    ].join("\n");

    expect(findLinuxLoopbackSocketUid(sample, 45678, 1080)).toBe(1001);
    expect(findLinuxLoopbackSocketUid(sample, 45679, 1080)).toBeNull();
  });

  test("parses macOS lsof machine-readable output for client UID", () => {
    const sample = ["p1234", "u501", "f12", "n127.0.0.1:45678->127.0.0.1:1080"].join("\n");
    expect(findDarwinLoopbackSocketUid(sample, 45678, 1080)).toBe(501);
    expect(findDarwinLoopbackSocketUid(sample, 45679, 1080)).toBeNull();
  });

  test("parses Windows PowerShell owner SID output", () => {
    expect(parseWindowsLoopbackSocketOwner("S-1-5-21-100-200-300-1001\r\n")).toBe(
      "S-1-5-21-100-200-300-1001",
    );
    expect(parseWindowsLoopbackSocketOwner("   \n")).toBeNull();
  });

  test("admits matching UID and rejects foreign UID or lookup failure on Linux", async () => {
    const procContent = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   1: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 12346",
      "   2: 0100007F:C351 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  2000        0 12347",
    ].join("\n");

    const verify = createOsSocketOwnerVerifier({
      platform: "linux",
      getCurrentUid: () => 1000,
      readFile: async () => procContent,
    });

    // 0xC350 = 50000, 0xC351 = 50001, 0x1F90 = 8080
    expect(await verify({ clientPort: 50000, serverPort: 8080 })).toBe(true);
    expect(await verify({ clientPort: 50001, serverPort: 8080 })).toBe(false);
    expect(await verify({ clientPort: 50002, serverPort: 8080 })).toBe(false);

    const failingVerify = createOsSocketOwnerVerifier({
      platform: "linux",
      getCurrentUid: () => 1000,
      readFile: async () => {
        throw new Error("EACCES");
      },
    });
    expect(await failingVerify({ clientPort: 50000, serverPort: 8080 })).toBe(false);
  });

  test("admits matching SID and rejects foreign SID on Windows", async () => {
    const verify = createOsSocketOwnerVerifier({
      platform: "win32",
      execFile: async (_cmd, args) => {
        const script = args.join(" ");
        if (script.includes("GetCurrent")) {
          return { stdout: "S-1-5-21-1-2-3-1000\r\n" };
        }
        if (script.includes("50000")) {
          return { stdout: "S-1-5-21-1-2-3-1000\r\n" };
        }
        return { stdout: "S-1-5-21-1-2-3-9999\r\n" };
      },
    });

    expect(await verify({ clientPort: 50000, serverPort: 8080 })).toBe(true);
    expect(await verify({ clientPort: 50001, serverPort: 8080 })).toBe(false);
  });
});
