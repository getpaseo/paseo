import { describe, expect, it } from "vitest";
import {
  classifyLinuxMachine,
  classifyMacModel,
  parseMacIoregProductName,
  type LinuxMachineProbeInput,
} from "./host-machine-kind";

function linuxProbe(overrides: Partial<LinuxMachineProbeInput> = {}): LinuxMachineProbeInput {
  return {
    hasContainerMarker: false,
    procVersion: null,
    deviceTreeModel: null,
    sysVendor: null,
    productName: null,
    biosVendor: null,
    boardVendor: null,
    chassisType: null,
    ...overrides,
  };
}

describe("classifyMacModel", () => {
  it.each([
    ["MacBookPro18,3", "laptop"],
    ["MacBookAir10,1", "laptop"],
    ["Macmini9,1", "mini"],
    ["iMac21,1", "desktop"],
    ["MacStudio1,1", "workstation"],
    ["MacPro7,1", "workstation"],
    ["Mac15,6", null],
    ["", null],
    [null, null],
  ] as const)("maps %s to %s", (model, expected) => {
    expect(classifyMacModel(model)).toBe(expected);
  });

  it("extracts Apple Silicon product-name from ioreg output", () => {
    const ioreg = `
      "model" = <"Mac15,6">
      "product-name" = <"MacBook Pro">
    `;
    expect(classifyMacModel(parseMacIoregProductName(ioreg))).toBe("laptop");
  });
});

describe("classifyLinuxMachine", () => {
  it("detects containers before VM or chassis markers", () => {
    expect(
      classifyLinuxMachine(
        linuxProbe({ hasContainerMarker: true, sysVendor: "Hetzner", chassisType: "17" }),
      ),
    ).toBe("container");
  });

  it("detects WSL as desktop", () => {
    expect(
      classifyLinuxMachine(
        linuxProbe({ procVersion: "Linux version 5.15.153.1-microsoft-standard-WSL2" }),
      ),
    ).toBe("desktop");
  });

  it("detects single-board PCs from device-tree model", () => {
    expect(
      classifyLinuxMachine(linuxProbe({ deviceTreeModel: "Raspberry Pi 5 Model B Rev 1.0" })),
    ).toBe("board");
  });

  it("detects cloud VMs and hypervisors from DMI metadata", () => {
    expect(classifyLinuxMachine(linuxProbe({ sysVendor: "Hetzner", productName: "vServer" }))).toBe(
      "cloud",
    );
    expect(classifyLinuxMachine(linuxProbe({ sysVendor: "Amazon EC2" }))).toBe("cloud");
    expect(classifyLinuxMachine(linuxProbe({ biosVendor: "QEMU" }))).toBe("cloud");
  });

  it("classifies bare-metal Linux machines by SMBIOS chassis type", () => {
    expect(classifyLinuxMachine(linuxProbe({ sysVendor: "LENOVO", chassisType: "10" }))).toBe(
      "laptop",
    );
    expect(classifyLinuxMachine(linuxProbe({ sysVendor: "ASUS", chassisType: "35" }))).toBe("mini");
    expect(classifyLinuxMachine(linuxProbe({ sysVendor: "Dell Inc.", chassisType: "3" }))).toBe(
      "desktop",
    );
    expect(classifyLinuxMachine(linuxProbe({ sysVendor: "Supermicro", chassisType: "23" }))).toBe(
      "server",
    );
  });

  it("returns null when no marker matches", () => {
    expect(classifyLinuxMachine(linuxProbe())).toBeNull();
  });
});
