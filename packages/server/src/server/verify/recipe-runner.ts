import type {
  PaseoBrowserConfig,
  PaseoRecipeStep,
  PaseoVerificationConfig,
} from "@getpaseo/protocol/paseo-config-schema";
import type {
  BrowserAutomationCommand,
  BrowserAutomationConsoleLogEntry,
  BrowserAutomationNetworkLogEntry,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserActivityStep } from "@getpaseo/protocol/browser-activity/rpc-schemas";

import {
  assertCredentialOriginAllowed,
  resolveCredential,
  type ResolvedCredential,
} from "./credential-broker.js";
import { createSecretRedactor, type SecretRedactor } from "./secret-redaction.js";
import { EvidenceStore, formatEvidenceRef } from "./evidence-store.js";
import { findSnapshotRef } from "./page-snapshot.js";
import type { DaemonPlaywrightHost } from "./playwright-host.js";
import type { BrowserToolsResponsePayload } from "../browser-tools/errors.js";
import { interpolateRecipeParams } from "./recipe-params.js";
import { JevBrowserGoalRunner } from "../browser-tools/jev-goal-runner.js";
import type { TypeSafeDecisionSource } from "../browser-tools/jev-client.js";
import { SYSTEM_ONE_EXCLUDED_MESSAGE } from "../system-one/scope.js";
import type {
  BrowserActivityHub,
  BrowserActivityReporter,
  BrowserActivityRun,
} from "../browser-tools/browser-activity.js";

export interface RecipeCheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface RecipeStepTrace {
  action: string;
  ok: boolean;
  ms: number;
}

export interface VerifyRunResult {
  status: "pass" | "fail";
  recipe: string;
  workspaceId: string;
  runId: string | null;
  profile: string | null;
  authReused: boolean | null;
  route: string | null;
  checks: RecipeCheckResult[];
  consoleErrors: number;
  failedRequests: number;
  evidenceRef: string | null;
  rawBytes: number;
  agentBytes: number;
  error?: string;
}

export interface RecipeRunnerOptions {
  host: Pick<DaemonPlaywrightHost, "executeLocal">;
  evidence: EvidenceStore;
  resolveServiceUrl: (input: { workspaceId: string; service: string }) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  /** Enables `goal` steps; absent when System One is not available. */
  goal?: { decisionSource: TypeSafeDecisionSource; minConfidence: () => number };
  activity?: BrowserActivityHub;
}

export interface RunRecipeInput {
  workspaceId: string;
  browser: PaseoBrowserConfig;
  verification: PaseoVerificationConfig;
  recipeName: string;
  params?: Record<string, string>;
  /** False for projects excluded from System One: goal steps then fail closed. */
  allowGoal?: boolean;
}

interface RunContext {
  workspaceId: string;
  runId: string;
  profile: string;
  browser: PaseoBrowserConfig;
  redactor: SecretRedactor;
  credentials: Map<string, ResolvedCredential>;
  browserId: string | null;
  route: string | null;
  authReused: boolean | null;
  checks: RecipeCheckResult[];
  trace: RecipeStepTrace[];
  rawArtifactBytes: number;
  allowGoal: boolean;
  activity: BrowserActivityRun | null;
}

const DEFAULT_WAIT_TEXT_TIMEOUT_MS = 15_000;
const ASSERT_TEXT_TIMEOUT_MS = 3_000;

function redactConsoleEntry(
  entry: BrowserAutomationConsoleLogEntry,
  redact: (text: string) => string,
): BrowserAutomationConsoleLogEntry {
  const redacted: BrowserAutomationConsoleLogEntry = {
    level: entry.level,
    message: redact(entry.message),
    timestamp: entry.timestamp,
  };
  if (entry.source !== undefined) {
    redacted.source = entry.source;
  }
  if (entry.line !== undefined) {
    redacted.line = entry.line;
  }
  return redacted;
}

function redactNetworkEntry(
  entry: BrowserAutomationNetworkLogEntry,
  redact: (text: string) => string,
): BrowserAutomationNetworkLogEntry {
  const redacted: BrowserAutomationNetworkLogEntry = {
    url: redact(entry.url),
    startTime: entry.startTime,
    duration: entry.duration,
  };
  if (entry.method !== undefined) {
    redacted.method = entry.method;
  }
  if (entry.status !== undefined) {
    redacted.status = entry.status;
  }
  if (entry.type !== undefined) {
    redacted.type = entry.type;
  }
  if (entry.transferSize !== undefined) {
    redacted.transferSize = entry.transferSize;
  }
  return redacted;
}

export class RecipeRunner {
  private readonly host: Pick<DaemonPlaywrightHost, "executeLocal">;
  private readonly evidence: EvidenceStore;
  private readonly resolveServiceUrl: RecipeRunnerOptions["resolveServiceUrl"];
  private readonly env: NodeJS.ProcessEnv;
  private readonly goal: RecipeRunnerOptions["goal"];
  private readonly activity: BrowserActivityHub | undefined;

