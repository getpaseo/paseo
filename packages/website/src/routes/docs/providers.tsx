import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/docs/providers")({
  head: () => ({
    meta: pageMeta(
      "Providers - Paseo Docs",
      "First-class agent providers in Paseo, and how to configure custom providers, ACP agents, and profiles.",
    ),
  }),
  component: Providers,
});

const CUSTOM_PROVIDERS_URL = "https://github.com/getpaseo/paseo/blob/main/docs/CUSTOM-PROVIDERS.md";

function Providers() {
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-medium font-title mb-4">Providers</h1>
        <p className="text-white/60 leading-relaxed">
          A provider is an agent CLI that Paseo knows how to launch, stream, and control. Paseo
          ships with first-class providers for the major coding agents, and lets you add your own
          through <code className="font-mono">config.json</code> — either by pointing an existing
          provider at a different API, adding extra profiles, or plugging in any{" "}
          <a
            href="https://agentclientprotocol.com"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-white/80"
          >
            ACP
          </a>
          -compatible agent.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">First-class providers</h2>
        <p className="text-white/60 leading-relaxed">
          These work out of the box once the underlying CLI is installed and authenticated. Paseo
          discovers them automatically, wires up modes, and exposes them in the app and CLI.
        </p>
        <ul className="text-white/60 space-y-3 list-disc list-inside">
          <li>
            <code className="font-mono">claude</code> — Anthropic&apos;s Claude Code. Multi-tool
            assistant with MCP support, streaming, and deep reasoning.
          </li>
          <li>
            <code className="font-mono">codex</code> — OpenAI&apos;s Codex workspace agent with
            sandbox controls and optional network access.
          </li>
          <li>
            <code className="font-mono">opencode</code> — Open-source coding assistant with
            multi-provider model support.
          </li>
          <li>
            <code className="font-mono">copilot</code> — GitHub Copilot via ACP, with dynamic modes
            and session support.
          </li>
          <li>
            <code className="font-mono">pi</code> — Minimal terminal-based coding agent with
            multi-provider LLM support.
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Custom providers</h2>
        <p className="text-white/60 leading-relaxed">
          Everything beyond the defaults lives under{" "}
          <code className="font-mono">agents.providers</code> in{" "}
          <code className="font-mono">~/.paseo/config.json</code>. You can:
        </p>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>
            <strong>Extend</strong> a first-class provider to point at a different API (Z.AI,
            Alibaba/Qwen, a proxy, a self-hosted endpoint).
          </li>
          <li>
            <strong>Add profiles</strong> — multiple entries against the same underlying provider
            with different credentials or curated model lists.
          </li>
          <li>
            <strong>Override the binary</strong> — run a nightly build, a wrapper script, or a
            Docker image instead of the installed CLI.
          </li>
          <li>
            <strong>Add ACP agents</strong> — Gemini CLI, Hermes, or any agent speaking the Agent
            Client Protocol over stdio.
          </li>
          <li>
            <strong>Disable</strong> a provider you don&apos;t use.
          </li>
        </ul>
        <p className="text-white/60 leading-relaxed">
          Provider IDs must be lowercase alphanumeric with hyphens (
          <code className="font-mono">/^[a-z][a-z0-9-]*$/</code>). Every custom entry needs{" "}
          <code className="font-mono">extends</code> (a first-class provider ID or{" "}
          <code className="font-mono">&quot;acp&quot;</code>) and a{" "}
          <code className="font-mono">label</code>.
        </p>
        <p className="text-white/60 leading-relaxed">
          The examples below are a quick tour. The full, up-to-date reference is on GitHub:{" "}
          <a
            href={CUSTOM_PROVIDERS_URL}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-white/80"
          >
            docs/CUSTOM-PROVIDERS.md
          </a>
          .
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Extending a first-class provider</h2>
        <pre className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto text-white/80">
          {`{
  "agents": {
    "providers": {
      "my-claude": {
        "extends": "claude",
        "label": "My Claude",
        "env": {
          "ANTHROPIC_API_KEY": "sk-ant-...",
          "ANTHROPIC_BASE_URL": "https://my-proxy.example.com/v1"
        }
      }
    }
  }
}`}
        </pre>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Z.AI (GLM) coding plan</h2>
        <p className="text-white/60 leading-relaxed">
          Z.AI exposes GLM models through an Anthropic-compatible endpoint. Point{" "}
          <code className="font-mono">ANTHROPIC_BASE_URL</code> at their API and use{" "}
          <code className="font-mono">ANTHROPIC_AUTH_TOKEN</code> for the key. Third-party endpoints
          don&apos;t support Anthropic&apos;s server-side tools, so disable{" "}
          <code className="font-mono">WebSearch</code>.
        </p>
        <pre className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto text-white/80">
          {`{
  "agents": {
    "providers": {
      "zai": {
        "extends": "claude",
        "label": "ZAI",
        "env": {
          "ANTHROPIC_AUTH_TOKEN": "<your-zai-api-key>",
          "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
          "API_TIMEOUT_MS": "3000000"
        },
        "disallowedTools": ["WebSearch"],
        "models": [
          { "id": "glm-5-turbo", "label": "GLM 5 Turbo", "isDefault": true },
          { "id": "glm-5.1", "label": "GLM 5.1" }
        ]
      }
    }
  }
}`}
        </pre>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Alibaba Cloud (Qwen) coding plan</h2>
        <p className="text-white/60 leading-relaxed">
          Alibaba&apos;s coding plan routes Claude Code to Qwen models via an Anthropic-compatible
          API. Subscription keys look like <code className="font-mono">sk-sp-...</code> and must be
          created in the Singapore region.
        </p>
        <pre className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto text-white/80">
          {`{
  "agents": {
    "providers": {
      "qwen": {
        "extends": "claude",
        "label": "Qwen (Alibaba)",
        "env": {
          "ANTHROPIC_AUTH_TOKEN": "sk-sp-<coding-plan-key>",
          "ANTHROPIC_BASE_URL": "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic"
        },
        "disallowedTools": ["WebSearch"],
        "models": [
          { "id": "qwen3.5-plus", "label": "Qwen 3.5 Plus", "isDefault": true },
          { "id": "qwen3-coder-next", "label": "Qwen 3 Coder Next" }
        ]
      }
    }
  }
}`}
        </pre>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Multiple profiles</h2>
        <p className="text-white/60 leading-relaxed">
          Create as many entries as you want against the same first-class provider. Each one shows
          up as a separate option in the app with its own credentials and models.
        </p>
        <pre className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto text-white/80">
          {`{
  "agents": {
    "providers": {
      "claude-work": {
        "extends": "claude",
        "label": "Claude (Work)",
        "env": { "ANTHROPIC_API_KEY": "sk-ant-work-..." }
      },
      "claude-personal": {
        "extends": "claude",
        "label": "Claude (Personal)",
        "env": { "ANTHROPIC_API_KEY": "sk-ant-personal-..." }
      }
    }
  }
}`}
        </pre>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Custom binary</h2>
        <p className="text-white/60 leading-relaxed">
          <code className="font-mono">command</code> is an array — first element is the binary, the
          rest are arguments. It fully replaces the default launch command for that provider.
        </p>
        <pre className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto text-white/80">
          {`{
  "agents": {
    "providers": {
      "claude": {
        "command": ["/opt/claude-nightly/claude"]
      }
    }
  }
}`}
        </pre>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">ACP providers</h2>
        <p className="text-white/60 leading-relaxed">
          Any agent that speaks{" "}
          <a
            href="https://agentclientprotocol.com"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-white/80"
          >
            ACP
          </a>{" "}
          over stdio can be added with <code className="font-mono">extends: &quot;acp&quot;</code>{" "}
          and a <code className="font-mono">command</code>. Paseo spawns the process, sends an{" "}
          <code className="font-mono">initialize</code> JSON-RPC request, and the agent reports its
          capabilities, modes, and models at runtime.
        </p>
        <pre className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto text-white/80">
          {`{
  "agents": {
    "providers": {
      "gemini": {
        "extends": "acp",
        "label": "Google Gemini",
        "command": ["gemini", "--acp"]
      },
      "hermes": {
        "extends": "acp",
        "label": "Hermes",
        "command": ["hermes", "acp"]
      }
    }
  }
}`}
        </pre>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Adding or relabeling models</h2>
        <p className="text-white/60 leading-relaxed">
          <code className="font-mono">models</code> replaces the model list entirely.{" "}
          <code className="font-mono">additionalModels</code> merges with runtime-discovered models
          (ACP) or with <code className="font-mono">models</code> — use it to add an extra entry or
          relabel a discovered one without redeclaring the full list. An entry with the same{" "}
          <code className="font-mono">id</code> as a discovered model updates it in place.
        </p>
        <pre className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto text-white/80">
          {`{
  "agents": {
    "providers": {
      "gemini": {
        "extends": "acp",
        "label": "Google Gemini",
        "command": ["gemini", "--acp"],
        "additionalModels": [
          { "id": "experimental-model", "label": "Experimental", "isDefault": true },
          { "id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro (preferred)" }
        ]
      }
    }
  }
}`}
        </pre>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Disabling a provider</h2>
        <pre className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto text-white/80">
          {`{
  "agents": {
    "providers": {
      "copilot": { "enabled": false }
    }
  }
}`}
        </pre>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Full reference</h2>
        <p className="text-white/60 leading-relaxed">
          For the complete field reference (<code className="font-mono">extends</code>,{" "}
          <code className="font-mono">label</code>, <code className="font-mono">command</code>,{" "}
          <code className="font-mono">env</code>, <code className="font-mono">models</code>,{" "}
          <code className="font-mono">additionalModels</code>,{" "}
          <code className="font-mono">disallowedTools</code>,{" "}
          <code className="font-mono">enabled</code>, <code className="font-mono">order</code>),
          model and thinking-option schemas, and deeper examples for each plan, see{" "}
          <a
            href={CUSTOM_PROVIDERS_URL}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-white/80"
          >
            docs/CUSTOM-PROVIDERS.md
          </a>{" "}
          on GitHub.
        </p>
      </section>
    </div>
  );
}
