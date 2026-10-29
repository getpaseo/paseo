import type { Agent } from "node:http";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";

interface ProxyEnvironment {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

let environment = readEnvironment(process.env).environment;

function readEnvironment(env: NodeJS.ProcessEnv): {
  environment: ProxyEnvironment;
  ignored: string[];
} {
  // process.env lookups are case-insensitive on Windows. Read each actual entry once.
  const values = new Map(Object.entries(env));
  const ignored: string[] = [];
  function proxy(variable: string): string | undefined {
    const value = values.get(variable);
    if (value === undefined) return undefined;
    if (!value.trim()) return undefined;
    try {
      const url = new URL(value.includes("://") ? value : `http://${value}`);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("Unsupported proxy protocol");
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
      return url.href;
    } catch {
      ignored.push(variable);
      return undefined;
    }
  }
  const httpProxy = proxy("http_proxy") ?? proxy("HTTP_PROXY") ?? "";
  return {
    environment: {
      httpProxy,
      httpsProxy: proxy("https_proxy") ?? proxy("HTTPS_PROXY") ?? httpProxy,
      noProxy: values.get("no_proxy") ?? values.get("NO_PROXY") ?? "",
    },
    ignored,
  };
}

function bypassList(noProxy: string): string {
  return noProxy.trim() === "*" ? "*" : `${noProxy},localhost,127.0.0.1,[::1],::1`;
}

/** Install once at startup; return ignored variable names for logging without exposing credentials. */
export function initializeEnvironmentProxy(env: NodeJS.ProcessEnv = process.env): string[] {
  const resolved = readEnvironment(env);
  environment = resolved.environment;
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy: environment.httpProxy,
      httpsProxy: environment.httpsProxy,
      noProxy: bypassList(environment.noProxy),
    }),
  );
  return resolved.ignored;
}

/** ws uses Node HTTP agents rather than the fetch dispatcher. */
export function webSocketProxyAgent(address: string): Agent | undefined {
  const url = new URL(address);
  const hostname = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "wss:" ? "443" : "80");
  const entries = bypassList(environment.noProxy)
    .toLowerCase()
    .split(/[,\s]+/);
  if (
    entries.some((entry) => {
      if (entry === "*") return true;
      const match = entry.match(/^(.+):(\d+)$/);
      if (match && match[2] !== port) return false;
      const host = (match ? match[1]! : entry).replace(/^\*?\./, "");
      return host !== "" && (hostname === host || hostname.endsWith(`.${host}`));
    })
  )
    return undefined;
  const proxy = url.protocol === "wss:" ? environment.httpsProxy : environment.httpProxy;
  return proxy ? new HttpsProxyAgent(proxy) : undefined;
}
