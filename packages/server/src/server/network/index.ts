import type { Agent } from "node:http";
import { Agent as DirectAgent, Dispatcher, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
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
  const ignored: string[] = [];
  function proxy(lower: string, upper: string): string | undefined {
    const variable = env[lower] !== undefined ? lower : upper;
    const value = env[variable];
    if (value === undefined) return undefined;
    if (!value.trim()) return "";
    try {
      const url = new URL(value.includes("://") ? value : `http://${value}`);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("Unsupported proxy protocol");
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
      return url.href;
    } catch {
      ignored.push(variable);
      return "";
    }
  }
  const httpProxy = proxy("http_proxy", "HTTP_PROXY") ?? "";
  return {
    environment: {
      httpProxy,
      httpsProxy: proxy("https_proxy", "HTTPS_PROXY") ?? httpProxy,
      noProxy: env.no_proxy ?? env.NO_PROXY ?? "",
    },
    ignored,
  };
}

function bypassList(noProxy: string): string {
  return noProxy.trim() === "*" ? "*" : `${noProxy},localhost,127.0.0.1,[::1],::1`;
}

// undici otherwise falls back to HTTP_PROXY when an explicitly ignored HTTPS proxy is empty.
class EnvironmentProxyAgent extends Dispatcher {
  private readonly proxy: EnvHttpProxyAgent;
  private readonly direct = new DirectAgent();
  private readonly options: ProxyEnvironment;
  constructor(options: ProxyEnvironment) {
    super();
    this.options = options;
    this.proxy = new EnvHttpProxyAgent(options);
  }
  override dispatch(
    options: Parameters<EnvHttpProxyAgent["dispatch"]>[0],
    handler: Parameters<EnvHttpProxyAgent["dispatch"]>[1],
  ): boolean {
    if (!this.options.httpsProxy && String(options.origin).startsWith("https:"))
      return this.direct.dispatch(options, handler);
    return this.proxy.dispatch(options, handler);
  }
  override async close(): Promise<void> {
    await Promise.all([this.proxy.close(), this.direct.close()]);
  }
  override async destroy(): Promise<void> {
    await Promise.all([this.proxy.destroy(), this.direct.destroy()]);
  }
}

/** Install once at startup; return ignored variable names for logging without exposing credentials. */
export function initializeEnvironmentProxy(env: NodeJS.ProcessEnv = process.env): string[] {
  const resolved = readEnvironment(env);
  environment = resolved.environment;
  setGlobalDispatcher(
    new EnvironmentProxyAgent({
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
