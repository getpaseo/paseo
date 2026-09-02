import { afterEach, describe, expect, it, vi } from "vitest";

const { confirmDialog, openExternalUrl } = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  openExternalUrl: vi.fn(),
}));

vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl }));

import {
  agentExternalUrlConfirmationMessage,
  confirmAndOpenAgentExternalUrl,
  parseAgentExternalUrl,
} from "./confirm-agent-external-url";

describe("agent external URL confirmation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not retain the old one-click open behavior", async () => {
    confirmDialog.mockResolvedValue(false);

    await confirmAndOpenAgentExternalUrl("https://example.com/live?source=agent");

    expect(confirmDialog).toHaveBeenCalledOnce();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("opens only after the explicit Open live site action", async () => {
    confirmDialog.mockResolvedValue(true);

    await confirmAndOpenAgentExternalUrl("https://example.com/live?source=agent");

    expect(confirmDialog).toHaveBeenCalledWith({
      title: "Open external link",
      message: expect.stringContaining("Full URL: https://example.com/live?source=agent"),
      confirmLabel: "Open live site",
      cancelLabel: "Cancel",
    });
    expect(openExternalUrl).toHaveBeenCalledOnce();
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/live?source=agent");
  });

  it("fails closed for malformed and non-http targets", async () => {
    await confirmAndOpenAgentExternalUrl("javascript:alert(1)");
    await confirmAndOpenAgentExternalUrl("not a url");

    expect(confirmDialog).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("shows internationalized destinations with their ASCII punycode hostname", () => {
    const destination = parseAgentExternalUrl("https://faß.de/path");

    expect(destination).toEqual({
      host: "xn--fa-hia.de",
      hostname: "xn--fa-hia.de",
      url: "https://xn--fa-hia.de/path",
    });
    expect(agentExternalUrlConfirmationMessage(destination!)).toContain(
      "Destination host (ASCII/punycode): xn--fa-hia.de",
    );
  });

  it("shows an explicit non-default port in the destination host", () => {
    const destination = parseAgentExternalUrl("https://example.com:8443/path");

    expect(destination).toEqual({
      host: "example.com:8443",
      hostname: "example.com",
      url: "https://example.com:8443/path",
    });
    expect(agentExternalUrlConfirmationMessage(destination!)).toContain(
      "Destination host: example.com:8443",
    );
  });
});