  public constructor(options: RecipeRunnerOptions) {
    this.goal = options.goal;
    this.activity = options.activity;
    this.host = options.activity
      ? { executeLocal: options.activity.guard((input) => options.host.executeLocal(input)) }
      : options.host;
    this.evidence = options.evidence;
    this.resolveServiceUrl = options.resolveServiceUrl;
    this.env = options.env ?? process.env;
  }

  public async run(input: RunRecipeInput): Promise<VerifyRunResult> {
    const recipe = input.verification.recipes[input.recipeName];
    if (!recipe) {
      return setupFailure({
        recipe: input.recipeName,
        workspaceId: input.workspaceId,
        error: `Unknown recipe "${input.recipeName}"`,
      });
    }
    const interpolated = interpolateRecipeParams({ recipe, params: input.params ?? {} });
    if (!interpolated.ok) {
      return setupFailure({
        recipe: input.recipeName,
        workspaceId: input.workspaceId,
        error: interpolated.error,
      });
    }
    const profile = recipe.profile ?? input.browser.defaultProfile ?? "default";
    const manifest = await this.evidence.createRun({
      workspaceId: input.workspaceId,
      recipe: input.recipeName,
    });
    const context: RunContext = {
      workspaceId: input.workspaceId,
      runId: manifest.runId,
      profile,
      browser: input.browser,
      redactor: createSecretRedactor(),
      credentials: new Map(),
      browserId: null,
      route: null,
      authReused: null,
      checks: [],
      trace: [],
      rawArtifactBytes: 0,
      allowGoal: input.allowGoal ?? true,
      activity: null,
    };
    const startedAt = Date.now();
    let failedCheck: RecipeCheckResult | null = null;
    const recipeSteps = interpolated.recipe.steps;
    let plan = recipeSteps.map((step) => describeRecipeStep(step, context.redactor));
    try {
      for (const [index, step] of recipeSteps.entries()) {
        await this.reportStep({ context, recipeName: input.recipeName, plan, index });
        plan = withStatus(plan, index, "active");
        const stepStartedAt = Date.now();
        const check = await this.runStep(context, step);
        context.trace.push({ action: step.action, ok: check.ok, ms: Date.now() - stepStartedAt });
        plan = withStatus(plan, index, check.ok ? "done" : "failed");
        if (!check.ok) {
          failedCheck = check;
          context.checks.push(check);
          break;
        }
        if (check.name.length > 0) {
          context.checks.push(check);
        }
      }
    } catch (error) {
      context.activity?.finish({
        status: "failed",
        message: context.redactor.redact(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    }
    const status = failedCheck ? "fail" : "pass";
    finishActivity(context, failedCheck, recipeSteps.length);
    await this.writeRunEvidence({ context, recipeName: input.recipeName, status, startedAt });
    await this.evidence.finishRun({ runId: manifest.runId, status });
    const counts = await this.finalLogCounts(context);
    const redactedChecks = context.checks.map((check) => ({
      ...check,
      ...(check.detail ? { detail: context.redactor.redact(check.detail) } : {}),
    }));
    const result: VerifyRunResult = {
      status,
      recipe: input.recipeName,
      workspaceId: input.workspaceId,
      runId: manifest.runId,
      profile: context.profile,
      authReused: context.authReused,
      route: context.route,
      checks: redactedChecks,
      consoleErrors: counts.consoleErrors,
      failedRequests: counts.failedRequests,
      evidenceRef: formatEvidenceRef({ workspaceId: input.workspaceId, runId: manifest.runId }),
      rawBytes: context.rawArtifactBytes,
      agentBytes: 0,
      ...(failedCheck && failedCheck.name === "setup"
        ? { error: context.redactor.redact(failedCheck.detail ?? "Setup failed") }
        : {}),
    };
    result.agentBytes = Buffer.byteLength(JSON.stringify({ ...result, agentBytes: 0 }), "utf8");
    return result;
  }

  /**
   * Opens the activity run once a tab exists, then pauses between steps on takeover.
   * Every step after a pause resolves its refs from a new snapshot; the extra snapshot here
   * also confirms the tab survived the takeover before the recipe continues.
   */
  private async reportStep(input: {
    context: RunContext;
    recipeName: string;
    plan: BrowserActivityStep[];
    index: number;
  }): Promise<void> {
    const { context, plan, index } = input;
    if (!context.activity && context.browserId && this.activity) {
      context.activity = this.activity.start({
        workspaceId: context.workspaceId,
        browserId: context.browserId,
        kind: "recipe",
        label: input.recipeName,
        totalSteps: plan.length,
        steps: plan,
      });
    }
    const activity = context.activity;
    if (!activity || !context.browserId) return;
    if (await activity.checkpoint()) {
      activity.update({ phase: "observing" });
      await this.execute(context, { command: "snapshot", args: { browserId: context.browserId } });
    }
    const current = plan[index];
    const next = plan[index + 1];
    activity.update({
      phase: current && isCheckStep(current.operation) ? "verifying" : "executing",
      step: index + 1,
      action: current ? { ...current, status: "active" } : null,
      next: next ?? null,
      steps: withStatus(plan, index, "active"),
    });
  }

  private async writeRunEvidence(input: {
    context: RunContext;
    recipeName: string;
    status: "pass" | "fail";
    startedAt: number;
  }): Promise<void> {
    const { context } = input;
    if (context.browserId) {
      const logs = await this.execute(context, {
        command: "logs",
        args: { browserId: context.browserId, maxEntries: 200 },
      });
      if (logs.ok && logs.result.command === "logs") {
        await this.writeJsonArtifact({
          context,
          name: "console",
          kind: "console-log",
          value: logs.result.console.map((entry) =>
            redactConsoleEntry(entry, (text) => context.redactor.redact(text)),
          ),
        });
        await this.writeJsonArtifact({
          context,
          name: "network",
          kind: "network-log",
          value: logs.result.network.map((entry) =>
            redactNetworkEntry(entry, (text) => context.redactor.redact(text)),
          ),
        });
      }
    }
    await this.writeJsonArtifact({
      context,
      name: "report",
      kind: "report",
      value: {
        status: input.status,
        recipe: input.recipeName,
        workspaceId: context.workspaceId,
        profile: context.profile,
        authReused: context.authReused,
        route: context.route,
        checks: context.checks.map((check) => ({
          ...check,
          ...(check.detail ? { detail: context.redactor.redact(check.detail) } : {}),
        })),
        trace: context.trace,
        durationMs: Date.now() - input.startedAt,
      },
    });
  }

  private async writeJsonArtifact(input: {
    context: RunContext;
    name: string;
    kind: "console-log" | "network-log" | "report";
    value: unknown;
  }): Promise<void> {
    const entry = await this.evidence.writeArtifact({
      runId: input.context.runId,
      name: input.name,
      kind: input.kind,
      contentType: "application/json",
      data: JSON.stringify(input.value, null, 2),
    });
    input.context.rawArtifactBytes += entry.bytes;
  }

  private async finalLogCounts(context: RunContext): Promise<{
    consoleErrors: number;
    failedRequests: number;
  }> {
    if (!context.browserId) {
      return { consoleErrors: 0, failedRequests: 0 };
    }
    const logs = await this.execute(context, {
      command: "logs",
      args: { browserId: context.browserId, maxEntries: 200 },
    });
    if (!logs.ok || logs.result.command !== "logs") {
      return { consoleErrors: 0, failedRequests: 0 };
    }
    return {
      consoleErrors: logs.result.console.filter((entry) => entry.level === "error").length,
      failedRequests: logs.result.network.filter(
        (entry) =>
          !isIgnorableRequestUrl(entry.url) && (entry.status === undefined || entry.status >= 400),
      ).length,
    };
  }

  private async runStep(context: RunContext, step: PaseoRecipeStep): Promise<RecipeCheckResult> {
    switch (step.action) {
      case "navigate":
        return this.runNavigateStep(context, step);
      case "ensure-authenticated":
        return this.ensureAuthenticated(context, step);
      case "click":
        return this.runClickStep(context, step);
      case "fill":
        return this.runFillStep(context, step);
      case "wait-text":
        return this.runWaitTextStep(context, step);
      case "assert-visible":
        return this.runAssertVisibleStep(context, step);
      case "assert-text":
        return this.runAssertTextStep(context, step);
      case "assert-console-errors":
        return this.assertConsoleCount({
          context,
          name: "console errors",
          max: step.max,
        });
      case "assert-failed-requests":
        return this.assertNetworkCount({
          context,
          name: "failed requests",
          max: step.max,
        });
      case "screenshot":
        return this.runScreenshotStep(context, step);
      case "goal":
        return this.runGoalStep(context, step);
    }
  }

  private async runGoalStep(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "goal" }>,
  ): Promise<RecipeCheckResult> {
    const name = `goal "${step.goal}"`;
    if (!this.goal) {
      return fail(name, "Goal steps need System One enabled in Paseo Settings → System One.");
    }
    if (!context.allowGoal) {
      return fail(name, SYSTEM_ONE_EXCLUDED_MESSAGE);
    }
    if (!context.browserId) {
      return fail(name, "Open a page with a navigate step before a goal step.");
    }
    const runner = new JevBrowserGoalRunner({
      broker: { execute: ({ command }) => this.execute(context, command) },
      decisionSource: this.goal.decisionSource,
    });
    try {
      const result = await runner.run(
        {
          goal: step.goal,
          browserId: context.browserId,
          verify: step.verify,
          ...(step.values ? { values: step.values } : {}),
          ...(step.maxSteps ? { maxSteps: step.maxSteps } : {}),
          minConfidence: this.goal.minConfidence(),
        },
        { workspaceId: context.workspaceId },
        context.activity ? goalStepReporter(context.activity, step.goal) : undefined,
      );
      context.route = result.url;
      const detail = `${result.status} after ${result.steps.length} Jev steps: ${result.message}`;
      return result.status === "passed" ? { name, ok: true, detail } : fail(name, detail);
    } catch (error) {
      return fail(name, error instanceof Error ? error.message : String(error));
    }
  }

  private async runNavigateStep(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "navigate" }>,
  ): Promise<RecipeCheckResult> {
    const url = await this.resolveTargetUrl(context, {
      url: step.url,
      service: step.service,
      path: step.path,
    });
    if (!url.ok) {
      return url.check;
    }
    try {
      await this.withTab(context, url.url);
      return { name: "", ok: true };
    } catch (error) {
      return fail("navigate", error instanceof Error ? error.message : String(error));
    }
  }

  private async runClickStep(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "click" }>,
  ): Promise<RecipeCheckResult> {
    const ref = await this.resolveRef(context, { role: step.role, name: step.name });
    if (!ref.ok) {
      return ref.check;
    }
    const payload = await this.execute(context, {
      command: "click",
      args: {
        browserId: ref.browserId,
        ref: ref.ref,
        button: "left",
        doubleClick: false,
        modifiers: [],
      },
    });
    return payload.ok
      ? { name: "", ok: true }
      : fail(`click ${step.role} "${step.name}"`, payload.error.message);
  }

