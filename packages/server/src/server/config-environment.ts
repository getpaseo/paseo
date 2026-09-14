// Daemon configuration inputs. General provider credentials and executable/runtime
// controls remain available to managed launches and their agent processes.
export const DAEMON_SETTING_ENV_KEYS = [
  "MCP_DEBUG",
  "OPENAI_STT_BASE_URL",
  "OPENAI_TTS_BASE_URL",
  "PASEO_ALLOWED_HOSTS",
  "PASEO_APP_BASE_URL",
  "PASEO_CORS_ORIGINS",
  "PASEO_DICTATION_ENABLED",
  "PASEO_DICTATION_LANGUAGE",
  "PASEO_DICTATION_LOCAL_STT_MODEL",
  "PASEO_DICTATION_STT_PROVIDER",
  "PASEO_GIT_CONCURRENCY",
  "PASEO_GIT_MAX_PROCESSES_PER_SECOND",
  "PASEO_GIT_MAX_PROCESS_CONCURRENCY",
  "PASEO_HOSTNAMES",
  "PASEO_LISTEN",
  "PASEO_LOCAL_MODELS_DIR",
  "PASEO_LOG",
  "PASEO_LOG_CONSOLE_FORMAT",
  "PASEO_LOG_CONSOLE_LEVEL",
  "PASEO_LOG_FILE_LEVEL",
  "PASEO_LOG_FILE_PATH",
  "PASEO_LOG_FILE_ROTATE_COUNT",
  "PASEO_LOG_FILE_ROTATE_SIZE",
  "PASEO_LOG_FORMAT",
  "PASEO_LOG_LEVEL",
  "PASEO_LOG_ROTATE_COUNT",
  "PASEO_LOG_ROTATE_SIZE",
  "PASEO_PASSWORD",
  "PASEO_RELAY_ENABLED",
  "PASEO_RELAY_ENDPOINT",
  "PASEO_RELAY_PUBLIC_ENDPOINT",
  "PASEO_RELAY_PUBLIC_USE_TLS",
  "PASEO_RELAY_USE_TLS",
  "PASEO_SERVICE_PROXY_ENABLED",
  "PASEO_SERVICE_PROXY_LISTEN",
  "PASEO_SERVICE_PROXY_PUBLIC_BASE_URL",
  "PASEO_TRUSTED_PROXIES",
  "PASEO_VOICE_LANGUAGE",
  "PASEO_VOICE_LLM_PROVIDER",
  "PASEO_VOICE_LOCAL_STT_MODEL",
  "PASEO_VOICE_LOCAL_TTS_MODEL",
  "PASEO_VOICE_LOCAL_TTS_SPEAKER_ID",
  "PASEO_VOICE_LOCAL_TTS_SPEED",
  "PASEO_VOICE_MODE_ENABLED",
  "PASEO_VOICE_STT_PROVIDER",
  "PASEO_VOICE_TTS_PROVIDER",
  "PASEO_VOICE_TURN_DETECTION_PROVIDER",
  "PASEO_WEB_UI_DIST_DIR",
  "PASEO_WEB_UI_ENABLED",
  "PORT",
  "STT_CONFIDENCE_THRESHOLD",
  "STT_MODEL",
  "TTS_MODEL",
  "TTS_VOICE",
] as const;

const CONFIG_CONTEXT_ENV_KEYS = [
  "PASEO_NODE_ENV",
  "PASEO_DESKTOP_MANAGED",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_STT_API_KEY",
  "OPENAI_TTS_API_KEY",
] as const;

export function configurationEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [...DAEMON_SETTING_ENV_KEYS, ...CONFIG_CONTEXT_ENV_KEYS].map((key) => [key, env[key]]),
  );
}

export function daemonLaunchEnvironment(input: {
  env: NodeJS.ProcessEnv;
  home: string;
  mode: "managed" | "deployment";
  desktopManaged?: boolean;
}): NodeJS.ProcessEnv {
  const env = { ...input.env };
  if (input.mode === "managed") {
    for (const key of DAEMON_SETTING_ENV_KEYS) delete env[key];
  }
  delete env.PASEO_HOST;
  delete env.PASEO_DESKTOP_MANAGED;
  env.PASEO_HOME = input.home;
  if (input.desktopManaged) env.PASEO_DESKTOP_MANAGED = "1";
  return env;
}
