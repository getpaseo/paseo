import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type HostMachineKind =
  | "laptop"
  | "desktop"
  | "mini"
  | "workstation"
  | "cloud"
  | "container"
  | "board"
  | "server";

const PROBE_TIMEOUT_MS = 1_500;

export function classifyMacModel(model: string | null | undefined): HostMachineKind | null {
  const normalized = model?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  if (normalized.includes("macbook")) return "laptop";
  if (normalized.includes("macmini") || normalized.includes("mac mini")) return "mini";
  if (normalized.includes("imac")) return "desktop";
  if (
    normalized.includes("macstudio") ||
    normalized.includes("mac studio") ||
    normalized.includes("macpro") ||
    normalized.includes("mac pro")
  ) {
    return "workstation";
  }
  return null;
}

export interface LinuxMachineProbeInput {
  hasContainerMarker: boolean;
  procVersion: string | null;
  deviceTreeModel: string | null;
  sysVendor: string | null;
  productName: string | null;
  biosVendor: string | null;
  boardVendor: string | null;
  chassisType: string | null;
}

const BOARD_PATTERNS = [
  "raspberry pi",
  "orange pi",
  "banana pi",
  "rock pi",
  "jetson",
  "beaglebone",
  "odroid",
  "pine64",
  "radxa",
] as const;

const CLOUD_OR_VM_MARKERS = [
  "amazon",
  "aws",
  "ec2",
  "google",
  "gce",
  "digitalocean",
  "hetzner",
  "linode",
  "akamai",
  "vultr",
  "ovh",
  "scaleway",
  "oracle",
  "qemu",
  "kvm",
  "vmware",
  "virtualbox",
  "xen",
  "bochs",
  "parallels",
  "proxmox",
  "hyper-v",
  "virtual machine",
  "openstack",
  "upcloud",
  "fly.io",
] as const;

const LAPTOP_CHASSIS_TYPES = new Set([8, 9, 10, 11, 14, 30, 31, 32]);
const DESKTOP_CHASSIS_TYPES = new Set([3, 4, 5, 6, 7, 13, 15, 16]);
const SERVER_CHASSIS_TYPES = new Set([17, 23, 25, 28, 29]);

export function classifyLinuxMachine(input: LinuxMachineProbeInput): HostMachineKind | null {
  if (input.hasContainerMarker) {
    return "container";
  }

  const procVersion = input.procVersion?.toLowerCase() ?? "";
  if (procVersion.includes("microsoft") || procVersion.includes("wsl")) {
    return "desktop";
  }

  const deviceTree = input.deviceTreeModel?.toLowerCase() ?? "";
  if (deviceTree && BOARD_PATTERNS.some((pattern) => deviceTree.includes(pattern))) {
    return "board";
  }

  const dmiText = [input.sysVendor, input.productName, input.biosVendor, input.boardVendor]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  if (dmiText && CLOUD_OR_VM_MARKERS.some((marker) => dmiText.includes(marker))) {
    return "cloud";
  }

  const chassis = Number.parseInt(input.chassisType?.trim() ?? "", 10);
  if (Number.isInteger(chassis)) {
    if (LAPTOP_CHASSIS_TYPES.has(chassis)) return "laptop";
    if (chassis === 35) return "mini";
    if (DESKTOP_CHASSIS_TYPES.has(chassis)) return "desktop";
    if (SERVER_CHASSIS_TYPES.has(chassis)) return "server";
  }

  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readTrimmedFile(path: string): Promise<string | null> {
  try {
    const content = (await readFile(path, "utf8")).replaceAll("\u0000", "").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export function parseMacIoregProductName(output: string): string | null {
  const productMatch = output.match(/"product-name"\s*=\s*<"([^"]+)">/i);
  if (productMatch?.[1]?.trim()) {
    return productMatch[1].trim();
  }
  const modelMatch = output.match(/"model"\s*=\s*<"([^"]+)">/i);
  return modelMatch?.[1]?.trim() ?? null;
}

async function readMacModel(): Promise<string | null> {
  // Apple Silicon Macs report generic "Mac15,6" in sysctl hw.model, while IOPlatformExpertDevice
  // exposes the human product name ("MacBook Pro", "Mac mini", "Mac Studio", etc.).
  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/ioreg",
      ["-rd1", "-c", "IOPlatformExpertDevice"],
      {
        encoding: "utf8",
        timeout: PROBE_TIMEOUT_MS,
      },
    );
    const parsed = parseMacIoregProductName(stdout);
    if (parsed && classifyMacModel(parsed)) {
      return parsed;
    }
  } catch {
    // Fall back to sysctl below.
  }

  try {
    const { stdout } = await execFileAsync("/usr/sbin/sysctl", ["-n", "hw.model"], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
    });
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

export async function detectHostMachineKind(
  platform: NodeJS.Platform = process.platform,
): Promise<HostMachineKind | null> {
  if (platform === "darwin") {
    return classifyMacModel(await readMacModel());
  }
  if (platform === "linux") {
    const [
      hasDockerEnv,
      hasContainerEnv,
      procVersion,
      deviceTreeModel,
      sysVendor,
      productName,
      biosVendor,
      boardVendor,
      chassisType,
    ] = await Promise.all([
      fileExists("/.dockerenv"),
      fileExists("/run/.containerenv"),
      readTrimmedFile("/proc/version"),
      readTrimmedFile("/proc/device-tree/model"),
      readTrimmedFile("/sys/class/dmi/id/sys_vendor"),
      readTrimmedFile("/sys/class/dmi/id/product_name"),
      readTrimmedFile("/sys/class/dmi/id/bios_vendor"),
      readTrimmedFile("/sys/class/dmi/id/board_vendor"),
      readTrimmedFile("/sys/class/dmi/id/chassis_type"),
    ]);
    return classifyLinuxMachine({
      hasContainerMarker: hasDockerEnv || hasContainerEnv,
      procVersion,
      deviceTreeModel,
      sysVendor,
      productName,
      biosVendor,
      boardVendor,
      chassisType,
    });
  }
  return null;
}

let cachedMachineKind: HostMachineKind | null | undefined;
let pendingMachineKind: Promise<HostMachineKind | null> | null = null;

export function primeHostMachineKind(): Promise<HostMachineKind | null> {
  if (cachedMachineKind !== undefined) {
    return Promise.resolve(cachedMachineKind);
  }
  if (!pendingMachineKind) {
    pendingMachineKind = detectHostMachineKind()
      .then((kind) => {
        cachedMachineKind = kind;
        return kind;
      })
      .catch(() => {
        cachedMachineKind = null;
        return null;
      });
  }
  return pendingMachineKind;
}

export function getCachedHostMachineKind(): HostMachineKind | null {
  return cachedMachineKind ?? null;
}
