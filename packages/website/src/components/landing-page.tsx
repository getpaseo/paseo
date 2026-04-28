import * as React from "react";
import { motion, AnimatePresence, useInView, useScroll, useTransform } from "framer-motion";
import { CursorFieldProvider } from "~/components/butterfly";
import { BookDemoCTA } from "~/components/book-demo-cta";
import { CommandDialog } from "~/components/command-dialog";
import {
  webAppUrl,
  getDownloadOptions,
  useDetectedPlatform,
  AppleIcon,
  AndroidIcon,
  TerminalIcon,
  GlobeIcon,
} from "~/downloads";
import { useRelease } from "~/routes/__root";
import { Mic } from "lucide-react";
import { HeroMockup } from "~/components/hero-mockup";
import { ClaudeIcon } from "~/components/mockup";
import { SiteHeader } from "~/components/site-header";
import "~/styles.css";

interface LandingPageProps {
  title: React.ReactNode;
  subtitle: string;
}

export function LandingPage({ title, subtitle }: LandingPageProps) {
  return (
    <CursorFieldProvider>
      {/* Hero section with branded magenta backdrop */}
      <div className="relative overflow-hidden bg-cover bg-center bg-no-repeat">
        {/* Hubcode magenta glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 h-[640px] w-[1100px] rounded-full opacity-40 blur-[140px]"
          style={{
            background:
              "radial-gradient(closest-side, rgba(216,27,96,0.55), rgba(216,27,96,0) 70%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute top-40 -left-40 h-[420px] w-[420px] rounded-full opacity-30 blur-[120px]"
          style={{
            background:
              "radial-gradient(closest-side, rgba(255,64,129,0.5), rgba(255,64,129,0) 70%)",
          }}
        />
        <div className="relative p-6 pb-10 md:px-32 md:pt-20 md:pb-12 max-w-7xl mx-auto">
          <Nav />
          <Hero title={title} subtitle={subtitle} />
          <GetStarted />
        </div>

        {/* Mockup - inside hero so it's above the gradient, positioned to overflow into black section */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.5, ease: "easeOut" }}
          className="relative px-6 md:px-8 pb-8 md:pb-16"
        >
          <div className="max-w-7xl mx-auto">
            <HeroMockup />
          </div>
        </motion.div>
      </div>

      {/* Content section */}
      <div className="bg-background">
        <main className="p-6 md:p-20 md:pt-32 max-w-5xl mx-auto">
          <div className="space-y-24">
            <MultiProviderSection />
            <KanbanSection />
            <ComposerSection />
            <IntegrationsSection />
            <CollaborationSection />
            <HubcodeAgentSection />
            <McpSection />
            <SelfHostedSection />
            <ShortcutsSection />
            <LocalVoiceSection />
            <CLISection />
            <BookDemoCTA />
            <FAQ />
          </div>
        </main>
        <footer className="relative p-6 md:p-20 md:pt-0 max-w-5xl mx-auto">
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-10 left-1/2 -translate-x-1/2 h-[200px] w-[600px] rounded-full opacity-30 blur-[120px]"
            style={{
              background: "radial-gradient(closest-side, rgba(216,27,96,0.5), transparent 70%)",
            }}
          />
          <div className="relative flex items-center gap-3 mb-10">
            <img src="/logo-icon.png" alt="Hubcode" className="w-7 h-7" />
            <span className="text-sm text-white/70">
              <span className="text-white font-medium">Hubcode</span> — the self-hosted control
              plane for your coding agents.
            </span>
          </div>
          <div className="relative border-t border-white/10 pt-8 pb-4 grid grid-cols-2 sm:grid-cols-4 gap-8 text-xs">
            <div className="space-y-3">
              <p className="text-white/60 font-medium">Product</p>
              <div className="space-y-2">
                <a
                  href="/docs"
                  className="block text-white/40 hover:text-[#FF80AB] transition-colors"
                >
                  Docs
                </a>
                <a
                  href="/changelog"
                  className="block text-white/40 hover:text-[#FF80AB] transition-colors"
                >
                  Changelog
                </a>
                <a
                  href="/docs/cli"
                  className="block text-white/40 hover:text-[#FF80AB] transition-colors"
                >
                  CLI
                </a>
                <a
                  href="/privacy"
                  className="block text-white/40 hover:text-[#FF80AB] transition-colors"
                >
                  Privacy
                </a>
              </div>
            </div>
            <div className="space-y-3">
              <p className="text-white/60 font-medium">Agents</p>
              <div className="space-y-2">
                <a
                  href="/claude-code"
                  className="block text-white/40 hover:text-[#FF80AB] transition-colors"
                >
                  Claude Code
                </a>
                <a
                  href="/codex"
                  className="block text-white/40 hover:text-[#FF80AB] transition-colors"
                >
                  Codex
                </a>
                <a
                  href="/opencode"
                  className="block text-white/40 hover:text-[#FF80AB] transition-colors"
                >
                  OpenCode
                </a>
              </div>
            </div>
            <div className="space-y-3">
              <p className="text-white/60 font-medium">Project</p>
              <div className="space-y-2">
                <a
                  href="https://github.com/hubtool/hubcode"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-white/40 hover:text-[#FF80AB] transition-colors"
                >
                  GitHub
                </a>
                <a
                  href="/pricing"
                  className="block text-white/40 hover:text-[#FF80AB] transition-colors"
                >
                  Pricing
                </a>
              </div>
            </div>
            <div className="space-y-3">
              <p className="text-white/60 font-medium">Download</p>
              <div className="space-y-2">
                <a
                  href="/download"
                  className="block text-white/40 hover:text-[#FF80AB] transition-colors"
                >
                  Mac
                </a>
                <a
                  href={webAppUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-white/40 hover:text-[#FF80AB] transition-colors"
                >
                  Web App
                </a>
                <a
                  href="https://github.com/hubtool/hubcode/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-white/40 hover:text-[#FF80AB] transition-colors"
                >
                  Releases
                </a>
              </div>
            </div>
          </div>
          <div className="mt-8 pt-6 border-t border-white/5 text-xs text-white/30">
            © {new Date().getFullYear()} Hubcode · AGPL-3.0
          </div>
        </footer>
      </div>
    </CursorFieldProvider>
  );
}

function Nav() {
  return (
    <nav className="mb-16">
      <SiteHeader />
    </nav>
  );
}

function Hero({ title, subtitle }: { title: React.ReactNode; subtitle: string }) {
  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="inline-flex items-center gap-2 rounded-full border border-[#D81B60]/40 bg-[#D81B60]/10 px-3 py-1 text-xs text-[#FF80AB]"
      >
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FF4081] opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#FF4081]" />
        </span>
        <span className="text-white/80 font-medium">Hubcode v2.7.3</span>
        <span className="text-white/40">·</span>
        <span>kanban + shared sessions + Hubtool agent</span>
      </motion.div>
      <motion.h1
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="text-3xl md:text-5xl font-medium tracking-tight bg-gradient-to-br from-white via-white to-[#FF80AB]/80 bg-clip-text text-transparent"
      >
        {title}
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.15, ease: "easeOut" }}
        className="text-white/70 text-lg leading-relaxed max-w-xl"
      >
        {subtitle}
      </motion.p>
    </div>
  );
}

