import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import * as pty from "node-pty";
import type { ProviderCliLoginSession } from "@getpaseo/protocol/provider-cli/rpc-schemas";

const OUTPUT_TAIL_CHARS = 8_000;
// Wide enough that CLIs never wrap a sign-in URL across lines.
const PTY_COLS = 1_000;
const PTY_ROWS = 40;
const URL_PATTERN = /https?:\/\/[^\s"'<>`]+/g;
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/;

function trimUrl(url: string): string {
  return url.replace(/[).,;:\]]+$/, "");
}

function isLoopbackUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(url);
}

/** The first remote sign-in URL; loopback callback URLs are useless from another device. */
export function extractLoginUrl(output: string): string | null {
  const urls = Array.from(output.matchAll(URL_PATTERN), (match) => trimUrl(match[0]));
  return urls.find((url) => !isLoopbackUrl(url)) ?? urls[0] ?? null;
}

export function extractDeviceCode(output: string): string | null {
  return DEVICE_CODE_PATTERN.exec(output.replace(URL_PATTERN, " "))?.[0] ?? null;
}

export function normalizePtyOutput(raw: string): string {
  return stripVTControlCharacters(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

export interface ProviderCliLoginProcessOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onExit: (status: ProviderCliLoginSession["status"]) => void;
}

/** One interactive sign-in run of a provider CLI inside a PTY. */
export class ProviderCliLoginProcess {
  private readonly process: pty.IPty;
  private readonly timeout: NodeJS.Timeout;
  private rawOutput = "";
  private state: ProviderCliLoginSession;

  constructor(private readonly options: ProviderCliLoginProcessOptions) {
    this.state = { status: "running", url: null, code: null, output: "", error: null };
    this.process = pty.spawn(options.command, options.args, {
      name: "xterm-256color",
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: homedir(),
      env: options.env,
    });
    this.process.onData((data) => this.handleData(data));
    this.process.onExit(({ exitCode }) => this.handleExit(exitCode));
    this.timeout = setTimeout(() => {
      this.finish("failed", "Sign-in timed out");
      this.process.kill();
    }, options.timeoutMs);
    this.timeout.unref();
  }

  snapshot(): ProviderCliLoginSession {
    return { ...this.state };
  }

  get isRunning(): boolean {
    return this.state.status === "running";
  }

  write(text: string): void {
    if (!this.isRunning) throw new Error("Sign-in is no longer running");
    this.process.write(`${text}\r`);
  }

  cancel(): void {
    if (!this.isRunning) return;
    this.finish("canceled", null);
    this.process.kill();
  }

  private handleData(data: string): void {
    this.rawOutput = (this.rawOutput + data).slice(-OUTPUT_TAIL_CHARS * 2);
    const output = normalizePtyOutput(this.rawOutput).slice(-OUTPUT_TAIL_CHARS);
    this.state = {
      ...this.state,
      output,
      url: this.state.url ?? extractLoginUrl(output),
      code: this.state.code ?? extractDeviceCode(output),
    };
  }

  private handleExit(exitCode: number): void {
    if (!this.isRunning) return;
    if (exitCode === 0) {
      this.finish("succeeded", null);
      return;
    }
    this.finish("failed", `Sign-in exited with code ${exitCode}`);
  }

  private finish(status: ProviderCliLoginSession["status"], error: string | null): void {
    if (!this.isRunning) return;
    clearTimeout(this.timeout);
    this.state = { ...this.state, status, error };
    this.options.onExit(status);
  }
}
