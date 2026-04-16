import type { PersistedConfig } from "../../../persisted-config.js";

export type FunASRConfig = {
  url: string;
  timeoutMs?: number;
};

const DEFAULT_FUNASR_URL = "http://127.0.0.1:10095";
const DEFAULT_FUNASR_TIMEOUT_MS = 30000;

export function resolveFunASRConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): FunASRConfig | undefined {
  const url =
    params.env.PASEO_FUNASR_URL ??
    params.persisted.providers?.funasr?.url ??
    DEFAULT_FUNASR_URL;

  return {
    url,
    timeoutMs: DEFAULT_FUNASR_TIMEOUT_MS,
  };
}
