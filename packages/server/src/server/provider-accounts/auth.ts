import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderAccountIdentity,
  ProviderAccountLogin,
  ProviderAccountProvider,
} from "@getpaseo/protocol/provider-accounts";
import { createExternalProcessEnv } from "../paseo-env.js";
import { terminateWithTreeKill } from "../../utils/tree-kill.js";
import { CodexAppServerClient } from "../agent/providers/codex/app-server-transport.js";
import { getProviderAccountAdapter } from "./adapters.js";
import type { ProviderAccountRecord } from "./store.js";

const execFileAsync = promisify(execFile);
const AUTH_REQUEST_TIMEOUT_MS = 30_000;
const LOGIN_OUTPUT_LIMIT = 32_768;

const CodexLoginResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chatgptDeviceCode"),
    loginId: z.string(),
    verificationUrl: z.string().url(),
    userCode: z.string(),
  }),
  z.object({ type: z.literal("chatgpt"), loginId: z.string(), authUrl: z.string().url() }),
]);

const CodexLoginCompletedSchema = z.object({
  loginId: z.string().nullable(),
  success: z.boolean(),
  error: z.string().nullable(),
});

const CodexAccountResponseSchema = z.object({
  account: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("chatgpt"), email: z.string().nullable(), planType: z.string() }),
      z.object({ type: z.literal("apiKey") }),
      z.object({ type: z.literal("amazonBedrock") }).passthrough(),
    ])
    .nullable(),
});

const ClaudeAuthStatusSchema = z.object({
  loggedIn: z.boolean(),
  email: z.string().nullable().optional(),
  orgName: z.string().nullable().optional(),
  subscriptionType: z.string().nullable().optional(),
});

export interface ProviderLoginHandle {
  loginId: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  completion: Promise<ProviderAccountIdentity>;
  cancel: () => Promise<void>;
}

export type ProviderLoginStarter = (account: ProviderAccountRecord) => Promise<ProviderLoginHandle>;

interface ProviderAccountAuthManagerOptions {
  logger: Logger;
  onAuthenticated: (accountProfileId: string, identity: ProviderAccountIdentity) => Promise<void>;
  now?: () => Date;
  starters?: Partial<Record<ProviderAccountProvider, ProviderLoginStarter>>;
}

export class ProviderAccountAuthManager {
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly onAuthenticated: ProviderAccountAuthManagerOptions["onAuthenticated"];
  private readonly starters: Record<ProviderAccountProvider, ProviderLoginStarter>;
  private readonly states = new Map<string, ProviderAccountLogin>();
  private readonly handles = new Map<string, ProviderLoginHandle>();

  constructor(options: ProviderAccountAuthManagerOptions) {
    this.logger = options.logger.child({ module: "provider-account-auth" });
    this.now = options.now ?? (() => new Date());
    this.onAuthenticated = options.onAuthenticated;
    this.starters = {
      codex: options.starters?.codex ?? createCodexLoginStarter(this.logger),
      claude: options.starters?.claude ?? createClaudeLoginStarter(),
    };
  }

