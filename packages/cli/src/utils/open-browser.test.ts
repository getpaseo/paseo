import { describe, expect, it } from "vitest";

import { browserOpenCommand, openBrowserUrl } from "./open-browser.js";

describe("browserOpenCommand", () => {
  it("opens Windows URLs without cmd.exe shell parsing", () => {
    const url =
      "https://auth.openai.com/oauth/authorize?client_id=paseo&state=abc%20123&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback";

    expect(browserOpenCommand(url, "win32")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
  });

  it("keeps macOS opener behavior unchanged", () => {
    const url = "https://auth.openai.com/oauth/authorize?client_id=paseo&state=abc";

    expect(browserOpenCommand(url, "darwin")).toEqual({
      command: "open",
      args: [url],
    });
  });

  it("keeps Linux opener behavior unchanged", () => {
    const url = "https://auth.openai.com/oauth/authorize?client_id=paseo&state=abc";

    expect(browserOpenCommand(url, "linux")).toEqual({
      command: "xdg-open",
      args: [url],
    });
  });
});

describe("openBrowserUrl", () => {
  it("spawns the resolved opener without launching a real browser", () => {
    const spawned: Array<{
      command: string;
      args: string[];
      options: { stdio: "ignore"; detached: true };
    }> = [];
    const child = {
      on: () => child,
      unref: () => {},
    };

    const opened = openBrowserUrl(
      "https://auth.openai.com/oauth/authorize?client_id=paseo&state=abc",
      {
        platform: "win32",
        spawn: (command, args, options) => {
          spawned.push({ command, args, options });
          return child;
        },
      },
    );

    expect(opened).toBe(true);
    expect(spawned).toEqual([
      {
        command: "rundll32.exe",
        args: [
          "url.dll,FileProtocolHandler",
          "https://auth.openai.com/oauth/authorize?client_id=paseo&state=abc",
        ],
        options: { stdio: "ignore", detached: true },
      },
    ]);
  });

  it("returns false when spawning the opener throws", () => {
    const opened = openBrowserUrl("https://auth.openai.com/oauth/authorize", {
      platform: "linux",
      spawn: () => {
        throw new Error("spawn failed");
      },
    });

    expect(opened).toBe(false);
  });
});
