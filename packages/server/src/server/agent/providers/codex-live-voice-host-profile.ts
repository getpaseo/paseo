import type { LiveVoiceHostProfile } from "../../live-voice/live-voice-host-profile.js";
import type { CodexProviderOptions } from "./codex/options.js";

/**
 * The host dispatches Paseo actions; it never performs machine-local work.
 * Removing native action tools keeps a mistaken delegation from becoming an
 * approval prompt, while never/read-only make unsupported or future tools fail closed.
 */
export const CODEX_LIVE_VOICE_PROVIDER_OPTIONS = {
  approval_policy: "never",
  sandbox_mode: "read-only",
  web_search: "disabled",
  project_doc_max_bytes: 0,
  tools: {
    experimental_request_user_input: { enabled: false },
    update_plan: { enabled: false },
  },
  features: {
    // Thread-level feature overrides rebuild feature state without the
    // `--enable realtime_conversation` CLI flag, so the host thread must
    // re-enable it here or realtime start fails with "thread does not
    // support realtime conversation".
    realtime_conversation: true,
    apps: false,
    browser_use: false,
    browser_use_external: false,
    browser_use_full_cdp_access: false,
    code_mode: false,
    code_mode_only: false,
    computer_use: false,
    current_time_reminder: false,
    deferred_executor: false,
    goals: false,
    hooks: false,
    image_generation: false,
    memories: false,
    multi_agent: false,
    multi_agent_v2: false,
    plugins: false,
    recommended_plugins: false,
    remote_plugin: false,
    request_permissions_tool: false,
    shell_tool: false,
    skill_mcp_dependency_install: false,
    skill_search: false,
    token_budget: false,
    tool_suggest: false,
    view_image: false,
    workspace_dependencies: false,
  },
} satisfies CodexProviderOptions;

/**
 * Codex's Live Voice hosting profile — the adapter that maps codex specifics
 * onto the coordinator's neutral seam. Everything codex-flavored about hosting
 * a call belongs here, not in `server/live-voice/`.
 *
 * Model: codex resolves an unknown model id to its own default, so an older
 * codex still hosts calls with a stale default here.
 *
 * Do not expect much latency from the model choice. Measured against codex's
 * own rollouts (see docs/architecture.md), a median action costs ~13s, of which
 * ~9.5s is the realtime model deciding plus codex's handoff, ~2.4s is the turn
 * that actually emits the tool call, and ~20ms is Paseo. That emitting turn
 * runs on a codex *subagent* thread pinned by codex to its own model and
 * effort, not to anything set here. The lever that moves the number is making
 * fewer calls.
 *
 * Known gap: codex reports the host thread at effort `high` even when
 * `thinkingOptionId` says otherwise, so the thinking half of this pin is not
 * reaching the provider. Worth chasing only if host-thread turns turn out to
 * dominate that 9.5s window.
 *
 * Context limits: codex enforces 128 items and 8,192 estimated tokens per item
 * and in total on `thread/realtime/start`, counting 4 bytes per token. The
 * budget stays well under: the snapshot competes with the user's actual
 * conversation for attention, and a rejected start costs the whole call.
 *
 * Caveat: a user's `experimental_realtime_ws_backend_prompt` in their codex
 * config takes precedence over the prompt this profile's host sends. That
 * ordering lives in codex, so a user who sets it opts out of the Paseo prompt.
 */
export const CODEX_LIVE_VOICE_HOST_PROFILE: LiveVoiceHostProfile = {
  provider: "codex",
  model: "gpt-5.6-luna",
  thinkingOptionId: "medium",
  providerOptions: CODEX_LIVE_VOICE_PROVIDER_OPTIONS,
  contextLimits: {
    contextTokenBudget: 3_000,
    bytesPerToken: 4,
  },
};
