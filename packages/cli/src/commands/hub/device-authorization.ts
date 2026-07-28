import { spawn } from "node:child_process";
import { platform } from "node:os";
import {
  CloudDeviceAuthorizationClient,
  type CloudDeviceAuthorization,
} from "./cloud-device-authorization.js";

export interface AuthorizationWaiter {
  wait(milliseconds: number): Promise<void>;
  now(): number;
}

export interface BrowserOpener {
  open(url: string): Promise<void>;
}

type BrowserLaunch = (command: string, args: string[]) => Promise<void>;

interface SystemBrowserOptions {
  hostPlatform?: NodeJS.Platform;
  launch?: BrowserLaunch;
}

export class SystemBrowser implements BrowserOpener {
  private readonly hostPlatform: NodeJS.Platform;
  private readonly launch: BrowserLaunch;

  constructor(options: SystemBrowserOptions = {}) {
    this.hostPlatform = options.hostPlatform ?? platform();
    this.launch = options.launch ?? launchDetached;
  }

  async open(url: string): Promise<void> {
    if (this.hostPlatform === "win32") {
      await this.launch("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
      return;
    }

    await this.launch(this.hostPlatform === "darwin" ? "open" : "xdg-open", [url]);
  }
}

export interface AuthorizationReporter {
  instructions(verificationUri: string, userCode: string): void;
}

interface DeviceAuthorizationWorkflowOptions {
  cloud: CloudDeviceAuthorization;
  waiter: AuthorizationWaiter;
  browser: BrowserOpener;
  reporter: AuthorizationReporter;
  openBrowser?: boolean;
}

export class DeviceAuthorizationWorkflow {
  constructor(private readonly options: DeviceAuthorizationWorkflowOptions) {}

  async authorize(hubUrl: string, displayName: string): Promise<string> {
    const authorization = await this.options.cloud.start(hubUrl, displayName);
    this.options.reporter.instructions(authorization.verificationUri, authorization.userCode);
    if (this.options.openBrowser !== false) {
      await this.options.browser.open(authorization.verificationUriComplete).catch(() => undefined);
    }

    let interval = authorization.interval;
    const expiresAt = Date.parse(authorization.expiresAt);
    while (true) {
      const remaining = expiresAt - this.options.waiter.now();
      if (remaining <= 0) throw new Error("Daemon registration expired");
      await this.options.waiter.wait(Math.min(interval * 1_000, remaining));
      if (this.options.waiter.now() >= expiresAt) throw new Error("Daemon registration expired");
      const pollLifetime = expiresAt - this.options.waiter.now();
      if (pollLifetime <= 0) throw new Error("Daemon registration expired");
      const outcome = await this.options.cloud.poll(hubUrl, authorization.deviceCode, pollLifetime);
      if (this.options.waiter.now() >= expiresAt) throw new Error("Daemon registration expired");
      if (outcome.status === "retry_later") continue;
      interval = outcome.interval;
      if (outcome.status === "approved") return outcome.enrollmentToken;
      if (outcome.status === "denied") throw new Error("Daemon registration was denied");
      if (outcome.status === "expired") throw new Error("Daemon registration expired");
      if (outcome.status === "enrolled") {
        throw new Error("Daemon registration was already used");
      }
    }
  }
}

export function createDeviceAuthorizationWorkflow(): DeviceAuthorizationWorkflow {
  return new DeviceAuthorizationWorkflow({
    cloud: new CloudDeviceAuthorizationClient(),
    waiter: {
      wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      now: Date.now,
    },
    browser: new SystemBrowser(),
    reporter: {
      instructions(verificationUri, userCode) {
        process.stderr.write(`Open ${verificationUri} and enter code ${userCode}\n`);
      },
    },
    openBrowser: process.stderr.isTTY === true,
  });
}

async function launchDetached(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}
