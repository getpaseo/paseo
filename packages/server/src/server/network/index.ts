import type { Agent } from "node:http";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";

interface ProxyEnvironment {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

let environment = readEnvironment(process.env);

function readEnvironment(env: NodeJS.ProcessEnv): ProxyEnvironment {
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? "";
  return {
    httpProxy,
    httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? httpProxy,
    noProxy: env.no_proxy ?? env.NO_PROXY ?? "",
  };
}

function bypassList(noProxy: string): string {
  return noProxy.trim() === "*" ? "*" : `${noProxy},localhost,127.0.0.1,[::1],::1`;
}

/** Install once at process startup, without changing environments inherited by agents. */
export function initializeEnvironmentProxy(env: NodeJS.ProcessEnv = process.env): void {
  environment = readEnvironment(env);
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy: environment.httpProxy,
      httpsProxy: environment.httpsProxy,
      noProxy: bypassList(environment.noProxy),
    }),
  );
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
