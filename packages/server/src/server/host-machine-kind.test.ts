import { describe, expect, test } from "vitest";
import {
  detectHostMachineKind,
  machineKindFromAppleProductName,
  machineKindFromDmi,
  machineKindFromLinuxSignals,
  type LinuxMachineSignals,
} from "./host-machine-kind.js";

const BARE_METAL: LinuxMachineSignals = {
  inContainer: false,
  kernelRelease: "6.8.0-45-generic",
  deviceTreeModel: null,
  chassisType: null,
  sysVendor: null,
  productName: null,
};

describe("machineKindFromAppleProductName", () => {
  test.each([
    ["MacBook Pro (14-inch, 2024)", "laptop"],
    ["MacBookAir10,1", "laptop"],
    ["Mac mini (2024)", "desktop"],
    ["Macmini8,1", "desktop"],
    ["iMac24,1", "desktop"],
    ["Mac Studio (2025)", "workstation"],
    ["MacPro7,1", "workstation"],
    ["VirtualMac2,1", null],
  ])("%s -> %s", (name, kind) => {
    expect(machineKindFromAppleProductName(name)).toBe(kind);
  });
});

describe("machineKindFromDmi", () => {
  test("reads a VM as cloud whatever chassis the hypervisor reports", () => {
    expect(
      machineKindFromDmi({ chassisType: "1", sysVendor: "QEMU", productName: "Standard PC" }),
    ).toBe("cloud");
    expect(
      machineKindFromDmi({ chassisType: "23", sysVendor: "Hetzner", productName: "vServer" }),
    ).toBe("cloud");
  });

  test("maps the SMBIOS chassis type", () => {
    const kind = (chassisType: string) =>
      machineKindFromDmi({ chassisType, sysVendor: "Dell Inc.", productName: "Precision" });
    expect(kind("10")).toBe("laptop");
    expect(kind("3")).toBe("desktop");
    expect(kind("7")).toBe("workstation");
    expect(kind("23")).toBe("server");
    expect(kind("2")).toBeNull();
  });

  test("keeps Apple hardware running Linux as its Mac kind", () => {
    expect(
      machineKindFromDmi({ chassisType: null, sysVendor: "Apple Inc.", productName: "Mac mini" }),
    ).toBe("desktop");
  });
});

describe("machineKindFromLinuxSignals", () => {
  test("a container wins over the host hardware under it", () => {
    expect(
      machineKindFromLinuxSignals({ ...BARE_METAL, inContainer: true, chassisType: "10" }),
    ).toBe("container");
  });

  test("WSL reads as a desktop, not the Hyper-V VM it presents as", () => {
    expect(
      machineKindFromLinuxSignals({
        ...BARE_METAL,
        kernelRelease: "5.15.153.1-microsoft-standard-WSL2",
        sysVendor: "Microsoft Corporation",
        productName: "Virtual Machine",
      }),
    ).toBe("desktop");
  });

  test("names a single-board computer from its device tree", () => {
    expect(
      machineKindFromLinuxSignals({
        ...BARE_METAL,
        deviceTreeModel: "Raspberry Pi 5 Model B Rev 1.0",
      }),
    ).toBe("board");
  });

  test("falls through to DMI on ordinary hardware", () => {
    expect(machineKindFromLinuxSignals({ ...BARE_METAL, chassisType: "9" })).toBe("laptop");
    expect(machineKindFromLinuxSignals(BARE_METAL)).toBeNull();
  });
});

test("reports no signal on a platform it does not probe", async () => {
  await expect(detectHostMachineKind("win32")).resolves.toBeNull();
});
