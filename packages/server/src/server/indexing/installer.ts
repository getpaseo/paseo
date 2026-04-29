import { spawn as nodeSpawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import type { Logger } from "pino";

import { OPENAI_COMPAT_PROVIDER_SOURCE } from "./openai-compat-patch-source.js";

const execFile = promisify(execFileCb);

/**
 * Installer for `code-review-graph`.
 *
 * We install from the Hubtool fork's `main` branch instead of PyPI because
 * the upstream PyPI release (v2.3.2) was cut from a snapshot that still had
 * three latent bugs (`'str' object has no attribute 'resolve'` in two MCP
 * tools and `'sqlite3.Row' object has no attribute 'get'` in
 * `find_knowledge_gaps`). The fork's `main` already contains the fixes;
 * tracking it gives Hubcode a stable place to land hotfixes without waiting
 * for upstream releases. Switch back to PyPI once a release ≥ that ships.
 *
 * Strategy chain (first viable wins):
 *   1. `pipx` available → `pipx install git+https://github.com/hubtool/code-review-graph.git`
 *   2. macOS + `brew` available → `brew install pipx && pipx install <git url>`
 *   3. otherwise → unsupported (UI keeps the copy-command fallback)
 *
 * Auto-sudo on Linux and Python bootstrap on Windows are intentionally
 * out of scope: the cost of getting them wrong silently (broken environments,
 * orphaned processes) outweighs the convenience. Those platforms fall
 * through to manual install with a one-click "Re-check" in the UI.
 */

export type InstallStrategy =
  | { kind: "pipx"; command: "pipx"; args: string[] }
  | { kind: "brew-then-pipx"; steps: Array<{ command: string; args: string[] }> }
  | { kind: "python3-bootstrap-pipx"; steps: Array<{ command: string; args: string[] }> }
  | { kind: "unsupported"; reason: string };

export interface InstallerDeps {
  logger: Logger;
  pipxAvailable: boolean;
  brewAvailable: boolean;
  python3Available: boolean;
  platform: NodeJS.Platform;
  /** Inject for tests. Default: node:child_process spawn + streaming. */
  runCommand?: (command: string, args: string[]) => AsyncIterable<CommandOutput>;
}

export interface CommandOutput {
  kind: "stdout" | "stderr" | "exit";
  text?: string;
  exitCode?: number | null;
}

export type InstallEvent =
  | { type: "plan"; strategy: InstallStrategy }
  | { type: "step-started"; command: string; args: string[]; index: number; total: number }
  | { type: "step-output"; stream: "stdout" | "stderr"; text: string }
  | { type: "step-completed"; command: string; exitCode: number | null }
  | { type: "completed"; success: boolean; error?: string };

export function planInstallStrategy(deps: {
  pipxAvailable: boolean;
  brewAvailable: boolean;
  python3Available: boolean;
  platform: NodeJS.Platform;
}): InstallStrategy {
  if (deps.pipxAvailable) {
    return {
      kind: "pipx",
      command: "pipx",
      args: ["install", "git+https://github.com/hubtool/code-review-graph.git"],
    };
  }
  if (deps.platform === "darwin" && deps.brewAvailable) {
    return {
      kind: "brew-then-pipx",
      steps: [
        { command: "brew", args: ["install", "pipx"] },
        { command: "pipx", args: ["ensurepath"] },
        {
          command: "pipx",
          args: ["install", "git+https://github.com/hubtool/code-review-graph.git"],
        },
      ],
    };
  }
  // Bootstrap pipx via Python's user-site pip when python3 ≥ 3.10 is on
  // PATH. Most distros (incl. macOS without brew) ship Python; this avoids
  // needing root. `--break-system-packages` opts in past PEP 668 — required
  // on Python 3.13's Apple-managed install and on Debian/Ubuntu, but safe
  // here because we scope to user-site (`--user`) and the user explicitly
  // clicked Install.
  if (deps.python3Available) {
    return {
      kind: "python3-bootstrap-pipx",
      steps: [
        {
          command: "python3",
          args: ["-m", "pip", "install", "--user", "--break-system-packages", "pipx"],
        },
        { command: "python3", args: ["-m", "pipx", "ensurepath"] },
        {
          command: "python3",
          args: ["-m", "pipx", "install", "git+https://github.com/hubtool/code-review-graph.git"],
        },
      ],
    };
  }
  return {
    kind: "unsupported",
    reason:
      deps.platform === "linux"
        ? "Auto-install requires Python 3.10+ or pipx. Install one, then re-check."
        : deps.platform === "win32"
          ? "Auto-install requires Python 3.10+ (via winget) or pipx. Install one, then re-check."
          : "Install Python 3.10+ or pipx, then re-check.",
  };
}

export async function* runCrgInstall(
  deps: InstallerDeps,
): AsyncGenerator<InstallEvent, void, void> {
  const { logger } = deps;
  const strategy = planInstallStrategy({
    pipxAvailable: deps.pipxAvailable,
    brewAvailable: deps.brewAvailable,
    python3Available: deps.python3Available,
    platform: deps.platform,
  });
  yield { type: "plan", strategy };
  if (strategy.kind === "unsupported") {
    yield { type: "completed", success: false, error: strategy.reason };
    return;
  }
  const steps =
    strategy.kind === "pipx"
      ? [{ command: strategy.command, args: strategy.args }]
      : strategy.kind === "brew-then-pipx" || strategy.kind === "python3-bootstrap-pipx"
        ? strategy.steps
        : [];
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const total = steps.length;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    yield { type: "step-started", command: step.command, args: step.args, index, total };
    let exitCode: number | null = null;
    try {
      for await (const out of runCommand(step.command, step.args)) {
        if (out.kind === "exit") {
          exitCode = out.exitCode ?? null;
          continue;
        }
        if (out.kind === "stdout" || out.kind === "stderr") {
          yield { type: "step-output", stream: out.kind, text: out.text ?? "" };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, step }, "Install step threw");
      yield { type: "step-completed", command: step.command, exitCode: null };
      yield {
        type: "completed",
        success: false,
        error: `${step.command}: ${message}`,
      };
      return;
    }
    yield { type: "step-completed", command: step.command, exitCode };
    if (exitCode !== 0) {
      yield {
        type: "completed",
        success: false,
        error: `${step.command} exited with code ${exitCode}`,
      };
      return;
    }
  }

  // Post-install: inject the openai-compat embedding provider patch into the
  // freshly-installed crg. Without this, `CRG_EMBEDDINGS_PROVIDER=openai-compat`
  // (which Hubcode sets when user picks "Hubcode Local" or "OpenAI-compatible")
  // has no effect on stock crg 2.3.2 → zero embeddings. Idempotent: safe to
  // run on every install/upgrade; if the file already exists with the same
  // content, it's a no-op.
  try {
    await injectOpenAICompatPatch(deps.logger);
  } catch (err) {
    // Patch failure shouldn't fail the overall install — structural tools
    // still work without embeddings. Log and surface a note in the final
    // event so the UI can show a warning.
    deps.logger?.warn({ err }, "Failed to inject openai-compat patch into crg");
    yield {
      type: "completed",
      success: true,
      error:
        "Install succeeded, but the embedding patch couldn't be applied. " +
        "Structural tools will work; semantic search will not until the " +
        "patch is applied or upstream crg ships the openai-compat provider.",
    };
    return;
  }

  yield { type: "completed", success: true };
}