  private async runFillStep(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "fill" }>,
  ): Promise<RecipeCheckResult> {
    const ref = await this.resolveRef(context, { role: step.role, name: step.name });
    if (!ref.ok) {
      return ref.check;
    }
    const value = await this.resolveFillValue(context, step);
    if (!value.ok) {
      return value.check;
    }
    const payload = await this.execute(context, {
      command: "fill",
      args: { browserId: ref.browserId, ref: ref.ref, value: value.value },
    });
    return payload.ok
      ? { name: "", ok: true }
      : fail(`fill ${step.role} "${step.name}"`, payload.error.message);
  }

  private async runWaitTextStep(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "wait-text" }>,
  ): Promise<RecipeCheckResult> {
    if (!context.browserId) {
      return fail("wait-text", "No browser tab open");
    }
    const payload = await this.execute(context, {
      command: "wait",
      args: {
        browserId: context.browserId,
        text: step.text,
        timeoutMs: step.timeoutMs ?? DEFAULT_WAIT_TEXT_TIMEOUT_MS,
      },
    });
    return payload.ok
      ? { name: "", ok: true }
      : fail(`wait for text "${step.text}"`, payload.error.message);
  }

  private async runAssertVisibleStep(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "assert-visible" }>,
  ): Promise<RecipeCheckResult> {
    const ref = await this.resolveRef(context, { role: step.role, name: step.name });
    if (!ref.ok) {
      return {
        name: `${step.role} "${step.name}" visible`,
        ok: false,
        detail: ref.check.detail,
      };
    }
    return { name: `${step.role} "${step.name}" visible`, ok: true };
  }

  private async runAssertTextStep(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "assert-text" }>,
  ): Promise<RecipeCheckResult> {
    if (!context.browserId) {
      return fail("assert-text", "No browser tab open");
    }
    const payload = await this.execute(context, {
      command: "wait",
      args: { browserId: context.browserId, text: step.text, timeoutMs: ASSERT_TEXT_TIMEOUT_MS },
    });
    return payload.ok
      ? { name: `text "${step.text}" visible`, ok: true }
      : { name: `text "${step.text}" visible`, ok: false, detail: `Text "${step.text}" not found` };
  }

  private async runScreenshotStep(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "screenshot" }>,
  ): Promise<RecipeCheckResult> {
    if (!context.browserId) {
      return fail("screenshot", "No browser tab open");
    }
    const payload = await this.execute(context, {
      command: "screenshot",
      args: {
        browserId: context.browserId,
        fullPage: false,
        reveal: false,
        runId: context.runId,
        artifactName: `screenshot-${step.name}`,
      },
    });
    if (!payload.ok || payload.result.command !== "screenshot") {
      return fail(
        "screenshot",
        payload.ok ? "Unexpected screenshot result" : payload.error.message,
      );
    }
    if (!payload.result.evidenceRef) {
      return fail("screenshot", "Screenshot returned no evidence reference");
    }
    context.rawArtifactBytes += payload.result.bytes ?? 0;
    return { name: `screenshot ${step.name}`, ok: true };
  }

  private async ensureAuthenticated(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "ensure-authenticated" }>,
  ): Promise<RecipeCheckResult> {
    const target = await this.resolveAuthTarget(context, step);
    if (!target.ok) {
      return target.check;
    }
    const reused = await this.tryReuseSession(context, step, target.checkUrl);
    if (reused) {
      return reused;
    }
    const loggedIn = await this.performLogin(context, step, target);
    if (loggedIn) {
      return loggedIn;
    }
    return this.confirmAuthenticated(context, step, target);
  }

  private async resolveAuthTarget(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "ensure-authenticated" }>,
  ): Promise<
    | {
        ok: true;
        checkUrl: string;
        loginUrl: string;
        credentialName: string;
        credential: ResolvedCredential;
      }
    | { ok: false; check: RecipeCheckResult }
  > {
    const checkUrl = await this.resolveTargetUrl(context, step.check);
    if (!checkUrl.ok) {
      return { ok: false, check: checkUrl.check };
    }
    const loginUrl = await this.resolveTargetUrl(context, step.login);
    if (!loginUrl.ok) {
      return { ok: false, check: loginUrl.check };
    }
    const credentialName = step.credential;
    const definition = context.browser.credentials[credentialName];
    if (!definition) {
      return { ok: false, check: fail("authentication", `Unknown credential "${credentialName}"`) };
    }
    let credential: ResolvedCredential;
    try {
      credential = this.cachedCredential(context, credentialName, definition);
    } catch (error) {
      return {
        ok: false,
        check: fail("authentication", error instanceof Error ? error.message : String(error)),
      };
    }
    for (const url of [checkUrl.url, loginUrl.url]) {
      try {
        assertCredentialOriginAllowed({ url, definition });
      } catch (error) {
        return {
          ok: false,
          check: fail("authentication", error instanceof Error ? error.message : String(error)),
        };
      }
    }
    return { ok: true, checkUrl: checkUrl.url, loginUrl: loginUrl.url, credentialName, credential };
  }

  private async tryReuseSession(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "ensure-authenticated" }>,
    checkUrl: string,
  ): Promise<RecipeCheckResult | null> {
    try {
      await this.withTab(context, checkUrl);
    } catch (error) {
      return fail("authentication", error instanceof Error ? error.message : String(error));
    }
    if (
      context.browserId &&
      (await this.isVisible(context, context.browserId, step.check.visible))
    ) {
      context.authReused = true;
      return { name: "authentication", ok: true, detail: "reused session" };
    }
    return null;
  }

  private async performLogin(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "ensure-authenticated" }>,
    target: { loginUrl: string; credentialName: string; credential: ResolvedCredential },
  ): Promise<RecipeCheckResult | null> {
    try {
      await this.withTab(context, target.loginUrl);
    } catch (error) {
      return fail("authentication", error instanceof Error ? error.message : String(error));
    }
    const refs = await this.resolveLoginRefs(context, step);
    if (!refs.ok) {
      return refs.check;
    }
    const filled = await this.fillLoginForm(context, target, refs);
    if (filled) {
      return filled;
    }
    if (step.login.successText) {
      const waited = await this.execute(context, {
        command: "wait",
        args: {
          browserId: refs.submit.browserId,
          text: step.login.successText,
          timeoutMs: DEFAULT_WAIT_TEXT_TIMEOUT_MS,
        },
      });
      if (!waited.ok) {
        return fail(
          "authentication",
          `login failed for "${target.credentialName}": success text not found`,
        );
      }
    }
    return null;
  }

  private async resolveLoginRefs(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "ensure-authenticated" }>,
  ): Promise<
    | {
        ok: true;
        username: { browserId: string; ref: string };
        password: { browserId: string; ref: string };
        submit: { browserId: string; ref: string };
      }
    | { ok: false; check: RecipeCheckResult }
  > {
    const usernameRef = await this.resolveRef(context, step.login.username);
    if (!usernameRef.ok) {
      return {
        ok: false,
        check: fail(
          "authentication",
          `Login form incomplete: ${usernameRef.check.detail ?? "username field missing"}`,
        ),
      };
    }
    const passwordRef = await this.resolveRef(context, step.login.password);
    if (!passwordRef.ok) {
      return {
        ok: false,
        check: fail(
          "authentication",
          `Login form incomplete: ${passwordRef.check.detail ?? "password field missing"}`,
        ),
      };
    }
    const submitRef = await this.resolveRef(context, step.login.submit);
    if (!submitRef.ok) {
      return {
        ok: false,
        check: fail(
          "authentication",
          `Login form incomplete: ${submitRef.check.detail ?? "submit button missing"}`,
        ),
      };
    }
    return {
      ok: true,
      username: { browserId: usernameRef.browserId, ref: usernameRef.ref },
      password: { browserId: passwordRef.browserId, ref: passwordRef.ref },
      submit: { browserId: submitRef.browserId, ref: submitRef.ref },
    };
  }

  private async fillLoginForm(
    context: RunContext,
    target: { credentialName: string; credential: ResolvedCredential },
    refs: {
      username: { browserId: string; ref: string };
      password: { browserId: string; ref: string };
      submit: { browserId: string; ref: string };
    },
  ): Promise<RecipeCheckResult | null> {
    const fillUser = await this.execute(context, {
      command: "fill",
      args: {
        browserId: refs.username.browserId,
        ref: refs.username.ref,
        value: target.credential.username,
      },
    });
    if (!fillUser.ok) {
      return fail(
        "authentication",
        `login failed for "${target.credentialName}": ${fillUser.error.message}`,
      );
    }
    if (target.credential.password === undefined) {
      return fail("authentication", `Credential "${target.credentialName}" has no password`);
    }
    const fillPassword = await this.execute(context, {
      command: "fill",
      args: {
        browserId: refs.password.browserId,
        ref: refs.password.ref,
        value: target.credential.password,
      },
    });
    if (!fillPassword.ok) {
      return fail(
        "authentication",
        `login failed for "${target.credentialName}": ${fillPassword.error.message}`,
      );
    }
    const submit = await this.execute(context, {
      command: "click",
      args: {
        browserId: refs.submit.browserId,
        ref: refs.submit.ref,
        button: "left",
        doubleClick: false,
        modifiers: [],
      },
    });
    if (!submit.ok) {
      return fail(
        "authentication",
        `login failed for "${target.credentialName}": ${submit.error.message}`,
      );
    }
    return null;
  }

  private async confirmAuthenticated(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "ensure-authenticated" }>,
    target: { checkUrl: string; loginUrl: string; credentialName: string },
  ): Promise<RecipeCheckResult> {
    try {
      await this.withTab(context, target.checkUrl);
    } catch (error) {
      return fail("authentication", error instanceof Error ? error.message : String(error));
    }
    if (
      context.browserId &&
      (await this.isVisible(context, context.browserId, step.check.visible))
    ) {
      context.authReused = false;
      return { name: "authentication", ok: true, detail: "fresh login" };
    }
    return fail(
      "authentication",
      `login failed for "${target.credentialName}" at ${target.loginUrl}`,
    );
  }

  private cachedCredential(
    context: RunContext,
    name: string,
    definition: { usernameEnv: string; passwordEnv?: string; allowedOrigins: string[] },
  ): ResolvedCredential {
    const cached = context.credentials.get(name);
    if (cached) {
      return cached;
    }
    const credential = resolveCredential({ name, definition, env: this.env });
    context.redactor.addSecret(credential.username);
    if (credential.password) {
      context.redactor.addSecret(credential.password);
    }
    context.credentials.set(name, credential);
    return credential;
  }

  private async isVisible(
    context: RunContext,
    browserId: string,
    target: { role: string; name: string },
  ): Promise<boolean> {
    const snapshot = await this.execute(context, { command: "snapshot", args: { browserId } });
    if (!snapshot.ok || snapshot.result.command !== "snapshot") {
      return false;
    }
    return findSnapshotRef(snapshotNodesFromYaml(snapshot.result.snapshot), target) !== null;
  }

  private async resolveRef(
    context: RunContext,
    target: { role: string; name: string },
  ): Promise<
    { ok: true; browserId: string; ref: string } | { ok: false; check: RecipeCheckResult }
  > {
    if (!context.browserId) {
      return { ok: false, check: fail(`${target.role} "${target.name}"`, "No browser tab open") };
    }
    const snapshot = await this.execute(context, {
      command: "snapshot",
      args: { browserId: context.browserId },
    });
    if (!snapshot.ok || snapshot.result.command !== "snapshot") {
      return {
        ok: false,
        check: fail(
          `${target.role} "${target.name}"`,
          snapshot.ok ? "Snapshot failed" : snapshot.error.message,
        ),
      };
    }
    const ref = findSnapshotRef(snapshotNodesFromYaml(snapshot.result.snapshot), target);
    if (!ref) {
      return {
        ok: false,
        check: fail(
          `${target.role} "${target.name}"`,
          `Element ${target.role} "${target.name}" not found`,
        ),
      };
    }
    return { ok: true, browserId: context.browserId, ref };
  }

  private async resolveFillValue(
    context: RunContext,
    step: Extract<PaseoRecipeStep, { action: "fill" }>,
  ): Promise<{ ok: true; value: string } | { ok: false; check: RecipeCheckResult }> {
    if (step.value !== undefined) {
      return { ok: true, value: step.value };
    }
    if (step.credential && step.credentialField) {
      const definition = context.browser.credentials[step.credential];
      if (!definition) {
        return { ok: false, check: fail("fill", `Unknown credential "${step.credential}"`) };
      }
      try {
        const credential = this.cachedCredential(context, step.credential, definition);
        const value =
          step.credentialField === "username" ? credential.username : credential.password;
        if (value === undefined) {
          return {
            ok: false,
            check: fail("fill", `Credential "${step.credential}" has no ${step.credentialField}`),
          };
        }
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          check: fail("fill", error instanceof Error ? error.message : String(error)),
        };
      }
    }
    return { ok: false, check: fail("fill", "Fill needs a value or a credential source") };
  }

  private async resolveTargetUrl(
    context: RunContext,
    target: { url?: string; service?: string; path?: string },
  ): Promise<{ ok: true; url: string } | { ok: false; check: RecipeCheckResult }> {
    if (target.url) {
      return { ok: true, url: target.url };
    }
    if (target.service) {
      const base = await this.resolveServiceUrl({
        workspaceId: context.workspaceId,
        service: target.service,
      });
      if (!base) {
        return {
          ok: false,
          check: fail("setup", `Service "${target.service}" is not running for this workspace`),
        };
      }
      return { ok: true, url: joinUrl(base, target.path ?? "/") };
    }
    return { ok: false, check: fail("setup", "Recipe target needs a url or a service") };
  }

  private async withTab(context: RunContext, url: string): Promise<string> {
    if (!context.browserId) {
      const created = await this.host.executeLocal({
        workspaceId: context.workspaceId,
        profile: context.profile,
        command: { command: "new_tab", args: { url } },
      });
      if (!created.ok || created.result.command !== "new_tab") {
        throw new Error(created.ok ? "Failed to open browser tab" : created.error.message);
      }
      context.browserId = created.result.browserId;
      context.route = url;
      return created.result.browserId;
    }
    const navigated = await this.host.executeLocal({
      workspaceId: context.workspaceId,
      profile: context.profile,
      command: { command: "navigate", args: { browserId: context.browserId, url } },
    });
    if (!navigated.ok) {
      throw new Error(navigated.error.message);
    }
    context.route = url;
    return context.browserId;
  }

  private async assertConsoleCount(input: {
    context: RunContext;
    name: string;
    max: number;
  }): Promise<RecipeCheckResult> {
    const logs = await this.readLogs(input.context, input.name);
    if (!logs.ok) {
      return logs.check;
    }
    const entries = logs.console.filter((entry) => entry.level === "error");
    if (entries.length <= input.max) {
      return { name: input.name, ok: true };
    }
    return {
      name: input.name,
      ok: false,
      detail: `${entries.length} ${input.name} (max ${input.max}): ${entries
        .slice(0, 3)
        .map((entry) => entry.message)
        .join(" | ")}`,
    };
  }

  private async assertNetworkCount(input: {
    context: RunContext;
    name: string;
    max: number;
  }): Promise<RecipeCheckResult> {
    const logs = await this.readLogs(input.context, input.name);
    if (!logs.ok) {
      return logs.check;
    }
    const entries = logs.network.filter(
      (entry) =>
        !isIgnorableRequestUrl(entry.url) && (entry.status === undefined || entry.status >= 400),
    );
    if (entries.length <= input.max) {
      return { name: input.name, ok: true };
    }
    return {
      name: input.name,
      ok: false,
      detail: `${entries.length} ${input.name} (max ${input.max}): ${entries
        .slice(0, 3)
        .map((entry) => `${entry.url}${entry.status ? ` (${entry.status})` : " (failed)"}`)
        .join(" | ")}`,
    };
  }

  private async readLogs(
    context: RunContext,
    name: string,
  ): Promise<
    | {
        ok: true;
        console: BrowserAutomationConsoleLogEntry[];
        network: BrowserAutomationNetworkLogEntry[];
      }
    | { ok: false; check: RecipeCheckResult }
  > {
    if (!context.browserId) {
      return { ok: false, check: fail(name, "No browser tab open") };
    }
    const logs = await this.execute(context, {
      command: "logs",
      args: { browserId: context.browserId, maxEntries: 200 },
    });
    if (!logs.ok || logs.result.command !== "logs") {
      return { ok: false, check: fail(name, logs.ok ? "Logs unavailable" : logs.error.message) };
    }
    return { ok: true, console: logs.result.console, network: logs.result.network };
  }

  private async execute(
    context: RunContext,
    command: BrowserAutomationCommand,
  ): Promise<BrowserToolsResponsePayload> {
    return this.host.executeLocal({
      workspaceId: context.workspaceId,
      profile: context.profile,
      command,
    });
  }
}

