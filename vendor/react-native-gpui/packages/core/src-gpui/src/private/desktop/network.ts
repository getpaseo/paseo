/**
 * `Network` — the proxy and DNS settings of the HTTP client that `fetch`,
 * `XMLHttpRequest` and the loading of remote images and fonts share.
 *
 * @format
 */

import NativeGpuiNetwork from '../specs/NativeGpuiNetwork';
import { nativeRequest } from './index';

/** Runs one GpuiNetwork method with the shared module check. */
function request<T>(
  run: (native: NonNullable<typeof NativeGpuiNetwork>) => Promise<T>,
): Promise<T> {
  return nativeRequest('GpuiNetwork', check => run(check(NativeGpuiNetwork)));
}

/**
 * Where requests go.
 *
 * - `'system'`: the operating system's proxy settings on macOS, the
 *   `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` environment variables elsewhere.
 *   This is the default.
 * - `'direct'`: no proxy.
 * - a string, or `{ rules, bypass }`: a proxy URL such as
 *   `'http://proxy.example:8080'`, or Chromium proxy rules such as
 *   `'http=foo:80;https=bar:443'`. `'direct://'` and `''` mean no proxy.
 */
export type ProxyConfig =
  | 'system'
  | 'direct'
  | string
  | {
      /** A proxy URL, or Chromium proxy rules. */
      rules: string;
      /**
       * Hosts that skip the proxy, in Chromium's bypass list syntax: host
       * patterns with `*`, `.example.com`, `<local>`, IPv4 `address/prefix`,
       * separated by commas or semicolons. Loopback addresses always skip it.
       */
      bypass?: string;
    };

export interface NetworkSettings {
  mode: 'system' | 'direct' | 'fixed';
  rules: string;
  bypass: string;
  /** The first DNS-over-HTTPS server, or an empty string for the system resolver. */
  dnsOverHttps: string;
  /** All the DNS-over-HTTPS servers, in the order they are tried. */
  dnsOverHttpsServers: string[];
}

function split(config: ProxyConfig): [string, string, string] {
  if (config === 'system' || config === 'direct') {
    return [config, '', ''];
  }
  if (typeof config === 'string') {
    return config.trim() === '' || config.trim() === 'direct://'
      ? ['direct', '', '']
      : ['fixed', config, ''];
  }
  return ['fixed', config.rules, config.bypass ?? ''];
}

export const Network = {
  /**
   * Sets where new requests go. A request already running keeps its proxy.
   * Rejects when the proxy rules cannot be read. WebSocket connections do not use
   * the proxy yet.
   */
  setProxy(config: ProxyConfig): Promise<void> {
    const [mode, rules, bypass] = split(config);
    return request(native => native.setProxy(mode, rules, bypass));
  },

  /**
   * Resolves host names for new requests through a DNS-over-HTTPS server, for
   * example `'https://cloudflare-dns.com/dns-query'`, or through the system
   * resolver for `null`. Give several servers to try them in order: a name that
   * a server cannot resolve is asked of the next one, and of the system resolver
   * after the last, as Chromium's automatic secure DNS mode does. The server's
   * own name is looked up by the system, so give it by address when that
   * matters. A request through a proxy is resolved by the proxy for the host it
   * names.
   */
  setDnsOverHttps(urls: string | string[] | null): Promise<void> {
    const list = urls === null ? [] : Array.isArray(urls) ? urls : [urls];
    return request(native => native.setDnsOverHttps(list.join('\n')));
  },

  async getSettings(): Promise<NetworkSettings> {
    const settings = (await request(native => native.getSettings())) as Omit<
      NetworkSettings,
      'dnsOverHttpsServers'
    >;
    const servers = settings.dnsOverHttps.split('\n').filter(Boolean);
    return {
      ...settings,
      dnsOverHttps: servers[0] ?? '',
      dnsOverHttpsServers: servers,
    };
  },

  /** The proxy a request to `url` would go through: `'DIRECT'` or its URL. */
  proxyForUrl(url: string): Promise<string> {
    return request(native => native.proxyForUrl(url));
  },
};