  async start(account: ProviderAccountRecord): Promise<ProviderAccountLogin> {
    await this.cancelActive(account.id);
    const timestamp = this.now().toISOString();
    this.states.set(account.id, {
      accountProfileId: account.id,
      provider: account.provider,
      status: "starting",
      loginId: null,
      verificationUrl: null,
      userCode: null,
      error: null,
      startedAt: timestamp,
      updatedAt: timestamp,
    });

    try {
      const handle = await this.starters[account.provider](account);
      this.handles.set(account.id, handle);
      this.transition(account.id, {
        status: "waiting",
        loginId: handle.loginId,
        verificationUrl: handle.verificationUrl,
        userCode: handle.userCode,
        error: null,
      });
      void this.observeCompletion(account, handle);
      return this.requireState(account.id);
    } catch (error) {
      this.transition(account.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return this.requireState(account.id);
    }
  }

  status(accountProfileId: string): ProviderAccountLogin {
    return this.requireState(accountProfileId);
  }

  async cancel(accountProfileId: string): Promise<ProviderAccountLogin> {
    const state = this.requireState(accountProfileId);
    await this.cancelActive(accountProfileId);
    if (state.status === "starting" || state.status === "waiting") {
      this.transition(accountProfileId, { status: "canceled", error: null });
    }
    return this.requireState(accountProfileId);
  }

  private async observeCompletion(
    account: ProviderAccountRecord,
    handle: ProviderLoginHandle,
  ): Promise<void> {
    try {
      const identity = await handle.completion;
      if (this.handles.get(account.id) !== handle) return;
      await this.onAuthenticated(account.id, identity);
      this.transition(account.id, { status: "succeeded", error: null });
    } catch (error) {
      if (this.handles.get(account.id) !== handle) return;
      this.transition(account.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.handles.get(account.id) === handle) this.handles.delete(account.id);
    }
  }

  private async cancelActive(accountProfileId: string): Promise<void> {
    const handle = this.handles.get(accountProfileId);
    if (!handle) return;
    this.handles.delete(accountProfileId);
    await handle.cancel().catch((error) => {
      this.logger.debug({ err: error, accountProfileId }, "Provider account login cancel failed");
    });
  }

  private transition(
    accountProfileId: string,
    patch: Partial<Omit<ProviderAccountLogin, "accountProfileId" | "provider" | "startedAt">>,
  ): void {
    const current = this.requireState(accountProfileId);
    this.states.set(accountProfileId, {
      ...current,
      ...patch,
      updatedAt: this.now().toISOString(),
    });
  }

  private requireState(accountProfileId: string): ProviderAccountLogin {
    const state = this.states.get(accountProfileId);
    if (!state) throw new Error(`No login is active for provider account ${accountProfileId}`);
    return { ...state };
  }
}

function createCodexLoginStarter(logger: Logger): ProviderLoginStarter {
  return async (account) => {
    const child = spawnProvider("codex", ["app-server"], account);
    const client = new CodexAppServerClient(child, logger);
    let resolveCompletion!: (identity: ProviderAccountIdentity) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<ProviderAccountIdentity>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    let loginId: string | null = null;
    client.setUnexpectedTerminationHandler(rejectCompletion);
    client.setNotificationHandler((method, params) => {
      if (method !== "account/login/completed") return;
      const completed = CodexLoginCompletedSchema.safeParse(params);
      if (!completed.success) return;
      if (completed.data.loginId && completed.data.loginId !== loginId) return;
      if (!completed.data.success) {
        rejectCompletion(new Error(completed.data.error ?? "Codex login failed"));
        return;
      }
      void client
        .request("account/read", { refreshToken: false }, AUTH_REQUEST_TIMEOUT_MS)
        .then((value) => CodexAccountResponseSchema.parse(value))
        .then((response) => {
          const identity: ProviderAccountIdentity = {};
          if (response.account?.type === "chatgpt") {
            if (response.account.email) identity.email = response.account.email;
            identity.plan = response.account.planType;
          }
          resolveCompletion(identity);
          return undefined;
        })
        .catch((error) =>
          rejectCompletion(error instanceof Error ? error : new Error(String(error))),
        );
    });
    try {
      await client.request(
        "initialize",
        {
          clientInfo: { name: "paseo", title: "Paseo", version: "0.5.1" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
        AUTH_REQUEST_TIMEOUT_MS,
      );
      client.notify("initialized", {});
      const response = CodexLoginResponseSchema.parse(
        await client.request(
          "account/login/start",
          { type: "chatgptDeviceCode" },
          AUTH_REQUEST_TIMEOUT_MS,
        ),
      );
      loginId = response.loginId;
      return {
        loginId,
        verificationUrl:
          response.type === "chatgptDeviceCode" ? response.verificationUrl : response.authUrl,
        userCode: response.type === "chatgptDeviceCode" ? response.userCode : null,
        completion: completion.finally(() =>
          client.dispose().catch((error) => {
            logger.debug({ err: error }, "Codex login app-server disposal failed");
          }),
        ),
        cancel: async () => {
          if (loginId) {
            await client
              .request("account/login/cancel", { loginId }, AUTH_REQUEST_TIMEOUT_MS)
              .catch(() => undefined);
          }
          rejectCompletion(new Error("Codex login canceled"));
          await client.dispose();
        },
      };
    } catch (error) {
      await client.dispose();
      throw error;
    }
  };
}

function createClaudeLoginStarter(): ProviderLoginStarter {
  return async (account) => {
    const child = spawnProvider("claude", ["auth", "login", "--claudeai"], account);
    let output = "";
    let resolveCompletion!: (identity: ProviderAccountIdentity) => void;
    let rejectCompletion!: (error: Error) => void;
    let settled = false;
    const completion = new Promise<ProviderAccountIdentity>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const append = (chunk: unknown) => {
      output = `${output}${String(chunk)}`.slice(-LOGIN_OUTPUT_LIMIT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      settled = true;
      rejectCompletion(error);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        rejectCompletion(
          new Error(`Claude login exited with code ${code ?? "null"} (${signal ?? "no signal"})`),
        );
        return;
      }
      void readClaudeIdentity(account)
        .then(resolveCompletion)
        .catch((error) =>
          rejectCompletion(error instanceof Error ? error : new Error(String(error))),
        );
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const verificationUrl = extractFirstUrl(output);
    return {
      loginId: child.pid ? String(child.pid) : null,
      verificationUrl,
      userCode: null,
      completion,
      cancel: async () => {
        if (!settled) {
          settled = true;
          rejectCompletion(new Error("Claude login canceled"));
        }
        await terminateWithTreeKill(child, {
          gracefulTimeoutMs: 2_000,
          forceTimeoutMs: 1_000,
        });
      },
    };
  };
}

function spawnProvider(
  command: "codex" | "claude",
  args: string[],
  account: ProviderAccountRecord,
): ChildProcessWithoutNullStreams {
  const env = createExternalProcessEnv(
    process.env,
    getProviderAccountAdapter(account.provider).launchSpec(account).envOverlay,
  );
  return spawn(command, args, {
    env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function readClaudeIdentity(
  account: ProviderAccountRecord,
): Promise<ProviderAccountIdentity> {
  const env = createExternalProcessEnv(
    process.env,
    getProviderAccountAdapter(account.provider).launchSpec(account).envOverlay,
  );
  const { stdout } = await execFileAsync("claude", ["auth", "status", "--json"], {
    env,
    timeout: AUTH_REQUEST_TIMEOUT_MS,
  });
  const status = ClaudeAuthStatusSchema.parse(JSON.parse(stdout));
  if (!status.loggedIn) throw new Error("Claude login did not create an authenticated session");
  return {
    ...(status.email ? { email: status.email } : {}),
    ...(status.orgName ? { organization: status.orgName } : {}),
    ...(status.subscriptionType ? { plan: status.subscriptionType } : {}),
  };
}

function extractFirstUrl(output: string): string | null {
  return output.match(/https:\/\/[^\s<>"]+/u)?.[0]?.replace(/[),.;]+$/u, "") ?? null;
}
