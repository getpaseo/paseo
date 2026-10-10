import { i18n } from "@/i18n/i18next";

export function getHostNetworkLoadError(error: unknown, host: string): string | null {
  if (typeof error !== "object" || error === null) return null;
  if ("isMainFrame" in error && error.isMainFrame === false) return null;
  let code: unknown = null;
  if ("errorCode" in error) code = error.errorCode;
  else if ("errno" in error) code = error.errno;
  if (code === null && error instanceof Error) {
    if (error.message.includes("ERR_PROXY_CONNECTION_FAILED")) code = -130;
    else if (error.message.includes("ERR_TUNNEL_CONNECTION_FAILED")) code = -111;
    else if (error.message.includes("ERR_EMPTY_RESPONSE")) code = -324;
    else if (error.message.includes("ERR_CONNECTION_CLOSED")) code = -100;
  }
  switch (code) {
    case -130:
      return i18n.t("browserRouting.proxyUnavailable", { host });
    case -111:
      return i18n.t("browserRouting.destinationFailed", { host });
    case -324:
    case -100:
      return i18n.t("browserRouting.connectionClosed", { host });
    default:
      return null;
  }
}