function finishActivity(
  context: RunContext,
  failedCheck: RecipeCheckResult | null,
  stepCount: number,
): void {
  context.activity?.finish(
    failedCheck
      ? {
          status: "failed",
          message: context.redactor.redact(
            `${failedCheck.name}: ${failedCheck.detail ?? "failed"}`,
          ),
        }
      : { status: "passed", message: `All ${stepCount} steps passed.` },
  );
}

// Jev's live action stands in for the goal step; the recipe keeps its own step index and plan.
function goalStepReporter(run: BrowserActivityRun, goal: string): BrowserActivityReporter {
  const goalStep: BrowserActivityStep = { operation: "goal", detail: goal, status: "active" };
  return {
    update: (patch) =>
      run.update({
        phase: patch.phase,
        ...(patch.action !== undefined ? { action: patch.action ?? goalStep } : {}),
      }),
    checkpoint: () => run.checkpoint(),
  };
}

function isCheckStep(operation: string): boolean {
  return operation.startsWith("assert-") || operation === "wait-text";
}

function withStatus(
  plan: BrowserActivityStep[],
  index: number,
  status: BrowserActivityStep["status"],
): BrowserActivityStep[] {
  return plan.map((step, stepIndex) => (stepIndex === index ? { ...step, status } : step));
}

