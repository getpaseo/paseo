import { z } from "zod";
import {
  hashAccountKey,
  unavailable,
  type UsageAccount,
  toneFromUsedPct,
  windowFromUsedPct,
  type UsageReport,
} from "@getpaseo/plugin/server/usage";
import type { Input } from "../shared/input.js";
import { NO_SUBSCRIPTION, readConsoleGo } from "./console.js";
import { installedOpenCode, loginStore, readLogins, type GoCredential } from "./opencode.js";

const windowSchema = z.object({
  status: z.enum(["ok", "rate-limited"]),
  percent: z.number().finite(),
  resetsAt: z.iso.datetime(),
});
const responseSchema = z.object({
  usage: z.object({ rolling: windowSchema, weekly: windowSchema, monthly: windowSchema }),
});

export async function discover(install = installedOpenCode()): Promise<UsageAccount[]> {
  const store = await loginStore(install);
  const logins = await readLogins(install, store);
  if (!logins.opencode && !logins.go) return [];
  // One OpenCode data directory holds one Go login, whichever store it lives in. Usage settings
  // are saved per account, so a login OpenCode 2 imports keeps the identity it had in auth.json.
  return [{ key: hashAccountKey(install.authFile), input: { store } }];
}

export async function fetchUsage(
  input: Input,
  fetchApi: typeof fetch = fetch,
  install = installedOpenCode(),
): Promise<UsageReport> {
  const logins = await readLogins(install, input.store);
  const only = logins.opencode ?? logins.go;
  if (!only) throw new Error("OpenCode Go login no longer exists");
  if (logins.opencode && logins.go) return readEitherLogin(logins.opencode, logins.go, fetchApi);
  return readCredential(only, fetchApi, { workspaceKey: only === logins.opencode });
}

/**
 * OpenCode serves Go with the `opencode` credential whenever that Console workspace has Go, so
 * the card follows it. The `opencode-go` key serves Go when the Console refuses that credential.
 * A temporary failure keeps OpenCode on the `opencode` credential, so it throws instead.
 */
async function readEitherLogin(
  opencode: GoCredential,
  go: GoCredential,
  fetchApi: typeof fetch,
): Promise<UsageReport> {
  if (opencode.type === "console") {
    const signIn = await readSignIn(opencode, fetchApi);
    if (signIn.status !== "unavailable") return signIn;
    const fallback = await readCredential(go, fetchApi);
    // A connected Console account explains a rejected fallback key better than the key does.
    return isRejected(fallback) ? signIn : fallback;
  }
  const primary = await readCredential(opencode, fetchApi, { workspaceKey: true });
  return primary.status === "unavailable" ? readCredential(go, fetchApi) : primary;
}

function readCredential(
  credential: GoCredential,
  fetchApi: typeof fetch,
  options: { workspaceKey?: boolean } = {},
): Promise<UsageReport> {
  return credential.type === "console"
    ? readSignIn(credential, fetchApi)
    : readKey(credential.key, fetchApi, options);
}

async function readSignIn(
  signIn: Extract<GoCredential, { type: "console" }>,
  fetchApi: typeof fetch,
): Promise<UsageReport> {
  // OpenCode refreshes the sign-in itself; reading never competes with it.
  if (signIn.expires > 0 && signIn.expires <= Date.now())
    return unavailable({
      kind: "expired",
      expiresAt: new Date(signIn.expires).toISOString(),
      refreshedBy: "opencode",
    });
  return readConsoleGo({ token: signIn.access, orgID: signIn.orgID }, fetchApi);
}

/**
 * A key reads the Console meters first, since the usage API floors each percent. Any Console
 * failure falls through to the usage API, which decides what the key's errors mean. The Console
 * gets a short budget so the usage API still answers within the daemon's 20 second refresh.
 */
async function readKey(
  key: string,
  fetchApi: typeof fetch,
  { workspaceKey = false }: { workspaceKey?: boolean } = {},
): Promise<UsageReport> {
  const fromConsole = await readConsoleGo({ token: key }, fetchApi, 3_000).catch(() => null);
  if (fromConsole?.status === "available") return fromConsole;
  const response = await fetchApi("https://opencode.ai/zen/go/v1/usage", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  // The usage API accepts any key of a Console workspace and refuses one without Go.
  if (response.status === 403 && workspaceKey) return NO_SUBSCRIPTION;
  if (response.status === 401 || response.status === 403)
    return unavailable({ kind: "rejected", status: response.status, refreshedBy: "opencode" });
  if (!response.ok) throw new Error(`OpenCode Go usage API returned ${response.status}`);
  const data = responseSchema.parse(await response.json());
  const windows = (
    [
      // The rolling window's length is not reported, so its percent stands without a name.
      ["rolling", "Rolling", "", data.usage.rolling],
      ["weekly", "Weekly", "wk", data.usage.weekly],
      ["monthly", "Monthly", "mo", data.usage.monthly],
    ] as const
  ).map(([id, label, shortLabel, value]) =>
    windowFromUsedPct({
      id,
      label,
      shortLabel,
      utilizationPct: value.percent,
      resetsAt: value.resetsAt,
      tone: toneFromUsedPct(value.percent),
    }),
  );
  return { status: "available", planLabel: "Go", windows };
}

function isRejected(report: UsageReport): boolean {
  return report.status === "unavailable" && report.problem.kind === "rejected";
}
