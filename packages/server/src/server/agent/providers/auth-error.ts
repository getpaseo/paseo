/**
 * Provider credentials expire mid-session. The runtime reports that as an
 * ordinary turn failure, so without classification an expired token is
 * indistinguishable from a crash: the user is told "Failed to authenticate"
 * with no indication of which credential died, and the runtime's own advice
 * ("run /login") targets an interactive CLI that does not exist here.
 *
 * Classifying the failure lets the agent recycle its runtime process so an
 * external re-login is picked up, and lets the manager attach recovery steps
 * that can actually be followed from inside Paseo.
 */

// Matched against a runtime's failure text, which is far narrower than agent
// output, but still keep the loose tokens (401, unauthorized) tied to an
// auth-ish neighbour so a diff or a log line quoting them is not misread.
const AUTH_ERROR_PATTERNS: readonly RegExp[] = [
  /\bfailed to authenticate\b/i,
  /\bnot logged in\b/i,
  /\bplease run\s+\/login\b/i,
  /\boauth\b[^\n]{0,80}\b(?:expired|revoked|refresh(?:ed)?)\b/i,
  /\b(?:session|token|credentials?)\b[^\n]{0,80}\b(?:expired|revoked)\b/i,
  /\b(?:401|unauthorized)\b[^\n]{0,80}\b(?:oauth|token|credentials?|auth\w*|api[ _-]?key)\b/i,
  /\b(?:oauth|token|credentials?|auth\w*|api[ _-]?key)\b[^\n]{0,80}\b(?:401|unauthorized)\b/i,
  /\bauthentication_error\b/i,
  /\binvalid[ _-]?api[ _-]?key\b/i,
];

/** Re-authentication steps for the runtimes whose flow we can state exactly. */
const PROVIDER_LOGIN_STEPS: Readonly<Record<string, string>> = {
  claude: "run `claude` in a terminal, then `/logout` followed by `/login`",
  codex: "run `codex login` in a terminal",
};

/** Display names for providers reached by id alone, away from the snapshot manager. */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
};

export function isProviderAuthError(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Names the credential that failed and gives steps that work from here. The
 * runtime holds its credentials in memory, so a re-login is only picked up
 * once the process is replaced — say so rather than leaving the user to guess
 * why a successful login changed nothing.
 */
export function buildProviderAuthRecoveryGuidance(options: {
  provider: string;
  providerLabel?: string;
}): string {
  const label =
    options.providerLabel?.trim() || PROVIDER_LABELS[options.provider] || options.provider;
  const steps =
    PROVIDER_LOGIN_STEPS[options.provider] ?? `re-run the ${label} login flow in a terminal`;
  return [
    `${label} credentials are no longer valid. This is ${label}'s own authentication, not your Paseo, Git forge, or cloud CLI login.`,
    `To recover, ${steps}, then send another message here — this agent restarts its ${label} process on the next turn, so it will pick up the refreshed credentials.`,
  ].join("\n\n");
}