// Names what a step does without values: fills show the credential slot, URLs drop query and hash.
function describeRecipeStep(step: PaseoRecipeStep, redactor: SecretRedactor): BrowserActivityStep {
  const base = { operation: step.action, status: "pending" as const };
  const redact = (text: string) => redactor.redact(text);
  switch (step.action) {
    case "navigate":
      return { ...base, detail: redact(describeTarget(step)) };
    case "ensure-authenticated":
      return { ...base, valueSlot: step.credential, detail: redact(describeTarget(step.check)) };
    case "click":
    case "assert-visible":
      return { ...base, target: { role: step.role, name: redact(step.name) } };
    case "fill":
      return {
        ...base,
        target: { role: step.role, name: redact(step.name) },
        ...(step.credential && step.credentialField
          ? { valueSlot: `${step.credential}.${step.credentialField}` }
          : {}),
      };
    case "wait-text":
    case "assert-text":
      return { ...base, detail: redact(step.text) };
    case "assert-console-errors":
    case "assert-failed-requests":
      return { ...base, detail: `max ${step.max}` };
    case "screenshot":
      return { ...base, detail: step.name };
    case "goal":
      return { ...base, detail: redact(step.goal) };
  }
}

function describeTarget(target: { url?: string; service?: string; path?: string }): string {
  if (target.service) {
    return `${target.service}${stripQuery(target.path ?? "/")}`;
  }
  if (!target.url) return "";
  try {
    const url = new URL(target.url);
    return `${url.origin}${url.pathname}`;
  } catch {
    return stripQuery(target.url);
  }
}

