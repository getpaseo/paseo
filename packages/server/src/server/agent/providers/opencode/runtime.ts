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
  return createOpencodeClient(options satisfies OpencodeClientConfig & { directory: string });
}