async function* defaultRunCommand(command: string, args: string[]): AsyncIterable<CommandOutput> {
  const child = nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const queue: CommandOutput[] = [];
  let resolveWaiter: (() => void) | null = null;
  let done = false;
  let error: Error | null = null;
  const wake = () => {
    if (resolveWaiter) {
      const fn = resolveWaiter;
      resolveWaiter = null;
      fn();
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    queue.push({ kind: "stdout", text: chunk.toString() });
    wake();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    queue.push({ kind: "stderr", text: chunk.toString() });
    wake();
  });
  child.on("error", (err) => {
    error = err;
    done = true;
    wake();
  });
  child.on("close", (exitCode) => {
    queue.push({ kind: "exit", exitCode });
    done = true;
    wake();
  });
  while (!done || queue.length > 0) {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) yield item;
    }
    if (!done) {
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
      });
    }
  }
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// openai-compat patch — applied post-install to the freshly-installed crg.
//
// Rationale: crg 2.3.x ships only `local` / `google` / `minimax` embedding
// providers. Hubcode's UI exposes "Hubcode Local" and "OpenAI-compatible"
// options that assume an `openai-compat` provider exists. Rather than fork
// crg or require users to run a script, we bundle the provider module inside
// the daemon and copy it into the installed pipx venv after install.
//
// The patch is idempotent and safe to run on every install/upgrade. It
// detects the pipx venv path via `pipx environment --value PIPX_LOCAL_VENVS`,
// writes the provider module, and rewrites `embeddings.py` with the import +
// dispatch hook if they aren't already present.
//
// When upstream crg ships the provider natively, this whole block can be
// deleted — the bundled module + rewrites become no-ops against a patched
// embeddings.py (the marker-guards below skip duplicate edits).
// ---------------------------------------------------------------------------

