import { describe, expect, it, vi } from "vitest";
import { createTerminalLinkHandler } from "./terminal-link-handler";

describe("createTerminalLinkHandler", () => {
  it("routes OSC 8 hyperlink activation to the URL opener", () => {
    const onOpenUrl = vi.fn();
    const handler = createTerminalLinkHandler(() => onOpenUrl);
    const event = { preventDefault: vi.fn() } as unknown as MouseEvent;

    handler.activate(event, "https://example.com/pull/42", {
      start: { x: 1, y: 1 },
      end: { x: 24, y: 1 },
    });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onOpenUrl).toHaveBeenCalledWith("https://example.com/pull/42");
  });

  it("reads the opener at activation time so late-bound callbacks are honored", () => {
    let onOpenUrl: ((url: string) => void) | undefined;
    const handler = createTerminalLinkHandler(() => onOpenUrl);
    const event = { preventDefault: vi.fn() } as unknown as MouseEvent;
    const range = { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } };

    handler.activate(event, "https://example.com/first", range);
    onOpenUrl = vi.fn();
    handler.activate(event, "https://example.com/second", range);

    expect(onOpenUrl).toHaveBeenCalledTimes(1);
    expect(onOpenUrl).toHaveBeenCalledWith("https://example.com/second");
  });
});
