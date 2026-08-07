import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  ClaudeCodeIcon,
  CodexIcon,
  CursorIcon,
  OpenCodeIcon,
  PiIcon,
} from "~/components/agent-icons";
import { DiscordIcon, GitHubIcon, SlackIcon } from "~/components/brand-icons";
import { AGENT_PAGES } from "~/data/agent-pages";
import { FAQItem } from "~/components/faq-item";
import { SiteShell } from "~/components/site-shell";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/hub")({
  head: () =>
    pageMeta(
      "Paseo Hub - GitHub, Slack, and Discord triggers",
      "An optional service above your Paseo daemons. Mention a bot in a GitHub issue and an agent runs on your own machine and opens a PR. Self-hosted first, private beta.",
      "/hub",
    ),
  component: Hub,
});

const DISCORD_INVITE_URL = "https://discord.gg/jz8T2uahpH";

const LINK_CLASS = "underline hover:text-white/80";

function Hub() {
  return (
    <SiteShell width="default">
      <h1 className="text-3xl font-medium tracking-tight mb-4">Paseo Hub</h1>
      <p className="text-lg text-white/70 leading-relaxed max-w-2xl">
        An optional service that sits above your daemons and gives them extra capabilities.
      </p>
      <p className="text-white/40 text-sm mt-3">Private beta. Self-hosted first.</p>

      <div className="space-y-20 mt-16">
        <Triggers />
        <Agents />
        <Shape />
        <Access />
        <FaqSection />
      </div>
    </SiteShell>
  );
}

const TRIGGER_SURFACES = [
  { name: "GitHub", icon: <GitHubIcon className="h-6 w-6" />, body: "Issues, PRs, and reviews." },
  { name: "Slack", icon: <SlackIcon className="h-6 w-6" />, body: "Channels and threads." },
  { name: "Discord", icon: <DiscordIcon className="h-6 w-6" />, body: "Channels and threads." },
];

function Triggers() {
  return (
    <section className="space-y-6">
      <h2 className="text-xl font-medium">Triggers, running on your machines</h2>
      <p className="text-white/70 leading-relaxed max-w-2xl">
        Mention the bot in GitHub, Slack, or Discord and an agent starts on your daemon.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {TRIGGER_SURFACES.map((surface) => (
          <div
            key={surface.name}
            className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4"
          >
            <span className="text-white/80">{surface.icon}</span>
            <span className="min-w-0">
              <span className="block font-medium">{surface.name}</span>
              <span className="block text-xs text-muted-foreground">{surface.body}</span>
            </span>
          </div>
        ))}
      </div>
      <DiscordDemo />
    </section>
  );
}

const DEMO_ISSUES = [
  { id: "#2811", title: "Terminal output drops under load" },
  { id: "#2804", title: "Relay reconnect loop on Android after sleep" },
  { id: "#2799", title: "Worktree cleanup leaves stale branches" },
];

function DiscordDemo() {
  return (
    <figure className="space-y-3">
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-5 py-3">
          <DiscordIcon className="h-4 w-4 text-white/40" />
          <span className="font-mono text-xs text-white/50">#engineering</span>
        </div>
        <div className="space-y-5 p-5">
          <DemoMessage author="moboudra" time="09:41">
            <p>
              <Mention /> show me the latest P0 issues
            </p>
          </DemoMessage>

          <DemoMessage author="paseo-bot" time="09:41" bot>
            <p>Three P0 issues are open:</p>
            <ul className="space-y-1">
              {DEMO_ISSUES.map((issue) => (
                <li key={issue.id} className="flex gap-2">
                  <span className="font-mono text-white/40">{issue.id}</span>
                  <span>{issue.title}</span>
                </li>
              ))}
            </ul>
          </DemoMessage>

          <DemoMessage author="moboudra" time="09:43">
            <p>
              <Mention /> create a pull request for the first one
            </p>
          </DemoMessage>

          <DemoMessage author="paseo-bot" time="09:48" bot>
            <p>
              Ran on <span className="font-mono text-white/50">macbook-pro</span>. Opened{" "}
              <span className="text-white/80 underline decoration-white/20">
                getpaseo/paseo#1234
              </span>{" "}
              with a fix for the terminal writes.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-xs text-emerald-300">
                3 files changed
              </span>
              <span className="rounded-full border border-white/10 px-2 py-1 text-xs text-white/40">
                tests passed
              </span>
            </div>
          </DemoMessage>
        </div>
      </div>
      <figcaption className="text-sm text-muted-foreground">
        The agent ran on your daemon, with your keys.
      </figcaption>
    </figure>
  );
}

function Mention() {
  return <span className="rounded bg-indigo-400/15 px-1 py-0.5 text-indigo-200">@paseo-bot</span>;
}