async function injectOpenAICompatPatch(logger: Logger | undefined): Promise<void> {
  const sitePackagesDir = await findCrgSitePackagesDir();
  if (!sitePackagesDir) {
    logger?.debug("Skipping openai-compat patch — crg venv not found");
    return;
  }
  const providerPath = path.join(sitePackagesDir, "embeddings_openai_compat.py");
  const embeddingsPath = path.join(sitePackagesDir, "embeddings.py");

  // 1. Drop the provider module (idempotent overwrite).
  await fs.writeFile(providerPath, OPENAI_COMPAT_PROVIDER_SOURCE, "utf8");

  // 2. Rewrite embeddings.py with the dispatch hook, guarded by a marker so
  //    repeat installs don't stack edits.
  const contents = await fs.readFile(embeddingsPath, "utf8");
  if (contents.includes("# HUBCODE_OPENAI_COMPAT_PATCH")) {
    logger?.debug("openai-compat patch already applied");
    return;
  }
  const patched = applyEmbeddingsDispatchPatch(contents);
  if (patched === contents) {
    logger?.warn(
      { path: embeddingsPath },
      "openai-compat patch skipped — embeddings.py didn't match expected shape",
    );
    return;
  }
  await fs.writeFile(embeddingsPath, patched, "utf8");
  logger?.info({ sitePackagesDir }, "Applied openai-compat provider patch to crg");
}

async function findCrgSitePackagesDir(): Promise<string | null> {
  // Preferred: ask pipx where the venv lives.
  try {
    const { stdout } = await execFile("pipx", ["environment", "--value", "PIPX_LOCAL_VENVS"]);
    const venvsRoot = stdout.trim();
    if (venvsRoot) {
      const candidate = await resolveSitePackages(path.join(venvsRoot, "code-review-graph"));
      if (candidate) return candidate;
    }
  } catch {
    // Fall through to default-location probes.
  }
  // Fallback: try the documented default locations.
  const candidates = [
    path.join(process.env.HOME ?? "", ".local", "pipx", "venvs", "code-review-graph"),
    path.join(process.env.HOME ?? "", "Library", "pipx", "venvs", "code-review-graph"),
  ];
  for (const base of candidates) {
    const sp = await resolveSitePackages(base);
    if (sp) return sp;
  }
  return null;
}

async function resolveSitePackages(venvRoot: string): Promise<string | null> {
  // venv layout: <venvRoot>/lib/python<ver>/site-packages/code_review_graph/
  try {
    const libDir = path.join(venvRoot, "lib");
    const entries = await fs.readdir(libDir);
    for (const name of entries) {
      if (!name.startsWith("python")) continue;
      const candidate = path.join(libDir, name, "site-packages", "code_review_graph");
      try {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) return candidate;
      } catch {
        // skip
      }
    }
  } catch {
    // venv doesn't exist / unreadable
  }
  return null;
}

function applyEmbeddingsDispatchPatch(contents: string): string {
  let next = contents;

  // Import the provider module + helpers right after `logger = logging.getLogger(__name__)`.
  const loggerMarker = "logger = logging.getLogger(__name__)";
  const importBlock = `\n\n# HUBCODE_OPENAI_COMPAT_PATCH\nfrom .embeddings_openai_compat import (\n    OpenAICompatEmbeddingProvider,\n    is_loopback_url as _is_loopback_url,\n    provider_from_env as _openai_compat_from_env,\n)`;
  if (!next.includes(loggerMarker)) return contents;
  next = next.replace(loggerMarker, loggerMarker + importBlock);

  // Add openai-compat to the CLOUD_PROVIDERS set.
  next = next.replace(
    /CLOUD_PROVIDERS\s*=\s*\{\s*"google"\s*,\s*"minimax"\s*\}/,
    'CLOUD_PROVIDERS = {"google", "minimax", "openai-compat"}',
  );

  // Inject dispatch block inside `get_provider(...)`. We key on the existing
  // minimax branch: insert env-driven default + openai-compat branch right
  // before it.
  const minimaxMarker = 'if provider == "minimax":';
  if (!next.includes(minimaxMarker)) return contents;
  const dispatchBlock =
    "# HUBCODE_OPENAI_COMPAT_PATCH — env-driven default + openai-compat branch\n" +
    "    if provider is None:\n" +
    '        provider = os.environ.get("CRG_EMBEDDINGS_PROVIDER", "").strip() or None\n\n' +
    '    if provider == "openai-compat":\n' +
    "        built = _openai_compat_from_env()\n" +
    "        if not built:\n" +
    "            raise ValueError(\n" +
    '                "CRG_OPENAI_BASE_URL and CRG_OPENAI_MODEL environment variables "\n' +
    '                "are required for the openai-compat embedding provider."\n' +
    "            )\n" +
    '        if not _is_loopback_url(os.environ.get("CRG_OPENAI_BASE_URL", "")):\n' +
    '            _warn_cloud_egress("openai-compat")\n' +
    "        return built\n\n    ";
  next = next.replace(minimaxMarker, dispatchBlock + minimaxMarker);

  return next;
}
