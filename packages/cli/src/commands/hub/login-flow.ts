import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { CliAuthorizationPoll, HubHttpClient } from "./hub-client/index.js";

export interface LoginWaiter {
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

interface CliLoginFlowOptions {
  hub: Pick<HubHttpClient, "startCliAuthorization" | "pollCliAuthorization">;
  waiter: LoginWaiter;
  browser: BrowserOpener;
  instructions(verificationUri: string, userCode: string): void;
  openBrowser: boolean;
}

export class CliLoginFlow {
  constructor(private readonly options: CliLoginFlowOptions) {}

  async authorize(origin: string): Promise<string> {
    const authorization = await this.options.hub.startCliAuthorization(origin);
    this.options.instructions(authorization.verificationUri, authorization.userCode);
    if (this.options.openBrowser) {
      await this.options.browser.open(authorization.verificationUriComplete).catch(() => undefined);
    }
    let interval = authorization.interval;
    const expiresAt = Date.parse(authorization.expiresAt);
    while (true) {
      const remaining = expiresAt - this.options.waiter.now();
      if (remaining <= 0) throw new Error("Hub CLI login expired");
      await this.options.waiter.wait(Math.min(interval * 1_000, remaining));
      const pollLifetime = expiresAt - this.options.waiter.now();
      if (pollLifetime <= 0) throw new Error("Hub CLI login expired");
      const outcome = await this.options.hub.pollCliAuthorization(
        origin,
        authorization.deviceCode,
        pollLifetime,
      );
      const credential = approvedCredential(outcome);
      if (credential !== null) return credential;
      if (outcome.status === "denied") throw new Error("Hub CLI login was denied");
      if (outcome.status === "expired") throw new Error("Hub CLI login expired");
      if (outcome.status === "disclosed") throw new Error("Hub CLI login was already completed");
      if (outcome.status !== "retry_later") interval = outcome.interval;
    }
  }
}

export function createCliLoginFlow(hub: HubHttpClient): CliLoginFlow {
  return new CliLoginFlow({
    hub,
    waiter: {
      wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      now: Date.now,
    },
    browser: new SystemBrowser(),
    instructions(verificationUri, userCode) {
      process.stderr.write(`Open ${verificationUri} and enter code ${userCode}\n`);
    },
    openBrowser: process.stderr.isTTY === true,
  });
}

function approvedCredential(outcome: CliAuthorizationPoll): string | null {
  return outcome.status === "authorized" ? outcome.credential : null;
}

async function launchDetached(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, shell: false, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}
