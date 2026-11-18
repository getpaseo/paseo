import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  addResourceOptions,
  formatResourcePolicy,
  formatResourceStatus,
  parseResourcePatch,
  parseResourcePolicy,
  type ResourceOptions,
} from "./resource-options.js";

function parseFlags(argv: string[], clearable = false): ResourceOptions {
  const command = addResourceOptions(new Command("run").exitOverride(), { clearable });
  command.parse(argv, { from: "user" });
  return command.opts<ResourceOptions>();
}

describe("resource flags", () => {
  it("builds a policy from the flags given and nothing else", () => {
    expect(
      parseResourcePolicy(
        parseFlags([
          "--nice",
          "10",
          "--cpu-quota",
          "150",
          "--memory-max",
          "4096",
          "--cpus",
          "0-2,6",
        ]),
      ),
    ).toEqual({ nice: 10, cpuQuotaPercent: 150, memoryMaxMb: 4096, allowedCpus: [0, 1, 2, 6] });
    expect(parseResourcePolicy(parseFlags([]))).toBeUndefined();
  });

  it("names the flag that holds a bad value", () => {
    expect(() => parseResourcePolicy({ nice: "20" })).toThrow(
      expect.objectContaining({
        code: "INVALID_RESOURCE_POLICY",
        message: expect.stringMatching(/^--nice: /),
      }),
    );
    expect(() => parseResourcePolicy({ memoryMax: "4G" })).toThrow(
      expect.objectContaining({ message: "--memory-max must be a whole number" }),
    );
    expect(() => parseResourcePolicy({ cpus: "3-1" })).toThrow(
      expect.objectContaining({ message: "--cpus has a descending range: 3-1" }),
    );
    expect(() => parseResourcePolicy({ cpus: "a,b" })).toThrow(
      expect.objectContaining({ message: "--cpus must be a CPU list such as 0-3,6" }),
    );
  });

  it('reads "none" as removing a control when updating', () => {
    expect(
      parseResourcePatch(parseFlags(["--nice", "none", "--memory-high", "512"], true)),
    ).toEqual({ nice: null, memoryHighMb: 512 });
  });

  it("formats a policy the way the flags spell it", () => {
    expect(
      formatResourcePolicy({
        nice: 10,
        cpuQuotaPercent: 50,
        memoryMaxMb: 2048,
        allowedCpus: [3, 0, 1, 2, 7],
      }),
    ).toBe("nice=10 cpu-quota=50% memory-max=2048 MiB cpus=0-3,7");
    expect(formatResourcePolicy(undefined)).toBe("-");
  });

  it("rejects CPU numbers past the kernel's limit before expanding a range", () => {
    for (const cpus of ["0-1000000000", "9007199254740992", "1024"]) {
      expect(() => parseResourcePolicy({ cpus })).toThrow(
        expect.objectContaining({ message: "--cpus CPUs must be between 0 and 1023" }),
      );
    }
    expect(() => parseResourcePolicy({ cpus: Array(1000).fill("0-1023").join(",") })).toThrow(
      expect.objectContaining({ message: "--cpus lists more than 1024 CPUs" }),
    );
    expect(parseResourcePolicy({ cpus: "1020-1023" })).toEqual({
      allowedCpus: [1020, 1021, 1022, 1023],
    });
  });

  it("shows a limit whose removal the host refused, even with no policy left", () => {
    expect(
      formatResourceStatus(null, {
        backend: "systemd",
        active: true,
        unit: "paseo.slice",
        cgroup: "/sys/fs/cgroup/paseo.slice",
        controls: {
          nice: {
            state: "denied",
            actual: 15,
            message: "Removing this control failed: no privilege",
          },
        },
      }),
    ).toBe("nice=none (denied: Removing this control failed: no privilege)");
    expect(formatResourceStatus(null, null)).toBe("-");
  });
});
