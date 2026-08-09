import { isStandardLoopbackHostname, isUnspecifiedHostname } from "@/utils/localhost-url";

export type MobileBrowserNavigationDecision =
  | { kind: "allow" }
  | { kind: "localhost-tls" }
  | { kind: "unsupported-protocol"; protocol: string }
  | { kind: "invalid-url" };

export function resolveMobileBrowserNavigation(url: string): MobileBrowserNavigationDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "invalid-url" };
  }

  if (parsed.href === "about:blank") {
    return { kind: "allow" };
  }
  if (isUnspecifiedHostname(parsed.hostname)) {
    return { kind: "invalid-url" };
  }
  if (
    (parsed.protocol === "https:" || parsed.protocol === "wss:") &&
    isStandardLoopbackHostname(parsed.hostname)
  ) {
    return { kind: "localhost-tls" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "unsupported-protocol", protocol: parsed.protocol };
  }
  return { kind: "allow" };
}
