import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chromium, type BrowserContext } from "playwright-core";

interface InteractiveBrowser {
  context: BrowserContext;
  close: () => Promise<void>;
}

// A fixed nonzero port lets Chrome start normally; port 0 and the pipe transport
// switch Chrome into its automation launch mode. CDP stays on loopback.
async function availableDebugPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No browser debugging port available");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

function waitForEndpoint(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => finish(new Error("Chrome did not start within 20 seconds")),
      20_000,
    );
    function finish(error: Error | null, endpoint?: string) {
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.stdout?.off("data", onData);
      child.stderr?.resume();
      child.stdout?.resume();
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(endpoint!);
    }
    function onError(error: Error) {
      finish(error);
    }
    function onExit() {
      finish(new Error(`Chrome could not start. ${output.trim()}`));
    }
    function onData(chunk: Buffer) {
      output = (output + chunk.toString()).slice(-4096);
      const match = output.match(
        /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/,
      );
      if (match) finish(null, match[1]);
    }
    child.stderr?.on("data", onData);
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function signalBrowser(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function launchInteractiveBrowser(input: {
  executablePath: string;
  userDataDir: string;
}): Promise<InteractiveBrowser> {
  const port = await availableDebugPort();
  const args = [
    `--user-data-dir=${input.userDataDir}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "about:blank",
  ];
  const needsDisplay = process.platform === "linux";
  // xvfb-run supplies a private Xauthority cookie and removes it on exit.
  const command = needsDisplay ? "xvfb-run" : input.executablePath;
  const launchArgs = needsDisplay
    ? ["-a", "-s", "-screen 0 1920x1080x24 -nolisten tcp", input.executablePath, ...args]
    : args;
  const child = spawn(command, launchArgs, {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const onProcessExit = () => signalBrowser(child, "SIGTERM");
  process.once("exit", onProcessExit);
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= (async () => {
      signalBrowser(child, "SIGTERM");
      const timer = setTimeout(() => signalBrowser(child, "SIGKILL"), 5_000);
      await exited;
      clearTimeout(timer);
      process.off("exit", onProcessExit);
    })();
    return stopping;
  }
  try {
    const endpoint = await waitForEndpoint(child);
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 20_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome did not expose its persistent profile");
    let closing = false;
    browser.once("disconnected", () => {
      if (!closing) void stop();
    });
    return {
      context,
      close: async () => {
        closing = true;
        // Closing a CDP connection only detaches; ask Chrome to flush its profile.
        const session = await browser.newBrowserCDPSession().catch(() => null);
        await session?.send("Browser.close").catch(() => undefined);
        const timer = setTimeout(() => signalBrowser(child, "SIGKILL"), 5_000);
        await exited;
        clearTimeout(timer);
        await stop();
      },
    };
  } catch (error) {
    await stop();
    if (needsDisplay && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "The remote browser needs a display. Install xvfb and xauth on this Linux host.",
        { cause: error },
      );
    }
    throw error;
  }
}
