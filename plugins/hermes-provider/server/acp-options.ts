import type { AcpOptions } from "@getpaseo/plugin/server/acp";

/**
 * `hermes acp` imports ~60 plugins before it answers `initialize` (4-6 s alone on Windows).
 * Paseo can start several viewers at once (capability probe, snapshot refresh, agent
 * creation), and four concurrent cold starts measured 8-12 s to initialize. The 10 s
 * default leaves too little headroom, so agent creation intermittently failed with
 * "ACP provider hermes did not initialize".
 */
export const hermesAcpOptions = {
  startupTimeoutMs: 30_000,
  autoAcceptMode: {
    mode: {
      id: "full-access",
      label: "Full access",
      description: "Approve tool requests without asking.",
      icon: "ShieldOff",
      colorTier: "dangerous",
    },
    nativeMode: "ask",
  },
} satisfies AcpOptions;
