const PASEO_NODE_ENV = "PASEO_NODE_ENV";
const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

const RUNTIME_CONTROL_ENV_KEYS = [
  PASEO_NODE_ENV,
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  ELECTRON_RUN_AS_NODE,
  "ELECTRON_NO_ATTACH_CONSOLE",
] as const;

// Fallback locale injected when the caller provides none. Locale-sensitive
// tools decide how to decode bytes from this. macOS `pbcopy` is the concrete
// victim: with no UTF-8 locale it decodes stdin via CoreFoundation's default
// text encoding (MacRoman when ~/.CFUserTextEncoding is 0x0:0x0), corrupting
// multi-byte UTF-8 such as CJK into mojibake. en_US.UTF-8 ships on macOS and
// virtually every Linux distro, so it is a safe default.
const DEFAULT_UTF8_LOCALE = "en_US.UTF-8";

export type PaseoNodeEnv = "development" | "production" | "test";
export type ProcessEnvRecord = Record<string, string | undefined>;
export type ExternalProcessEnv = NodeJS.ProcessEnv & Record<string, string>;

function buildInternalProcessEnv<T extends ProcessEnvRecord>(baseEnv: T): T {
  return { ...baseEnv };
}

// Guarantee a UTF-8 default only when the caller did not set any locale
// category itself, so a deliberate locale choice is never overridden.
function ensureUtf8LocaleDefault(env: ProcessEnvRecord): void {
  if (env.LANG || env.LC_ALL || env.LC_CTYPE) {
    return;
  }
  env.LANG = DEFAULT_UTF8_LOCALE;
}

function buildExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  overlays: ProcessEnvRecord[],
): ExternalProcessEnv {
  const sanitized = Object.assign({}, baseEnv, ...overlays);
  for (const key of RUNTIME_CONTROL_ENV_KEYS) {
    delete sanitized[key];
  }
  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined) {
      delete sanitized[key];
    }
  }
  ensureUtf8LocaleDefault(sanitized);
  return sanitized as ExternalProcessEnv;
}

export function createPaseoInternalEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildInternalProcessEnv(baseEnv);
}

export function createExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function createExternalCommandProcessEnv(
  _command: string,
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  // Deprecated command parameter: retained while callers migrate to createExternalProcessEnv.
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function buildSelfNodeCommand(
  args: string[],
  envOverlay?: ProcessEnvRecord,
): {
  command: string;
  args: string[];
  env: ExternalProcessEnv;
} {
  // Route the overlay through buildExternalProcessEnv so the UTF-8 locale guard
  // observes the caller's locale choice, keeping this consistent with
  // createExternalProcessEnv. Electron node mode is forced afterward because the
  // runtime-control scrub inside buildExternalProcessEnv strips it.
  const env = buildExternalProcessEnv(process.env, envOverlay ? [envOverlay] : []);
  env[ELECTRON_RUN_AS_NODE] = "1";
  return {
    command: process.execPath,
    args,
    env,
  };
}

export function resolvePaseoNodeEnv(env: NodeJS.ProcessEnv): PaseoNodeEnv | undefined {
  const value = env[PASEO_NODE_ENV];
  return value === "development" || value === "production" || value === "test" ? value : undefined;
}
