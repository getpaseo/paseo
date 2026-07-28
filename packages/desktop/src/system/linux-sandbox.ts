import path from "node:path";

const REQUIRED_SANDBOX_MODE = 0o4755;
const PERMISSION_BITS = 0o7777;

interface SandboxMetadata {
  mode: number;
  uid: number;
}

interface LinuxSandboxConfiguration {
  platform: NodeJS.Platform;
  resourcesPath: string;
  statSandbox: (sandboxPath: string) => SandboxMetadata;
  disableSandbox: () => void;
  reportInspectionError: (error: unknown) => void;
}

function isMissingSandbox(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function configureLinuxSandbox(input: LinuxSandboxConfiguration): void {
  if (input.platform !== "linux") {
    return;
  }

  try {
    const sandboxPath = path.join(input.resourcesPath, "..", "chrome-sandbox");
    const sandbox = input.statSandbox(sandboxPath);
    const hasUsableSandbox =
      sandbox.uid === 0 && (sandbox.mode & PERMISSION_BITS) === REQUIRED_SANDBOX_MODE;

    if (!hasUsableSandbox) {
      input.disableSandbox();
    }
  } catch (error) {
    if (isMissingSandbox(error)) {
      input.disableSandbox();
      return;
    }

    input.reportInspectionError(error);
  }
}