function DemoMessage({
  author,
  time,
  bot,
  children,
}: {
  author: string;
  time: string;
  bot?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.06]">
        {bot ? (
          <img src="/logo.svg" alt="" className="h-4 w-4" />
        ) : (
          <span className="text-xs font-medium text-white/60">M</span>
        )}
      </div>
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white/90">{author}</span>
          {bot && (
            <span className="rounded bg-indigo-400/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-200">
              Bot
            </span>
          )}
          <span className="text-xs text-white/25">{time}</span>
        </div>
        <div className="space-y-2 text-sm text-white/70 leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

const AGENT_LOGOS = [
  { name: "Claude Code", icon: <ClaudeCodeIcon className="h-6 w-6" /> },
  { name: "Codex", icon: <CodexIcon className="h-6 w-6" /> },
  { name: "OpenCode", icon: <OpenCodeIcon className="h-6 w-6" /> },
  { name: "Cursor", icon: <CursorIcon className="h-6 w-6" /> },
  { name: "Pi", icon: <PiIcon className="h-6 w-6" /> },
];

const MORE_AGENT_COUNT = AGENT_PAGES.length - AGENT_LOGOS.length;

function Agents() {
  return (
    <section className="space-y-6">
      <h2 className="text-xl font-medium">Runs the agents you already have</h2>
      <p className="text-white/70 leading-relaxed max-w-2xl">
        The Hub ships no agent of its own, so your team works with the providers, subscriptions, and
        skills already configured on your daemons.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {AGENT_LOGOS.map((agent) => (
          <div
            key={agent.name}
            className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
          >
            <span className="text-white/80">{agent.icon}</span>
            <span className="text-sm font-medium">{agent.name}</span>
          </div>
        ))}
        <a
          href="/agents"
          className="rounded-xl border border-dashed border-white/10 bg-white/[0.01] px-4 py-3 text-sm font-medium text-white/50 hover:text-white/80 hover:border-white/20 transition-colors"
        >
          +{MORE_AGENT_COUNT} more
        </a>
      </div>
    </section>
  );
}

const DIAGRAM_SURFACES = [
  { name: "GitHub", icon: <GitHubIcon className="h-5 w-5" /> },
  { name: "Slack", icon: <SlackIcon className="h-5 w-5" /> },
  { name: "Discord", icon: <DiscordIcon className="h-5 w-5" /> },
];

const CLAUDE_MARK = { name: "Claude Code", icon: <ClaudeCodeIcon className="h-4 w-4" /> };
const CODEX_MARK = { name: "Codex", icon: <CodexIcon className="h-4 w-4" /> };
const OPENCODE_MARK = { name: "OpenCode", icon: <OpenCodeIcon className="h-4 w-4" /> };
const PI_MARK = { name: "Pi", icon: <PiIcon className="h-4 w-4" /> };

const DIAGRAM_DAEMONS = [
  { name: "MacBook Pro", agents: [CLAUDE_MARK, CODEX_MARK, OPENCODE_MARK] },
  { name: "Hetzner VM", agents: [CLAUDE_MARK, PI_MARK] },
];

const DIAGRAM_CLIENTS = ["Desktop", "Web", "Mobile", "CLI"];

function Shape() {
  return (
    <section className="space-y-6">
      <h2 className="text-xl font-medium">Works with your existing infrastructure</h2>
      <p className="text-white/70 leading-relaxed max-w-2xl">
        The Hub connects to the daemons you already run, and your apps keep connecting to those same
        daemons.
      </p>

      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 md:p-8">
        <div className="flex flex-col items-center">
          <DiagramRow label="Triggers and teammates">
            {DIAGRAM_SURFACES.map((surface) => (
              <DiagramCard key={surface.name} icon={surface.icon} name={surface.name} />
            ))}
            <DiagramCard name="Your team" />
            <div className="flex items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.01] px-4 py-3 text-sm text-white/30">
              Future integrations
            </div>
          </DiagramRow>

          <Connector label="webhooks and mentions" />

          <div className="w-full max-w-xs rounded-xl border border-white/20 bg-white/[0.06] px-6 py-5 text-center">
            <p className="font-medium">Hub</p>
            <p className="text-xs text-muted-foreground mt-1">Self-hosted, one per team</p>
          </div>

          <Connector label="the same RPCs the app and CLI use" />

          <DiagramRow label="Your daemons">
            {DIAGRAM_DAEMONS.map((daemon) => (
              <div
                key={daemon.name}
                className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
              >
                <span className="text-white/70">
                  <MachineIcon />
                </span>
                <span className="text-sm font-medium">{daemon.name}</span>
                <span className="flex items-center gap-2 border-l border-white/10 pl-3 text-white/40">
                  {daemon.agents.map((agent) => (
                    <span key={agent.name} title={agent.name}>
                      {agent.icon}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </DiagramRow>

          <Connector label="direct connection or relay" />

          <DiagramRow label="Paseo apps">
            {DIAGRAM_CLIENTS.map((client) => (
              <DiagramCard key={client} name={client} />
            ))}
          </DiagramRow>
        </div>
      </div>
    </section>
  );
}

function DiagramRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="w-full space-y-2">
      <p className="text-center text-xs uppercase tracking-wide text-white/25">{label}</p>
      <div className="flex flex-wrap justify-center gap-3">{children}</div>
    </div>
  );
}

function DiagramCard({ name, icon }: { name: string; icon?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      {icon && <span className="text-white/70">{icon}</span>}
      <span className="text-sm font-medium">{name}</span>
    </div>
  );
}

function Connector({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-4">
      <div className="h-5 w-px border-l border-dashed border-white/25" />
      <p className="text-center text-[11px] text-white/30">{label}</p>
      <div className="h-5 w-px border-l border-dashed border-white/25" />
    </div>
  );
}

function MachineIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <circle cx="6" cy="6" r="1" />
      <circle cx="6" cy="18" r="1" />
    </svg>
  );
}

function Access() {
  return (
    <section className="space-y-6">
      <h2 className="text-xl font-medium">Getting access</h2>
      <p className="text-white/70 leading-relaxed max-w-2xl">
        Join the Paseo Discord and DM me. I&apos;m looking for design partners who are comfortable
        self-hosting.
      </p>
      <div className="flex items-center gap-4 pt-2">
        <a
          href={DISCORD_INVITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md bg-white text-black px-4 py-2 text-sm font-medium hover:bg-white/90 transition-colors"
        >
          Join the Discord
        </a>
      </div>
    </section>
  );
}

function FaqSection() {
  return (
    <section className="space-y-6">
      <h2 className="text-3xl font-medium">FAQ</h2>
      <div className="space-y-6">
        <FAQItem question="What is the Hub?">
          A separate service that sits above your Paseo daemons. You connect one or more daemons to
          it and it gives them GitHub, Slack, and Discord triggers, with collaboration features
          planned. Paseo works fully without it.
        </FAQItem>
        <FAQItem question="Why is it a separate service instead of part of the daemon?">
          <p>
            The daemon stays one lean executable on one machine. The Hub talks to daemons over the
            same RPCs the app and the CLI use, so anyone can build their own hub on top of Paseo.
          </p>
          <p>
            It also has a different job. The Hub is meant to be exposed to the internet, shared with
            a team, and run multi-tenant. None of that belongs in a single machine daemon.
          </p>
        </FAQItem>
        <FAQItem question="Why self-hosted first?">
          The Hub can trigger executions on the daemons connected to it, so it has to be trusted. I
          am not comfortable having people connect their daemons to my infrastructure until the
          daemon has stronger authorization primitives and sandboxing. That work is on the roadmap,
          and it applies to every Paseo user.
        </FAQItem>
        <FAQItem question="What do I need to run it?">
          A single Node.js application and a Postgres database. You also bring your own GitHub App,
          Slack app, and Discord bot credentials, which is the tedious part.
        </FAQItem>
        <FAQItem question="Will there be a hosted version?">
          Planned, once the daemon has stronger authorization primitives and sandboxing. I already
          run a Hub for my own repos, and I can walk you through a trial on it if you want to skip
          the self-hosted setup. No SLA.
        </FAQItem>
        <FAQItem question="What else is planned?">
          <p>Not built yet, listed so you know where this is going.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Provisioning daemons for your team</li>
            <li>Sharing settings and skills across a team</li>
            <li>More integrations</li>
          </ul>
        </FAQItem>
        <FAQItem question="Do I have to move my team to a new tool?">
          No. The Hub works in the Slack or Discord your team already uses, and on the daemons you
          already run. When the work gets serious you switch to the Paseo app on those same daemons.
        </FAQItem>
        <FAQItem question="Which agents does it run?">
          Whichever ones your daemons have configured, with your own subscriptions and skills. The
          Hub ships no agent of its own.
        </FAQItem>
        <FAQItem question="Can the Hub run code on my machines?">
          Yes, on the daemons you connect to it and nowhere else. That is the whole point of
          triggers, and it&apos;s why access to the beta stays small and trusted.
        </FAQItem>
        <FAQItem question="How do I get access?">
          Join the{" "}
          <a
            href={DISCORD_INVITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_CLASS}
          >
            Paseo Discord
          </a>{" "}
          and DM @moboudra for an invite to the private Hub channel.
        </FAQItem>
      </div>
    </section>
  );
}