function AgentBadge({ name, icon }: { name: string; icon: React.ReactNode }) {
  const [hovered, setHovered] = React.useState(false);

  return (
    <span
      className="relative inline-flex items-center justify-center rounded-full p-1.5 text-white/60"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {icon}
      <AnimatePresence>
        {hovered && (
          <motion.span
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 rounded bg-[#D81B60] text-white text-xs whitespace-nowrap pointer-events-none shadow-lg shadow-[#D81B60]/30"
          >
            {name}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function FeatureSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="space-y-8"
    >
      <div className="space-y-3">
        <span className="inline-flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-[#FF80AB]">
          <span className="block h-[2px] w-8 rounded-full bg-gradient-to-r from-[#D81B60] to-[#FF4081]" />
          Hubcode
        </span>
        <h2 className="text-3xl md:text-4xl font-medium tracking-tight bg-gradient-to-br from-white to-white/70 bg-clip-text text-transparent">
          {title}
        </h2>
        <p className="text-base text-muted-foreground max-w-xl leading-relaxed">{description}</p>
      </div>
      {children}
    </motion.section>
  );
}

function PrinciplesSection() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="py-32 px-6 md:px-20 max-w-3xl mx-auto text-center"
    >
      <p className="text-2xl md:text-4xl font-medium text-white/90">
        Here's what's under the hood.
      </p>
    </motion.div>
  );
}

function MultiProviderSection() {
  const providers = [
    { name: "Claude Code", icon: <ClaudeIcon size={28} /> },
    { name: "Codex", icon: <CodexIcon className="w-7 h-7" /> },
    { name: "OpenCode", icon: <OpenCodeIcon className="w-7 h-7" /> },
    { name: "Copilot", icon: <CopilotIcon className="w-7 h-7" /> },
    { name: "Pi", icon: <PiIcon className="w-7 h-7" /> },
    {
      name: "Hubtool",
      tag: "Pro",
      icon: <img src="/logo-icon.png" alt="" className="w-7 h-7" />,
    },
    {
      name: "+ CLI agents",
      tag: "any",
      icon: (
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-white/60"
        >
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      ),
    },
  ];

  return (
    <FeatureSection
      title="Use the best agent for the job"
      description="Run multiple providers from a single interface. Hubcode runs the native agent harness as you'd normally run it, with your skills, config and MCP servers intact."
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {providers.map((p) => (
          <div
            key={p.name}
            className="group relative flex flex-col items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-5 hover:border-[#D81B60]/40 hover:bg-[#D81B60]/[0.06] hover:-translate-y-0.5 transition-all overflow-hidden"
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -top-12 h-24 opacity-0 group-hover:opacity-100 blur-2xl transition-opacity"
              style={{ background: "rgba(216,27,96,0.4)" }}
            />
            <span className="relative text-white/85">{p.icon}</span>
            <span className="relative font-medium text-sm">{p.name}</span>
            {"tag" in p && p.tag ? (
              <span className="relative text-[10px] uppercase tracking-wider rounded-full bg-[#D81B60]/15 border border-[#D81B60]/30 text-[#FF80AB] px-1.5 py-0.5">
                {p.tag}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </FeatureSection>
  );
}

function KanbanSection() {
  const columns = [
    {
      name: "To-do",
      count: 4,
      cards: [
        {
          title: "auth/refresh-token-rotation",
          agent: "Claude Code",
          branch: "feat/auth-refresh",
          issue: "GH #482",
        },
        {
          title: "billing/proration-fix",
          agent: "Codex",
          branch: "fix/billing-prorate",
          issue: "Linear ENG-211",
        },
      ],
    },
    {
      name: "In progress",
      count: 2,
      cards: [
        {
          title: "search/elastic-rollover",
          agent: "Codex CLI",
          branch: "feat/search-rollover",
          issue: "Jira PLAT-39",
        },
      ],
    },
    {
      name: "Ready for review",
      count: 1,
      cards: [
        {
          title: "ui/dark-mode-tokens",
          agent: "Claude Code",
          branch: "ui/dark-tokens",
          issue: "GH #475",
        },
      ],
    },
  ];

  return (
    <FeatureSection
      title="A kanban for every worktree"
      description="Each git worktree becomes a card on a To-do / In-progress / Ready-for-review board. Track parallel agent work like you'd track tickets, with the linked issue, branch and agent on every card."
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {columns.map((col) => (
          <div
            key={col.name}
            className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-2"
          >
            <div className="flex items-center justify-between px-1 pb-1">
              <span className="inline-flex items-center gap-2 text-xs font-medium text-white/80">
                {col.name === "In progress" ? (
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FF4081] opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#FF4081]" />
                  </span>
                ) : null}
                {col.name}
              </span>
              <span className="text-[10px] rounded-full bg-white/5 px-2 py-0.5 text-white/50">
                {col.count}
              </span>
            </div>
            {col.cards.map((c) => (
              <div
                key={c.title}
                className="rounded-lg border border-white/10 bg-black/40 p-3 space-y-1.5 hover:border-[#D81B60]/40 hover:bg-black/60 transition-colors"
              >
                <p className="text-xs font-medium text-white/90 truncate">{c.title}</p>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="inline-flex items-center text-[10px] rounded bg-[#D81B60]/15 text-[#FF80AB] px-1.5 py-0.5">
                    {c.agent}
                  </span>
                  <span className="inline-flex items-center text-[10px] rounded bg-white/5 text-white/50 px-1.5 py-0.5">
                    {c.branch}
                  </span>
                </div>
                <p className="text-[10px] text-white/30">{c.issue}</p>
              </div>
            ))}
          </div>
        ))}
      </div>
    </FeatureSection>
  );
}

function ComposerSection() {
  return (
    <FeatureSection
      title="A composer that knows your tools"
      description='The "+" menu attaches images, GitHub issues / PRs, and any item from a connected integration as structured context. Pick the agent — GUI or CLI — and edit the branch name inline before launching.'
    >
      <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.04] to-white/[0.01] p-5 md:p-6 space-y-3 shadow-[0_20px_60px_-30px_rgba(216,27,96,0.4)]">
        <div className="rounded-xl border border-white/10 bg-black/50 p-4 space-y-3">
          <p className="text-sm text-white/85 leading-relaxed">
            Implement OAuth refresh-token rotation, see the linked issue for acceptance criteria.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <AttachmentChip
              icon={
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.111.82-.261.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.467-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                </svg>
              }
              label="GH #482"
              sub="refresh-token rotation"
            />
            <AttachmentChip
              icon={<span className="w-2.5 h-2.5 rounded-sm bg-[#5E6AD2]" />}
              label="Linear ENG-211"
            />
            <AttachmentChip
              icon={
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#FF80AB"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                </svg>
              }
              label="screenshot.png"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-1">
          <button
            type="button"
            className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-[#D81B60]/40 bg-[#D81B60]/15 text-[#FF80AB] hover:bg-[#D81B60]/25 transition-colors"
            aria-label="Attach"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <span className="inline-flex items-center gap-1.5 text-xs rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-white/80">
            <CodexIcon className="w-3 h-3" />
            Codex CLI
            <ChevronDownIcon className="w-3 h-3 text-white/40" />
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-white/80">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            feat/auth-refresh
          </span>
          <span className="ml-auto inline-flex items-center justify-center h-7 w-7 rounded-md bg-gradient-to-r from-[#D81B60] to-[#FF4081] text-white shadow-[0_0_14px_-2px_rgba(216,27,96,0.7)]">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </span>
        </div>
      </div>
    </FeatureSection>
  );
}

function IntegrationsSection() {
  const items = [
    { name: "GitHub", color: "#fff" },
    { name: "Linear", color: "#5E6AD2" },
    { name: "Jira", color: "#2684FF" },
    { name: "GitLab", color: "#FC6D26" },
    { name: "Forgejo", color: "#FB923C" },
    { name: "Plain", color: "#A78BFA" },
    { name: "Sentry", color: "#F472B6" },
  ];
  return (
    <FeatureSection
      title="Wired to your issue tracker"
      description="Link tasks to issues from GitHub, Linear, Jira, GitLab, Forgejo, Plain or Sentry. The agent gets the full issue context as part of its prompt, and the kanban card stays linked to the source ticket."
    >
      <div className="flex flex-wrap gap-2">
        {items.map((it) => (
          <span
            key={it.name}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] pl-1 pr-3 py-1 text-xs font-medium text-white/85 hover:border-[#D81B60]/40 hover:bg-[#D81B60]/[0.06] transition-colors"
          >
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold"
              style={{
                background: it.color,
                color: it.color === "#fff" ? "#000" : "#fff",
              }}
            >
              {it.name[0]}
            </span>
            {it.name}
          </span>
        ))}
      </div>
    </FeatureSection>
  );
}

function McpSection() {
  return (
    <FeatureSection
      title="MCP, loops and schedules"
      description="Configure MCP servers per-project and per-host — agents pick them up automatically. Drive an agent in a worker-verifier loop until acceptance criteria pass, or run a recurring task on a cron schedule."
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {[
          {
            label: "MCP server hub",
            body: "Add filesystem, Playwright, Supabase, Atlassian — any MCP server — and they're wired into every supported agent.",
          },
          {
            label: "Loops",
            body: "Worker + verifier in one command. Runs until the verifier approves or you hit max iterations.",
          },
          {
            label: "Schedules",
            body: "Cron a task. Dependency audits at 09:00 every Monday, docs sync nightly, etc.",
          },
        ].map((card) => (
          <div
            key={card.label}
            className="group relative rounded-xl border border-white/10 bg-white/[0.02] p-5 space-y-2 hover:border-[#D81B60]/40 hover:bg-[#D81B60]/[0.05] transition-colors overflow-hidden"
          >
            <span
              aria-hidden
              className="pointer-events-none absolute -top-12 -right-12 h-32 w-32 rounded-full opacity-0 group-hover:opacity-100 blur-2xl transition-opacity"
              style={{ background: "rgba(216,27,96,0.35)" }}
            />
            <p className="relative text-sm font-medium text-white/90">{card.label}</p>
            <p className="relative text-sm text-white/55">{card.body}</p>
          </div>
        ))}
      </div>
    </FeatureSection>
  );
}

function CollaborationSection() {
  return (
    <FeatureSection
      title="Pair on a live agent session"
      description="Invite a teammate into a shared session and watch the agent work together — kanban, chat, and a built-in voice + video room while you pair. Everything stays on your daemon; nothing routes through us."
    >
      <div className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-4 rounded-[28px] opacity-50 blur-3xl"
          style={{
            background: "radial-gradient(closest-side, rgba(216,27,96,0.45), transparent 70%)",
          }}
        />
        <div className="relative rounded-2xl border border-white/10 ring-1 ring-[#D81B60]/20 bg-white/[0.02] overflow-hidden shadow-[0_30px_80px_-30px_rgba(216,27,96,0.55)]">
          <img
            src="/hero-shared-session.png"
            alt="Hubcode live shared session with voice/video"
            className="w-full h-auto"
          />
        </div>
      </div>
    </FeatureSection>
  );
}

function HubcodeAgentSection() {
  return (
    <FeatureSection
      title="Hubtool agent"
      description="An optional curated agent routed through the Hubcode backend — multi-model orchestration with a single subscription. Free users see the upgrade entry next to their installed agents; bring your own keys to keep using everything else for free."
    >
      <div className="relative overflow-hidden rounded-2xl border border-[#D81B60]/30 bg-gradient-to-br from-[#D81B60]/[0.10] via-white/[0.02] to-transparent p-6 md:p-8 shadow-[0_30px_80px_-30px_rgba(216,27,96,0.5)]">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 -right-20 h-72 w-72 rounded-full opacity-40 blur-3xl"
          style={{ background: "rgba(216,27,96,0.55)" }}
        />
        <div className="relative grid grid-cols-1 md:grid-cols-3 gap-6 text-sm">
          {[
            {
              title: "Multi-model routing",
              body: "Plan with one model, implement with another, verify with a third — picked automatically per task.",
              icon: (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
              ),
            },
            {
              title: "One subscription",
              body: "Skip per-provider billing. The Hubtool agent rolls Claude, GPT and others into a single Pro plan.",
              icon: (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m12 2 3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" />
                </svg>
              ),
            },
            {
              title: "Drop-in",
              body: "Selectable from the same agent picker as Claude Code, Codex, OpenCode and your CLI agents — no separate UI to learn.",
              icon: (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="9" />
                  <circle cx="12" cy="12" r="4" />
                </svg>
              ),
            },
          ].map((card) => (
            <div key={card.title} className="space-y-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#D81B60]/20 border border-[#D81B60]/30 text-[#FF80AB]">
                {card.icon}
              </span>
              <p className="font-medium text-white/95 pt-1">{card.title}</p>
              <p className="text-white/55 leading-relaxed">{card.body}</p>
            </div>
          ))}
        </div>
      </div>
    </FeatureSection>
  );
}

function SelfHostedDiagram() {
  const clients = [
    {
      name: "Desktop",
      icon: (
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      ),
    },
    {
      name: "Web",
      icon: (
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      ),
    },
    {
      name: "Mobile",
      icon: (
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="5" y="2" width="14" height="20" rx="2" />
          <path d="M12 18h.01" />
        </svg>
      ),
    },
    {
      name: "CLI",
      icon: (
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      ),
    },
  ];
  const hosts = ["MacBook Pro", "Hetzner VM", "Dev server"];
  const containerRef = React.useRef<HTMLDivElement>(null);
  const clientRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const hostRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const centerRef = React.useRef<HTMLDivElement>(null);
  const [paths, setPaths] = React.useState<{ left: string[]; right: string[] }>({
    left: [],
    right: [],
  });

  React.useEffect(() => {
    function computePaths() {
      const container = containerRef.current;
      const center = centerRef.current;
      if (!container || !center) return;

      const cRect = container.getBoundingClientRect();
      const mRect = center.getBoundingClientRect();
      const midL = mRect.left - cRect.left;
      const midR = mRect.right - cRect.left;
      const midY = mRect.top - cRect.top + mRect.height / 2;

      const left = clientRefs.current.map((el) => {
        if (!el) return "";
        const r = el.getBoundingClientRect();
        const x1 = r.right - cRect.left;
        const y1 = r.top - cRect.top + r.height / 2;
        const cpx = x1 + (midL - x1) * 0.6;
        return `M${x1},${y1} C${cpx},${y1} ${midL - (midL - x1) * 0.3},${midY} ${midL},${midY}`;
      });

      const right = hostRefs.current.map((el) => {
        if (!el) return "";
        const r = el.getBoundingClientRect();
        const x2 = r.left - cRect.left;
        const y2 = r.top - cRect.top + r.height / 2;
        const cpx = midR + (x2 - midR) * 0.4;
        return `M${midR},${midY} C${cpx},${midY} ${x2 - (x2 - midR) * 0.3},${y2} ${x2},${y2}`;
      });

      setPaths({ left, right });
    }

    computePaths();
    window.addEventListener("resize", computePaths);
    return () => window.removeEventListener("resize", computePaths);
  }, []);

  return (
    <>
      {/* Mobile: vertical stack */}
      <div className="md:hidden flex flex-col items-center gap-4 py-4">
        <div className="space-y-2 w-full">
          {clients.map((c) => (
            <div
              key={c.name}
              className="flex items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4 hover:border-[#D81B60]/40 hover:bg-[#D81B60]/[0.06] transition-colors"
            >
              <span className="text-white/80">{c.icon}</span>
              <span className="font-medium">{c.name}</span>
            </div>
          ))}
        </div>
        <div className="w-px h-6 border-l border-dashed border-[#D81B60]/45" />
        <div className="rounded-xl border border-[#D81B60]/40 bg-[#D81B60]/[0.08] px-6 py-5 text-center space-y-1 shadow-[0_0_30px_-8px_rgba(216,27,96,0.5)]">
          <p className="text-xs font-medium text-white/70">E2E Encrypted Relay</p>
          <p className="text-[10px] text-white/30">or</p>
          <p className="text-xs font-medium text-white/70">Direct Connection</p>
        </div>
        <div className="w-px h-6 border-l border-dashed border-[#D81B60]/45" />
        <div className="space-y-2 w-full">
          {hosts.map((h) => (
            <div
              key={h}
              className="flex items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4 hover:border-[#D81B60]/40 hover:bg-[#D81B60]/[0.06] transition-colors"
            >
              <span className="text-white/80">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="2" y="2" width="20" height="8" rx="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" />
                  <circle cx="6" cy="6" r="1" />
                  <circle cx="6" cy="18" r="1" />
                </svg>
              </span>
              <span className="font-medium">{h}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Desktop: horizontal with bezier curves */}
      <div ref={containerRef} className="relative hidden md:flex items-center py-4 gap-0">
        {/* SVG curves */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ overflow: "visible" }}
        >
          {[...paths.left, ...paths.right].map(
            (d, i) =>
              d && (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke="rgba(216,27,96,0.45)"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                />
              ),
          )}
        </svg>

        {/* Clients */}
        <div className="space-y-3 flex-shrink-0 relative z-10">
          {clients.map((c, i) => (
            <div
              key={c.name}
              ref={(el) => {
                clientRefs.current[i] = el;
              }}
              className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4 backdrop-blur-sm"
            >
              <span className="text-white/80">{c.icon}</span>
              <span className="font-medium">{c.name}</span>
            </div>
          ))}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Center label */}
        <div
          ref={centerRef}
          className="flex-shrink-0 rounded-xl border border-[#D81B60]/40 bg-[#D81B60]/[0.08] px-8 py-6 text-center space-y-1.5 relative z-10 backdrop-blur-sm shadow-[0_0_40px_-10px_rgba(216,27,96,0.55)]"
        >
          <p className="text-sm font-medium text-white/80">E2E Encrypted Relay</p>
          <p className="text-xs text-white/40">or</p>
          <p className="text-sm font-medium text-white/80">Direct Connection</p>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Hosts */}
        <div className="space-y-3 flex-shrink-0 relative z-10">
          {hosts.map((h, i) => (
            <div
              key={h}
              ref={(el) => {
                hostRefs.current[i] = el;
              }}
              className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4 backdrop-blur-sm"
            >
              <span className="text-white/80">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="2" y="2" width="20" height="8" rx="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" />
                  <circle cx="6" cy="6" r="1" />
                  <circle cx="6" cy="18" r="1" />
                </svg>
              </span>
              <span className="font-medium">{h}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function SelfHostedSection() {
  return (
    <FeatureSection
      title="Your agents, every surface"
      description="Run agents on your laptop, a VM, or a dev server. Control them from any device with a direct connection or an E2E encrypted relay."
    >
      <SelfHostedDiagram />
    </FeatureSection>
  );
}

function ShortcutsSection() {
  const shortcuts = [
    { keys: ["⌘", "1-9"], action: "Switch panels" },
    { keys: ["⌘", "D"], action: "Split vertical" },
    { keys: ["⌘", "Shift", "D"], action: "Split horizontal" },
    { keys: ["⌘", "W"], action: "Close panel" },
    { keys: ["⌘", "N"], action: "New agent" },
    { keys: ["⌘", "K"], action: "Command palette" },
  ];

  return (
    <FeatureSection
      title="Keyboard-first"
      description="Every action has a shortcut. Panels, splits, agents - all from the keyboard."
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {shortcuts.map((s) => (
          <div
            key={s.action}
            className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5"
          >
            <span className="text-sm text-white/60">{s.action}</span>
            <div className="flex items-center gap-1">
              {s.keys.map((k) => (
                <kbd
                  key={k}
                  className="text-xs px-1.5 py-0.5 rounded bg-[#D81B60]/15 border border-[#D81B60]/30 text-[#FF80AB] font-mono"
                >
                  {k}
                </kbd>
              ))}
            </div>
          </div>
        ))}
      </div>
    </FeatureSection>
  );
}

function VoiceWaveform() {
  const barCount = 48;
  return (
    <div className="flex items-center justify-center gap-[3px] h-16">
      {Array.from({ length: barCount }).map((_, i) => {
        // Create a natural-looking waveform envelope — louder in center, quieter at edges
        const center = barCount / 2;
        const dist = Math.abs(i - center) / center;
        const envelope = 1 - dist * dist; // quadratic falloff
        const minH = 4;
        const maxH = 56;
        const baseH = minH + (maxH - minH) * envelope;
        // Vary per-bar so it doesn't look uniform
        const jitter = Math.sin(i * 2.3) * 0.3 + Math.cos(i * 1.7) * 0.2;
        const h = Math.max(minH, baseH * (0.5 + 0.5 * Math.abs(jitter + Math.sin(i * 0.8))));

        return (
          <div
            key={i}
            className="w-[3px] rounded-full bg-gradient-to-t from-[#D81B60]/70 to-[#FF4081]/90"
            style={{
              height: h,
              animationName: "voice-bar",
              animationDuration: `${800 + (i % 5) * 200}ms`,
              animationTimingFunction: "ease-in-out",
              animationIterationCount: "infinite",
              animationDirection: "alternate",
              animationDelay: `${(i % 7) * 80}ms`,
            }}
          />
        );
      })}
    </div>
  );
}

const USER_WORDS =
  "Refactor the auth middleware to use the new session store, then run the test suite".split(" ");
const RESPONSE_WORDS =
  "I'll update the auth middleware to use SessionStore instead of the legacy cookie-based approach. Let me refactor the middleware and update the tests.".split(
    " ",
  );
const DICTATION_LAG = 2;
const RESPONSE_LAG = 3;
const WORD_APPEAR_MS = 150;
const RESPONSE_WORD_MS = 60;
const PHASE_GAP_MS = 800;
const LOOP_PAUSE_MS = 3000;

type VoicePhase =
  | "dictation"
  | "dictation-flush"
  | "pause"
  | "response"
  | "response-flush"
  | "done";

function useVoiceConversation() {
  const [phase, setPhase] = React.useState<VoicePhase>("dictation");
  const [wordIndex, setWordIndex] = React.useState(0);

  React.useEffect(() => {
    if (phase === "dictation") {
      if (wordIndex < USER_WORDS.length) {
        const t = setTimeout(() => setWordIndex((w) => w + 1), WORD_APPEAR_MS);
        return () => clearTimeout(t);
      }
      setPhase("dictation-flush");
      setWordIndex(0);
      return;
    }
    if (phase === "dictation-flush") {
      if (wordIndex < DICTATION_LAG) {
        const t = setTimeout(() => setWordIndex((w) => w + 1), WORD_APPEAR_MS);
        return () => clearTimeout(t);
      }
      const t = setTimeout(() => {
        setPhase("pause");
      }, PHASE_GAP_MS);
      return () => clearTimeout(t);
    }
    if (phase === "pause") {
      const t = setTimeout(() => {
        setPhase("response");
        setWordIndex(0);
      }, PHASE_GAP_MS);
      return () => clearTimeout(t);
    }
    if (phase === "response") {
      if (wordIndex < RESPONSE_WORDS.length) {
        const t = setTimeout(() => setWordIndex((w) => w + 1), RESPONSE_WORD_MS);
        return () => clearTimeout(t);
      }
      setPhase("response-flush");
      setWordIndex(0);
      return;
    }
    if (phase === "response-flush") {
      if (wordIndex < RESPONSE_LAG) {
        const t = setTimeout(() => setWordIndex((w) => w + 1), RESPONSE_WORD_MS);
        return () => clearTimeout(t);
      }
      const t = setTimeout(() => {
        setPhase("done");
      }, LOOP_PAUSE_MS);
      return () => clearTimeout(t);
    }
    if (phase === "done") {
      const t = setTimeout(() => {
        setPhase("dictation");
        setWordIndex(0);
      }, 0);
      return () => clearTimeout(t);
    }
  }, [phase, wordIndex]);

  // Compute effective word indices for rendering
  let dictationWordIndex: number;
  if (phase === "dictation") {
    dictationWordIndex = wordIndex;
  } else if (phase === "dictation-flush") {
    dictationWordIndex = USER_WORDS.length + wordIndex;
  } else {
    dictationWordIndex = USER_WORDS.length + DICTATION_LAG;
  }

  let responseWordIndex: number;
  if (phase === "response") {
    responseWordIndex = wordIndex;
  } else if (phase === "response-flush") {
    responseWordIndex = RESPONSE_WORDS.length + wordIndex;
  } else if (phase === "done") {
    responseWordIndex = RESPONSE_WORDS.length + RESPONSE_LAG;
  } else {
    responseWordIndex = 0;
  }

  const showResponse = phase === "response" || phase === "response-flush" || phase === "done";

  return { dictationWordIndex, responseWordIndex, showResponse };
}

function StreamingWords({
  words,
  wordIndex,
  confirmLag = 2,
}: {
  words: string[];
  wordIndex: number;
  confirmLag?: number;
}) {
  return (
    <div className="relative">
      {/* Invisible full text to reserve height at any viewport width */}
      <p className="text-sm leading-relaxed invisible" aria-hidden>
        {words.join(" ")}
      </p>
      {/* Visible streaming text overlaid */}
      <p className="text-sm leading-relaxed absolute inset-0">
        {words.map((word, i) => {
          if (i >= wordIndex) return null;
          const confirmed = i < wordIndex - confirmLag;
          return (
            <span
              key={i}
              className={`transition-colors duration-300 ${confirmed ? "text-white/90" : "text-white/40"}`}
            >
              {word}{" "}
            </span>
          );
        })}
      </p>
    </div>
  );
}

function LocalVoiceSection() {
  const { dictationWordIndex, responseWordIndex, showResponse } = useVoiceConversation();

  return (
    <FeatureSection
      title="Local voice"
      description="Fully local voice stack. Speech-to-text and text-to-speech run entirely on your machine, nothing leaves your network."
    >
      <div className="relative w-full rounded-2xl border border-white/10 ring-1 ring-[#D81B60]/15 bg-gradient-to-b from-[#D81B60]/[0.05] to-transparent overflow-hidden">
        <div className="px-6 pt-8 pb-6 space-y-3">
          {/* Waveform area */}
          <div className="relative">
            <VoiceWaveform />
          </div>

          {/* User dictation */}
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-[#D81B60]/20 border border-[#D81B60]/30 flex items-center justify-center flex-shrink-0">
              <Mic size={16} className="text-[#FF80AB]" />
            </div>
            <div className="pt-1">
              <StreamingWords
                words={USER_WORDS}
                wordIndex={dictationWordIndex}
                confirmLag={DICTATION_LAG}
              />
            </div>
          </div>

          {/* Agent response — always rendered to reserve space */}
          <div
            className={`flex items-start gap-3 transition-opacity duration-300 ${showResponse ? "opacity-100" : "opacity-0"}`}
          >
            <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
              <ClaudeIcon size={16} className="text-white/60" />
            </div>
            <div className="pt-1">
              <StreamingWords
                words={RESPONSE_WORDS}
                wordIndex={responseWordIndex}
                confirmLag={RESPONSE_LAG}
              />
            </div>
          </div>
        </div>
      </div>
    </FeatureSection>
  );
}

function GetStarted() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.4, ease: "easeOut" }}
      className="pt-10"
    >
      <div className="flex flex-row flex-wrap gap-3">
        <DownloadButton />
        <a
          href={webAppUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#D81B60]/40 bg-[#D81B60]/10 px-4 py-2 text-sm font-medium text-white hover:bg-[#D81B60]/20 transition-colors"
        >
          <GlobeIcon className="h-4 w-4" />
          Web App
        </a>
        <ServerInstallButton />
      </div>
      <div className="pt-3 flex flex-wrap items-center gap-3">
        <a
          href="/download"
          className="text-xs text-[#FF4081] hover:text-[#FF80AB] transition-colors"
        >
          All download options
        </a>
        <span className="text-xs text-white/30">·</span>
        <span className="inline-flex items-center gap-1.5 text-xs text-white/40">
          <AppleIcon className="h-3 w-3" />
          <AndroidIcon className="h-3 w-3" />
          iOS &amp; Android coming soon
        </span>
      </div>
      <div className="flex items-center gap-3 pt-8">
        <span className="text-xs text-white/40">Works with</span>
        <div className="flex items-center rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 backdrop-blur-sm">
          <AgentBadge name="Claude Code" icon={<ClaudeCodeIcon className="h-5 w-5" />} />
          <AgentBadge name="Codex" icon={<CodexIcon className="h-5 w-5" />} />
          <AgentBadge name="OpenCode" icon={<OpenCodeIcon className="h-5 w-5" />} />
          <AgentBadge name="Copilot" icon={<CopilotIcon className="h-5 w-5" />} />
          <AgentBadge name="Pi" icon={<PiIcon className="h-5 w-5" />} />
          <span className="mx-1 h-3 w-px bg-white/15" />
          <AgentBadge
            name="Hubtool — Pro"
            icon={<img src="/logo-icon.png" alt="" className="h-5 w-5" />}
          />
        </div>
      </div>
    </motion.div>
  );
}

function DownloadButton() {
  const { version } = useRelease();
  const detectedPlatform = useDetectedPlatform();
  const options = getDownloadOptions(version);
  const detected = options.find((o) => o.platform === detectedPlatform)!;
  // If the detected platform isn't shipped yet (Windows / Linux), fall back to
  // Mac so the primary CTA always points at a real build. Show a small note so
  // those users know a native build is coming.
  const primary = detected.comingSoon
    ? options.find((o) => o.platform === "mac-silicon")!
    : detected;
  const PrimaryIcon = primary.icon;

  return (
    <div className="flex flex-col items-center gap-2">
      <a
        href={primary.href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-[#D81B60] to-[#FF4081] px-4 py-2 text-sm font-medium text-white shadow-[0_0_24px_-6px_rgba(216,27,96,0.7)] hover:from-[#E91E63] hover:to-[#FF6090] transition-all"
      >
        <PrimaryIcon className="h-4 w-4" />
        Download for {primary.label}
      </a>
      {detected.comingSoon ? (
        <span className="text-xs text-white/50">
          {detected.label} build coming soon — install via the CLI for now.
        </span>
      ) : null}
    </div>
  );
}

function ServerInstallButton() {
  return (
    <CommandDialog
      trigger={
        <span className="inline-flex items-center justify-center rounded-lg border border-white/20 px-3 py-2 text-white hover:bg-white/10 transition-colors">
          <TerminalIcon className="h-5 w-5" />
        </span>
      }
      title="Run agents on a remote machine"
      description="For headless machines you want to connect to from the Hubcode apps. The desktop app already includes a built-in daemon."
      command="npm install -g @hubcode/cli && hubcode"
      footnote={
        <>
          Requires Node.js 18+. Run <span className="font-mono text-white/40">hubcode</span> to
          start the daemon.
        </>
      }
    />
  );
}

function ClaudeCodeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
      {...props}
    >
      <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
    </svg>
  );
}

function CodexIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
      {...props}
    >
      <path d="M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z" />
    </svg>
  );
}

function OpenCodeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="96 64 288 384"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M320 224V352H192V224H320Z" opacity="0.4" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
      />
    </svg>
  );
}

function CopilotIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 416"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path
        d="M181.33 266.143c0-11.497 9.32-20.818 20.818-20.818 11.498 0 20.819 9.321 20.819 20.818v38.373c0 11.497-9.321 20.818-20.819 20.818-11.497 0-20.818-9.32-20.818-20.818v-38.373zM308.807 245.325c-11.477 0-20.798 9.321-20.798 20.818v38.373c0 11.497 9.32 20.818 20.798 20.818 11.497 0 20.818-9.32 20.818-20.818v-38.373c0-11.497-9.32-20.818-20.818-20.818z"
        fillRule="evenodd"
      />
      <path d="M512.002 246.393v57.384c-.02 7.411-3.696 14.638-9.67 19.011C431.767 374.444 344.695 416 256 416c-98.138 0-196.379-56.542-246.33-93.21-5.975-4.374-9.65-11.6-9.671-19.012v-57.384a35.347 35.347 0 016.857-20.922l15.583-21.085c8.336-11.312 20.757-14.31 33.98-14.31 4.988-56.953 16.794-97.604 45.024-127.354C155.194 5.77 226.56 0 256 0c29.441 0 100.807 5.77 154.557 62.722 28.19 29.75 40.036 70.401 45.025 127.354 13.263 0 25.602 2.936 33.958 14.31l15.583 21.127c4.476 6.077 6.878 13.345 6.878 20.88zm-97.666-26.075c-.677-13.058-11.292-18.19-22.338-21.824-11.64 7.309-25.848 10.183-39.46 10.183-14.454 0-41.432-3.47-63.872-25.869-5.667-5.625-9.527-14.454-12.155-24.247a212.902 212.902 0 00-20.469-1.088c-6.098 0-13.099.349-20.551 1.088-2.628 9.793-6.509 18.622-12.155 24.247-22.4 22.4-49.418 25.87-63.872 25.87-13.612 0-27.86-2.855-39.501-10.184-11.005 3.613-21.558 8.828-22.277 21.824-1.17 24.555-1.272 49.11-1.375 73.645-.041 12.318-.082 24.658-.288 36.976.062 7.166 4.374 13.818 10.882 16.774 52.97 24.124 103.045 36.278 149.137 36.278 46.01 0 96.085-12.154 149.014-36.278 6.508-2.956 10.84-9.608 10.881-16.774.637-36.832.124-73.809-1.642-110.62h.041zM107.521 168.97c8.643 8.623 24.966 14.392 42.56 14.392 13.448 0 39.03-2.874 60.156-24.329 9.28-8.951 15.05-31.35 14.413-54.079-.657-18.231-5.769-33.28-13.448-39.665-8.315-7.371-27.203-10.574-48.33-8.644-22.399 2.238-41.267 9.588-50.875 19.833-20.798 22.728-16.323 80.317-4.476 92.492zm130.556-56.008c.637 3.51.965 7.35 1.273 11.517 0 2.875 0 5.77-.308 8.952 6.406-.636 11.847-.636 16.959-.636s10.553 0 16.959.636c-.329-3.182-.329-6.077-.329-8.952.329-4.167.657-8.007 1.294-11.517-6.735-.637-12.812-.965-17.924-.965s-11.21.328-17.924.965zm49.275-8.008c-.637 22.728 5.133 45.128 14.413 54.08 21.105 21.454 46.708 24.328 60.155 24.328 17.596 0 33.918-5.769 42.561-14.392 11.847-12.175 16.322-69.764-4.476-92.492-9.608-10.245-28.476-17.595-50.875-19.833-21.127-1.93-40.015 1.273-48.33 8.644-7.679 6.385-12.791 21.434-13.448 39.665z" />
    </svg>
  );
}

function PiIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 800 800"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
        fillRule="evenodd"
      />
      <path d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  );
}

function AppStoreIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 960 960"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M342.277 86.6927C463.326 84.6952 587.87 65.619 705.523 104.97C830.467 143.522 874.012 278.153 872.814 397.105C873.713 481.299 874.012 566.193 858.931 649.19C834.262 804.895 746.172 873.01 590.666 874.608C422.377 880.301 172.489 908.965 104.474 711.012C76.5092 599.452 86.6964 481.1 88.1946 366.843C98.9811 200.75 163.301 90.2882 342.277 86.6927ZM715.411 596.156C758.856 591.362 754.362 524.645 710.816 524.545C610.542 525.244 639.605 550.513 594.462 456.83C577.383 418.778 540.529 337.279 496.085 396.006C479.206 431.062 516.359 464.121 528.844 495.382C569.892 560.6 606.647 628.515 648.494 693.334C667.77 724.495 716.509 696.73 697.333 663.372C685.048 642.298 677.258 619.726 665.773 598.253C682.452 597.854 698.831 598.053 715.411 596.156Z" />
      <path
        d="M697.234 663.371C716.41 696.729 667.671 724.494 648.395 693.333C606.548 628.614 569.794 560.699 528.745 495.381C516.161 464.219 479.107 431.161 495.986 396.005C540.43 337.178 577.384 418.776 594.363 456.829C639.506 550.512 610.443 525.243 710.717 524.544C754.263 524.644 758.757 591.361 715.312 596.155C698.732 598.052 682.453 597.852 665.674 598.252C677.159 619.725 684.95 642.297 697.234 663.371Z"
        fill="black"
      />
      <path
        d="M474.312 257.679C486.597 230.913 517.059 198.453 545.224 224.92C564.3 242.298 551.316 269.465 538.332 287.242C489.194 363.747 450.242 445.844 405.598 524.845C445.448 528.341 485.598 525.844 525.149 532.835C564.1 539.827 558.907 597.455 519.256 598.353C442.153 601.35 365.049 595.457 287.845 599.652C260.28 597.554 225.024 612.336 203.751 589.065C161.104 516.456 275.761 527.442 317.608 524.546C343.776 499.377 356.659 456.93 377.833 425.769C395.311 394.608 412.39 363.147 429.868 331.986C432.964 322.199 418.982 314.109 415.486 305.12C349.169 230.713 442.153 172.885 474.312 257.679Z"
        fill="black"
      />
      <path
        d="M265.471 626.12C284.647 595.758 329.491 609.042 330.39 643.199C325.296 664.872 313.511 684.647 298.53 701.027C275.758 724.997 235.009 703.124 242.5 670.864C246.195 654.485 256.882 640.302 265.471 626.12Z"
        fill="black"
      />
    </svg>
  );
}

function ChevronDownIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function Step({ number, children }: { number: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-xs font-medium">
        {number}
      </span>
      <div className="space-y-2 flex-1">{children}</div>
    </div>
  );
}

const bashKeywords = new Set([
  "while",
  "do",
  "done",
  "if",
  "then",
  "fi",
  "else",
  "break",
  "true",
  "false",
]);
const bashCommands = new Set(["hubcode", "echo", "jq"]);

function highlightBash(code: string): React.ReactNode {
  const tokens: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < code.length) {
    if (code[i] === "#" && (i === 0 || /[\s(]/.test(code[i - 1]))) {
      const end = code.indexOf("\n", i);
      const comment = end === -1 ? code.slice(i) : code.slice(i, end);
      tokens.push(
        <span key={key++} className="text-white/30 italic">
          {comment}
        </span>,
      );
      i += comment.length;
      continue;
    }

    if (code[i] === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== '"') {
        if (code[j] === "\\") j++;
        j++;
      }
      const str = code.slice(i, j + 1);
      tokens.push(
        <span key={key++} className="text-green-400/80">
          {str}
        </span>,
      );
      i = j + 1;
      continue;
    }

    if (code[i] === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== "'") j++;
      const str = code.slice(i, j + 1);
      tokens.push(
        <span key={key++} className="text-green-400/80">
          {str}
        </span>,
      );
      i = j + 1;
      continue;
    }

    if (code[i] === "$") {
      if (code[i + 1] === "(") {
        tokens.push(
          <span key={key++} className="text-amber-300/70">
            $(
          </span>,
        );
        i += 2;
        continue;
      }
      let j = i + 1;
      while (j < code.length && /\w/.test(code[j])) j++;
      tokens.push(
        <span key={key++} className="text-amber-300/70">
          {code.slice(i, j)}
        </span>,
      );
      i = j;
      continue;
    }

    if (
      code[i] === "-" &&
      (i === 0 || /\s/.test(code[i - 1])) &&
      i + 1 < code.length &&
      /[\w-]/.test(code[i + 1])
    ) {
      let j = i;
      if (code[j + 1] === "-") j++;
      j++;
      while (j < code.length && /[\w-]/.test(code[j])) j++;
      tokens.push(
        <span key={key++} className="text-sky-300/70">
          {code.slice(i, j)}
        </span>,
      );
      i = j;
      continue;
    }

    if (/[a-zA-Z_]/.test(code[i])) {
      let j = i;
      while (j < code.length && /\w/.test(code[j])) j++;
      const word = code.slice(i, j);
      if (bashKeywords.has(word)) {
        tokens.push(
          <span key={key++} className="text-purple-400">
            {word}
          </span>,
        );
      } else if (bashCommands.has(word)) {
        tokens.push(
          <span key={key++} className="text-white">
            {word}
          </span>,
        );
      } else {
        tokens.push(word);
        key++;
      }
      i = j;
      continue;
    }

    if (code[i] === "|" || (code[i] === "&" && code[i + 1] === "&")) {
      const op = code[i] === "|" ? "|" : "&&";
      tokens.push(
        <span key={key++} className="text-white/40">
          {op}
        </span>,
      );
      i += op.length;
      continue;
    }

    if (code[i] === "\\") {
      tokens.push(
        <span key={key++} className="text-white/40">
          \
        </span>,
      );
      i++;
      continue;
    }

    if (code[i] === ")") {
      tokens.push(
        <span key={key++} className="text-amber-300/70">
          )
        </span>,
      );
      i++;
      continue;
    }

    tokens.push(code[i]);
    i++;
  }

  return <>{tokens}</>;
}

function CLICodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = React.useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative rounded-xl overflow-hidden border border-white/10 bg-black/60 shadow-[0_20px_60px_-30px_rgba(216,27,96,0.5)]">
      <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.03] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#FF5F57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#FEBC2E]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28C840]" />
        </div>
        <span className="text-[11px] font-mono text-white/40">~/repo &nbsp;·&nbsp; hubcode</span>
        <span className="w-12" />
      </div>
      <button
        onClick={handleCopy}
        className="absolute top-9 right-3 text-white/30 hover:text-[#FF80AB] transition-colors p-1 z-10"
        title="Copy to clipboard"
      >
        {copied ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            fill="currentColor"
            viewBox="0 0 256 256"
          >
            <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            fill="currentColor"
            viewBox="0 0 256 256"
          >
            <path d="M216,28H88A20,20,0,0,0,68,48V76H40A20,20,0,0,0,20,96V216a20,20,0,0,0,20,20H168a20,20,0,0,0,20-20V188h28a20,20,0,0,0,20-20V48A20,20,0,0,0,216,28ZM164,212H44V100H164Zm48-48H188V96a20,20,0,0,0-20-20H92V52H212Z" />
          </svg>
        )}
      </button>
      <pre className="p-4 pr-10 text-xs leading-relaxed overflow-x-auto text-white/80 font-mono whitespace-pre">
        {highlightBash(children)}
      </pre>
    </div>
  );
}

