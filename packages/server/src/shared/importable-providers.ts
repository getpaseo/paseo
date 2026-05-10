/**
 * Providers eligible for "import recent session" discovery. ACP-based
 * providers (gemini, copilot, generic acp) are excluded because they either
 * don't expose persisted history quickly or duplicate other providers.
 */
export const IMPORTABLE_PROVIDERS = ["claude", "codex", "opencode"] as const;
