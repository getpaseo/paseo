import {
  createOpencodeClient,
  type OpencodeClient,
  type OpencodeClientConfig,
} from "@opencode-ai/sdk/v2/client";

export interface OpenCodeServerAcquisition {
  server: { port: number; url: string };
  release: () => void;
}

export interface OpenCodeRuntime {
  acquireServer(options: {
    force: boolean;
    env?: Record<string, string>;
  }): Promise<OpenCodeServerAcquisition>;
  ensureServerRunning(): Promise<{ port: number; url: string }>;
  createClient(options: { baseUrl: string; directory: string }): OpencodeClient;
  shutdown(): Promise<void>;
}

export function createSdkOpenCodeClient(options: {
  baseUrl: string;
  directory: string;
}): OpencodeClient {
  // COMPAT(opencode-auth): OpenCode >= 1.15.0 requires HTTP Basic auth on the
  // server. The auth credentials are not exposed via stdout, stderr, or any
  // known environment variable. The `@opencode-ai/sdk` >= 1.15.0 supports auth
  // via `Config.auth` (basic / bearer), but the mechanism to obtain server
  // credentials from `opencode serve` needs to be determined in coordination
  // with the OpenCode team.
  //
  // Once the auth mechanism is understood, pass credentials like:
  //   auth: () => `${username}:${password}`,
  return createOpencodeClient(options satisfies OpencodeClientConfig & { directory: string });
}
