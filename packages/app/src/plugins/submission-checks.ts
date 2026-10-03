import type {
  PluginSubmissionCheckInput,
  PluginSubmissionCheckContribution,
  PluginSubmissionChoice,
  PluginSubmissionDecision,
  PluginSubmissionTarget,
} from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "./types";
import { SubmissionCancelledError } from "./submission-decision";

const running = new WeakMap<InstalledPlugin, Set<string>>();
const requests = new Map<
  string,
  {
    fingerprint: string;
    checks: readonly PluginSubmissionCheckContribution[];
    result: Promise<PluginSubmissionTarget | void>;
  }
>();

export function runSubmissionChecks(options: {
  plugins: readonly InstalledPlugin[];
  serverId: string;
  input: PluginSubmissionCheckInput;
  signal: AbortSignal;
  caller?: InstalledPlugin;
  present(decision: PluginSubmissionDecision, signal: AbortSignal): Promise<PluginSubmissionChoice>;
}): Promise<PluginSubmissionTarget | void> {
  const { input, signal, caller } = options;
  if (caller && running.get(caller)?.has(input.idempotencyKey))
    return Promise.reject(new Error("Submission checks cannot recursively run themselves"));
  if (signal.aborted) return Promise.reject(new SubmissionCancelledError());
  const plugins = options.plugins.filter(
    (plugin) =>
      plugin.serverId === options.serverId &&
      !plugin.lifetime.signal.aborted &&
      plugin.submissionChecks?.length,
  );
  if (plugins.length === 0) return Promise.resolve();
  const key = `${options.serverId}:${input.idempotencyKey}`;
  const fingerprint = JSON.stringify(input);
  const checks = plugins.flatMap((plugin) => plugin.submissionChecks ?? []);
  const existing = requests.get(key);
  if (
    existing &&
    existing.fingerprint === fingerprint &&
    existing.checks.length === checks.length &&
    existing.checks.every((check, index) => check === checks[index])
  )
    return existing.result;
  const execute = async () => {
    let target: PluginSubmissionTarget | undefined;
    const contributions = plugins.flatMap((plugin) =>
      (plugin.submissionChecks ?? []).map((check) => ({ plugin, check })),
    );
    for (const { plugin, check } of contributions) {
      if (
        signal.aborted ||
        plugin.lifetime.signal.aborted ||
        !plugin.submissionChecks?.includes(check)
      )
        throw new SubmissionCancelledError();
      const controller = new AbortController();
      const abort = () => controller.abort();
      const assertActive = () => {
        if (controller.signal.aborted || !plugin.submissionChecks?.includes(check))
          throw new SubmissionCancelledError();
      };
      signal.addEventListener("abort", abort, { once: true });
      plugin.lifetime.signal.addEventListener("abort", abort, { once: true });
      const active = running.get(plugin) ?? new Set<string>();
      running.set(plugin, active);
      active.add(input.idempotencyKey);
      try {
        const checkedInput = target
          ? { ...input, ...target, projectName: undefined, projectRootPath: target.cwd }
          : input;
        const decision = await check.check(checkedInput, { signal: controller.signal });
        assertActive();
        if (!decision) continue;
        const choice = await options.present(decision, controller.signal);
        assertActive();
        const resolved = await check.resolve(checkedInput, choice, { signal: controller.signal });
        assertActive();
        if (resolved) {
          if (!resolved.cwd?.trim())
            throw new Error("Submission check returned no project directory");
          target = {
            cwd: resolved.cwd,
            ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
            ...(resolved.isolation ? { isolation: resolved.isolation } : {}),
          };
        }
      } finally {
        active.delete(input.idempotencyKey);
        signal.removeEventListener("abort", abort);
        plugin.lifetime.signal.removeEventListener("abort", abort);
      }
    }
    return target;
  };
  const result = Promise.resolve().then(execute);
  requests.set(key, { fingerprint, checks, result });
  if (requests.size > 32) requests.delete(requests.keys().next().value!);
  void result.catch(() => {
    if (requests.get(key)?.result === result) requests.delete(key);
  });
  return result;
}