interface CLIExample {
  title: string;
  description: string;
  code: string;
}

const cliExamples: CLIExample[] = [
  {
    title: "Run agents",
    description:
      "Launch agents locally or on any remote host. The --worktree flag spins up an isolated git branch so you can run multiple agents on the same repo without conflicts.",
    code: `hubcode run "implement user authentication"
hubcode run --provider codex --worktree feature-x "implement feature X"
hubcode run --host devbox:6767 "run the full test suite"

hubcode ls                           # list running agents
hubcode attach abc123                # stream live output
hubcode send abc123 "also add tests" # follow-up task`,
  },
  {
    title: "Loops",
    description:
      "Have one agent do the work, another verify the result, and loop until it passes. Built-in, no shell scripting needed.",
    code: `# Worker-verifier loop: fix tests until they pass
hubcode loop run "make all tests pass" \\
  --verify "verify tests pass and the code is production-ready" \\
  --verify-check "npm test" \\
  --max-iterations 5

hubcode loop ls                        # list running loops
hubcode loop logs abc123               # stream loop output`,
  },
  {
    title: "Schedules",
    description:
      "Run agents on a cron schedule. Automate recurring tasks like dependency updates, security audits, or report generation.",
    code: `# Run a security audit every Monday at 9am
hubcode schedule create --cron "0 9 * * 1" \\
  "audit the codebase for security issues and open PRs for fixes"

hubcode schedule ls                    # list all schedules
hubcode schedule pause abc123          # pause a schedule
hubcode schedule delete abc123         # remove a schedule`,
  },
];

