import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { getHostNetworkLoadError } from "./load-error";

const host = "Remote Mac";
const proxyUnavailable =
  "The browser connection to the network of host Remote Mac is unavailable. Reconnect the host and reload.";
const destinationFailed =
  "Could not reach this address through the network of host Remote Mac. Check the address and the host connection.";
const connectionClosed =
  "The connection through the network of host Remote Mac closed. Reconnect the host and reload.";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("host network load errors", () => {
  it.each([
    [-130, "ERR_PROXY_CONNECTION_FAILED", proxyUnavailable],
    [-111, "ERR_TUNNEL_CONNECTION_FAILED", destinationFailed],
    [-324, "ERR_EMPTY_RESPONSE", connectionClosed],
    [-100, "ERR_CONNECTION_CLOSED", connectionClosed],
  ] as const)("explains %s from events, errno and loadURL rejections", (code, name, message) => {
    expect(getHostNetworkLoadError({ errorCode: code, isMainFrame: true }, host)).toBe(message);
    expect(getHostNetworkLoadError({ errno: code }, host)).toBe(message);
    expect(getHostNetworkLoadError(new Error(`net::${name} (${code})`), host)).toBe(message);
    expect(getHostNetworkLoadError({ errorCode: code, isMainFrame: false }, host)).toBeNull();
  });

  it.each([
    null,
    undefined,
    "ERR_PROXY_CONNECTION_FAILED",
    503,
    {},
    { errorCode: -3 },
    { errno: -105 },
    { errorCode: "-130" },
    new Error("ERR_NAME_NOT_RESOLVED"),
    { message: "ERR_PROXY_CONNECTION_FAILED" },
  ])("leaves unrelated or malformed errors to the caller (%j)", (error) => {
    expect(getHostNetworkLoadError(error, host)).toBeNull();
  });

  it("prefers the event code over errno", () => {
    expect(getHostNetworkLoadError({ errorCode: -111, errno: -130 }, host)).toBe(destinationFailed);
  });

  it("translates the explanation and interpolates the host", async () => {
    await i18n.changeLanguage("pt-BR");
    expect(getHostNetworkLoadError({ errorCode: -130 }, "Servidor remoto")).toBe(
      i18n.t("browserRouting.proxyUnavailable", { host: "Servidor remoto" }),
    );
    expect(getHostNetworkLoadError({ errorCode: -130 }, host)).not.toBe(proxyUnavailable);
  });
});
