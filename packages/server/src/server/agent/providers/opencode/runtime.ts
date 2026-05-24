import { Buffer } from "node:buffer";
import {
  createOpencodeClient,
  type OpencodeClient,
  type OpencodeClientConfig,
} from "@opencode-ai/sdk/v2/client";

export interface OpenCodeServerAuth {
  username: string;
  password: string;
}

export interface OpenCodeServerAcquisition {
  server: { port: number; url: string };
  release: () => void;
}

export interface OpenCodeClientOptions {
  baseUrl: string;
  directory: string;
  auth?: OpenCodeServerAuth;
}

export interface OpenCodeRuntime {
  acquireServer(options: {
    force: boolean;
    env?: Record<string, string>;
  }): Promise<OpenCodeServerAcquisition>;
  ensureServerRunning(): Promise<{ port: number; url: string }>;
  createClient(options: OpenCodeClientOptions): OpencodeClient;
  shutdown(): Promise<void>;
}

function createOpenCodeBasicAuthHeader(auth: OpenCodeServerAuth): string {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`;
}

export function createSdkOpenCodeClient(options: OpenCodeClientOptions): OpencodeClient {
  const config = {
    baseUrl: options.baseUrl,
    directory: options.directory,
    ...(options.auth
      ? { headers: { Authorization: createOpenCodeBasicAuthHeader(options.auth) } }
      : {}),
  } satisfies OpencodeClientConfig & { directory: string };
  return createOpencodeClient(config);
}
