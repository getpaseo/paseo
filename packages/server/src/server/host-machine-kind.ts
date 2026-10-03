import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";

/**
 * The machine kinds the daemon can guess from its hardware. Each one names a host icon in the
 * app; the app owns the full icon list and treats anything it doesn't know as a plain server.
 */
export type HostMachineKind =
  | "server"
  | "cloud"
  | "desktop"
  | "laptop"
  | "workstation"
  | "board"
  | "container";

const DMI_ROOT = "/sys/class/dmi/id";
const PROBE_TIMEOUT_MS = 2_000;

// SMBIOS 3.x System Enclosure types (table 17). Codes that describe a shape rather than a
// machine (docking stations, blade enclosures, IoT gateways) fall through to null on purpose.
const DMI_CHASSIS_KINDS: Readonly<Record<string, HostMachineKind>> = {
  "3": "desktop", // Desktop
  "4": "desktop", // Low Profile Desktop
  "5": "desktop", // Pizza Box
  "6": "desktop", // Mini Tower
  "7": "workstation", // Tower
  "8": "laptop", // Portable
  "9": "laptop", // Laptop
  "10": "laptop", // Notebook
  "13": "desktop", // All in One
  "14": "laptop", // Sub Notebook
  "15": "desktop", // Space-saving
  "16": "desktop", // Lunch Box
  "17": "server", // Main Server Chassis
  "18": "server", // Expansion Chassis
  "19": "server", // SubChassis
  "20": "server", // Bus Expansion Chassis
  "21": "server", // Peripheral Chassis
  "22": "server", // RAID Chassis
  "23": "server", // Rack Mount Chassis
  "24": "server", // Sealed-case PC
  "28": "server", // Blade
  "31": "laptop", // Convertible
  "32": "laptop", // Detachable
  "35": "desktop", // Mini PC
};

// Hypervisors and cloud providers write themselves into the DMI vendor or product strings; any
// hit means the box is a VM, and a VM reads as "cloud" whatever chassis the hypervisor fakes.
// Hyper-V is matched on its "Virtual Machine" product, not the "Microsoft Corporation" vendor
// that physical Surface devices share.
const VIRTUALIZATION_MARKERS = [
  "qemu",
  "kvm",
  "bochs",
  "vmware",
  "virtualbox",
  "innotek",
  "xen",
  "parallels",
  "amazon ec2",
  "google compute engine",
  "digitalocean",
  "hetzner",
  "linode",
  "vultr",
  "scaleway",
  "openstack",
  "cloud",
  "virtual machine",
];

const SINGLE_BOARD_MARKERS = ["raspberry pi", "jetson", "rock pi", "orange pi", "odroid", "pine64"];

/** Marketing names ("Mac mini (2024)") and Intel-era model ids ("Macmini8,1") share prefixes. */
export function machineKindFromAppleProductName(name: string): HostMachineKind | null {
  const normalized = name.trim().toLowerCase().replaceAll(/\s+/g, "");
  if (normalized.startsWith("macbook")) return "laptop";
  if (normalized.startsWith("macstudio") || normalized.startsWith("macpro")) return "workstation";
  if (normalized.startsWith("macmini") || normalized.startsWith("imac")) return "desktop";
  return null;
}

export function machineKindFromDmi(input: {
  chassisType: string | null;
  sysVendor: string | null;
  productName: string | null;
}): HostMachineKind | null {
  const productName = input.productName ?? "";
  const vendorAndProduct = `${input.sysVendor ?? ""} ${productName}`.toLowerCase();
  if (VIRTUALIZATION_MARKERS.some((marker) => vendorAndProduct.includes(marker))) {
    return "cloud";
  }
  // Apple hardware booting Linux (Asahi) still reports the Apple product name.
  const appleKind = machineKindFromAppleProductName(productName);
  if (appleKind !== null) {
    return appleKind;
  }
  return input.chassisType === null ? null : (DMI_CHASSIS_KINDS[input.chassisType] ?? null);
}

export interface LinuxMachineSignals {
  inContainer: boolean;
  kernelRelease: string | null;
  deviceTreeModel: string | null;
  chassisType: string | null;
  sysVendor: string | null;
  productName: string | null;
}

export function machineKindFromLinuxSignals(signals: LinuxMachineSignals): HostMachineKind | null {
  // A container's DMI files describe the machine under it, not the thing the daemon runs in.
  if (signals.inContainer) {
    return "container";
  }
  // WSL exposes Microsoft in its kernel release on both WSL 1 and WSL 2. Check it before DMI
  // because WSL 2 presents as a Hyper-V VM, which would otherwise read as a cloud VM.
  if (signals.kernelRelease?.toLowerCase().includes("microsoft")) {
    return "desktop";
  }
  // ARM boards have no DMI; the device tree names the board instead.
  const model = signals.deviceTreeModel?.toLowerCase() ?? "";
  if (SINGLE_BOARD_MARKERS.some((marker) => model.includes(marker))) {
    return "board";
  }
  return machineKindFromDmi(signals);
}

function normalize(value: string | null | undefined): string | null {
  // Device-tree strings end in a NUL byte.
  const trimmed = value?.replaceAll("\0", "").trim();
  return trimmed ? trimmed : null;
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return normalize(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runProbe(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : normalize(stdout));
    });
  });
}

// IOKit's `product` node carries the marketing name on Apple silicon; Intel Macs lack it, so
// `hw.model` is the fallback. Both are single-digit-millisecond calls.
async function detectDarwinMachineKind(): Promise<HostMachineKind | null> {
  const ioreg = await runProbe("ioreg", ["-rd1", "-n", "product"]);
  const productName = ioreg?.match(/"product-name"\s*=\s*<"([^"]+)">/)?.[1] ?? null;
  const fromProductName =
    productName === null ? null : machineKindFromAppleProductName(productName);
  if (fromProductName !== null) {
    return fromProductName;
  }
  const model = await runProbe("sysctl", ["-n", "hw.model"]);
  return model === null ? null : machineKindFromAppleProductName(model);
}

async function detectLinuxMachineKind(): Promise<HostMachineKind | null> {
  const [
    dockerEnv,
    podmanEnv,
    kernelRelease,
    deviceTreeModel,
    chassisType,
    sysVendor,
    productName,
  ] = await Promise.all([
    fileExists("/.dockerenv"),
    fileExists("/run/.containerenv"),
    readOptionalFile("/proc/sys/kernel/osrelease"),
    readOptionalFile("/proc/device-tree/model"),
    readOptionalFile(`${DMI_ROOT}/chassis_type`),
    readOptionalFile(`${DMI_ROOT}/sys_vendor`),
    readOptionalFile(`${DMI_ROOT}/product_name`),
  ]);
  return machineKindFromLinuxSignals({
    inContainer: dockerEnv || podmanEnv,
    kernelRelease,
    deviceTreeModel,
    chassisType,
    sysVendor,
    productName,
  });
}

/**
 * Best-effort guess at what kind of machine the daemon runs on, for the host's default icon.
 * Every probe may fail: null means "no signal", and the app draws a plain server until the user
 * picks an icon.
 */
export async function detectHostMachineKind(
  platform: NodeJS.Platform = process.platform,
): Promise<HostMachineKind | null> {
  try {
    switch (platform) {
      case "darwin":
        return await detectDarwinMachineKind();
      case "linux":
        return await detectLinuxMachineKind();
      default:
        return null;
    }
  } catch {
    return null;
  }
}