function PhoneShowcase() {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const textInView = useInView(containerRef, { once: true, margin: "-80px" });

  // Scroll-linked animation: track how far through the container the user has scrolled
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start end", "center center"],
  });

  // Responsive slide distance
  const [slideDistance, setSlideDistance] = React.useState(260);
  React.useEffect(() => {
    function update() {
      setSlideDistance(window.innerWidth < 768 ? 140 : 260);
    }
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Side phones start at x=0 (behind center) and slide out to final position
  const sideOpacity = useTransform(scrollYProgress, [0.2, 0.6], [0, 1]);
  const leftX = useTransform(scrollYProgress, [0.2, 0.6], [0, -slideDistance]);
  const rightX = useTransform(scrollYProgress, [0.2, 0.6], [0, slideDistance]);

  return (
    <div ref={containerRef} className="flex flex-col items-center pt-4 pb-16 gap-20">
      {/* Arrow + text */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={textInView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.5 }}
        className="flex flex-col items-center gap-1.5 px-6"
      >
        <svg
          width="24"
          height="24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          viewBox="0 0 24 24"
          className="text-white/20"
        >
          <path d="M12 5v14M5 12l7 7 7-7" />
        </svg>
        <p className="text-lg text-white/80 text-center">
          When you want to step away from your desk,
          <br className="md:hidden" /> you can.
        </p>
        <p className="text-sm text-white/50 text-center">
          The native mobile app has full feature parity with desktop.
        </p>
      </motion.div>

      {/* Phone trio — side phones are absolute, start behind center, slide outward with perspective rotation */}
      <div
        className="relative flex items-center justify-center overflow-x-clip w-full"
        style={{ minHeight: 480, perspective: 1200 }}
      >
        {/* Left phone — rotated to face inward */}
        <motion.div
          style={{ opacity: sideOpacity, x: leftX, rotateY: -15, scale: 0.97 }}
          className="w-[160px] md:w-[240px] absolute"
        >
          <img
            src="/phone-1.png"
            alt="Hubcode sessions list"
            className="w-full rounded-[40px] shadow-2xl border-[3px] border-black outline-[3px] outline-white/20"
          />
        </motion.div>

        {/* Center phone */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={textInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6, delay: 0.1, ease: "easeOut" }}
          className="w-[220px] md:w-[240px] relative z-10"
        >
          <img
            src="/phone-2.png"
            alt="Hubcode agent chat"
            className="w-full rounded-[40px] shadow-2xl border-[3px] border-black outline-[3px] outline-white/20"
          />
        </motion.div>

        {/* Right phone — rotated to face inward */}
        <motion.div
          style={{ opacity: sideOpacity, x: rightX, rotateY: 15, scale: 0.97 }}
          className="w-[160px] md:w-[240px] absolute"
        >
          <img
            src="/phone-3.png"
            alt="Hubcode diff view"
            className="w-full rounded-[40px] shadow-2xl border-[3px] border-black outline-[3px] outline-white/20"
          />
        </motion.div>
      </div>
    </div>
  );
}

function CLISection() {
  const [activeIndex, setActiveIndex] = React.useState(0);
  const active = cliExamples[activeIndex];

  return (
    <FeatureSection
      title="Fully scriptable"
      description="Everything you can do in the app, you can do from the terminal."
    >
      <div className="flex flex-wrap gap-2">
        {cliExamples.map((example, i) => (
          <button
            key={example.title}
            onClick={() => setActiveIndex(i)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
              i === activeIndex
                ? "border-[#D81B60]/50 text-white bg-[#D81B60]/15"
                : "border-white/15 text-white/50 hover:text-white/80 hover:border-[#D81B60]/30"
            }`}
          >
            {example.title}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        <CLICodeBlock>{active.code}</CLICodeBlock>
      </div>

      <a
        href="/docs/cli"
        className="inline-flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors"
      >
        Full CLI reference
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          viewBox="0 0 24 24"
        >
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </a>
    </FeatureSection>
  );
}

function FAQ() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="space-y-6"
    >
      <div className="space-y-3">
        <span className="inline-flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-[#FF80AB]">
          <span className="block h-[2px] w-8 rounded-full bg-gradient-to-r from-[#D81B60] to-[#FF4081]" />
          FAQ
        </span>
        <h2 className="text-3xl md:text-4xl font-medium tracking-tight bg-gradient-to-br from-white to-white/70 bg-clip-text text-transparent">
          Common questions
        </h2>
      </div>
      <div className="space-y-2">
        <FAQItem question="Is this free?">
          <p>
            Yes. The Hubcode app, daemon and CLI are free and open source. Bring your own keys for
            Claude Code, Codex, OpenCode, Copilot or Pi and you keep everything we ship — chat,
            kanban, voice, shared sessions, MCP, integrations.
          </p>
          <p>
            Optional <span className="text-[#FF80AB]">Pro</span> and{" "}
            <span className="text-[#FF80AB]">Team</span> plans are available if you want the curated{" "}
            <strong>Hubtool agent</strong> (multi-model routing through our backend on a single
            subscription), the hosted E2E-encrypted relay for remote access without setting up your
            own tunnel, and team features for shared sessions across organizations.
          </p>
          <p>Voice is local-first by default and can optionally use OpenAI speech providers.</p>
        </FAQItem>
        <FAQItem question="Does my code leave my machine?">
          Hubcode doesn't send your code anywhere. Agents run locally and talk to their own APIs as
          they normally would. For remote access, you can use the optional{" "}
          <a href="/docs/security" className="underline hover:text-white/80">
            end-to-end encrypted relay
          </a>
          , connect directly over your local network, or use your own tunnel.
        </FAQItem>
        <FAQItem question="What agents does it support?">
          Claude Code, Codex, OpenCode, Copilot and Pi as native GUI providers, plus any installed
          CLI agent (Codex CLI, Claude CLI, Gemini CLI, etc.). There's also an optional Hubtool
          agent — a curated multi-model agent routed through the Hubcode backend, available on the
          Pro plan. Each native agent runs as its own process using its own CLI; Hubcode doesn't
          modify or wrap their behavior.
        </FAQItem>
        <FAQItem question="Can I share a live agent session with a teammate?">
          Yes. Open a shared session and invite someone — they'll see the agent chat, the diffs and
          the kanban in real time, with a built-in voice + video room while you pair. The session is
          brokered through your daemon (or the optional E2E-encrypted relay), not stored on a
          third-party service.
        </FAQItem>
        <FAQItem question="Do I need the desktop app?">
          No. You can run the daemon headless with{" "}
          <code className="font-mono text-muted-foreground">
            npm install -g @hubcode/cli && hubcode
          </code>{" "}
          and use the CLI, web app, or mobile app to connect. The desktop app just bundles the
          daemon with a UI.
        </FAQItem>
        <FAQItem question="How does voice work?">
          Voice runs locally on your device by default. You talk, the app transcribes and sends it
          to your agent as text. Optionally, you can configure OpenAI speech providers for
          higher-quality transcription and text-to-speech. See the{" "}
          <a href="/docs/voice" className="underline hover:text-white/80">
            voice docs
          </a>
          .
        </FAQItem>
        <FAQItem question="Can I connect from outside my network?">
          Yes. You can use the hosted relay (end-to-end encrypted, Hubcode can't read your traffic),
          set up your own tunnel (Tailscale, Cloudflare Tunnel, etc.), or expose the daemon port
          directly. See{" "}
          <a href="/docs/configuration" className="underline hover:text-white/80">
            configuration
          </a>
          .
        </FAQItem>
        <FAQItem question="Do I need git or GitHub?">
          No. Hubcode works in any directory. Worktrees are optional and only relevant if you use
          git. You can run agents anywhere you'd normally work.
        </FAQItem>
        <FAQItem question="Can I get banned for using Hubcode?">
          <p>We can't make promises on behalf of providers.</p>
          <p>
            That said, Hubcode launches the official first-party CLIs (Claude Code, Codex, OpenCode)
            as subprocesses. It doesn't extract tokens or call inference APIs directly. From the
            provider's perspective, usage through Hubcode is indistinguishable from running the CLI
            yourself.
          </p>
          <p>I've been using Hubcode with all providers for months without issue.</p>
        </FAQItem>
        <FAQItem question="How do worktrees work?">
          When you launch an agent with the worktree option (from the app, desktop, or CLI), Hubcode
          creates a git worktree and runs the agent inside it. The agent works on an isolated branch
          without touching your main working directory. See the{" "}
          <a href="/docs/worktrees" className="underline hover:text-white/80">
            worktrees docs
          </a>
          .
        </FAQItem>
      </div>
    </motion.div>
  );
}

function AttachmentChip({
  icon,
  label,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs rounded-md border border-white/10 bg-white/5 px-2 py-1 text-white/80">
      <span className="text-white/70">{icon}</span>
      <span className="font-medium">{label}</span>
      {sub ? <span className="text-white/40">· {sub}</span> : null}
    </span>
  );
}

function FAQItem({ question, children }: { question: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-xl border border-white/10 bg-white/[0.02] open:border-[#D81B60]/30 open:bg-[#D81B60]/[0.04] transition-colors">
      <summary className="font-medium text-sm cursor-pointer list-none flex items-center justify-between gap-3 px-5 py-4 hover:text-white">
        <span className="text-white/90">{question}</span>
        <span className="flex-shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/15 bg-white/[0.04] text-[#FF80AB] text-base leading-none transition-transform group-open:rotate-45 group-open:border-[#D81B60]/50 group-open:bg-[#D81B60]/15">
          +
        </span>
      </summary>
      <div className="text-sm text-white/65 space-y-2 px-5 pb-5 prose prose-invert max-w-none">
        {children}
      </div>
    </details>
  );
}