function stripQuery(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? "";
}

function setupFailure(input: {
  recipe: string;
  workspaceId: string;
  error: string;
}): VerifyRunResult {
  return {
    status: "fail",
    recipe: input.recipe,
    workspaceId: input.workspaceId,
    runId: null,
    profile: null,
    authReused: null,
    route: null,
    checks: [{ name: "setup", ok: false, detail: input.error }],
    consoleErrors: 0,
    failedRequests: 0,
    evidenceRef: null,
    rawBytes: 0,
    agentBytes: Buffer.byteLength(JSON.stringify({ status: "fail", error: input.error }), "utf8"),
    error: input.error,
  };
}

function fail(name: string, detail: string): RecipeCheckResult {
  return { name, ok: false, detail };
}

// Browsers fetch /favicon.ico unprompted and its timing races log capture, so a
// missing favicon must never fail a UI verification. The raw network log keeps
// the entry; only the failed-request assertion and counts ignore it.
function isIgnorableRequestUrl(url: string): boolean {
  try {
    return new URL(url).pathname === "/favicon.ico";
  } catch {
    return false;
  }
}

function joinUrl(base: string, targetPath: string): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const normalizedPath = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
  return `${normalizedBase}${normalizedPath}`;
}

function snapshotNodesFromYaml(
  yaml: string,
): Array<{ role: string; name: string; selector: string; ref: string }> {
  const nodes: Array<{ role: string; name: string; selector: string; ref: string }> = [];
  for (const line of yaml.split("\n")) {
    const match = /^- (\S+) "(.*)" (@e\d+)$/.exec(line.trim());
    if (match?.[1] && match[3]) {
      nodes.push({
        role: match[1],
        name: (match[2] ?? "").replace(/\\"/g, '"'),
        selector: "",
        ref: match[3],
      });
    }
  }
  return nodes;
}
