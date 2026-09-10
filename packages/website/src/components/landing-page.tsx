import * as React from "react";
import {
  ArrowRight,
  Bot,
  BookOpen,
  Braces,
  Coffee,
  ExternalLink,
  GitFork,
  Laptop,
  Monitor,
  Puzzle,
  Smartphone,
  Terminal,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  motion,
  AnimatePresence,
  useInView,
  useScroll,
  useTransform,
  type Transition,
} from "framer-motion";

// Shared motion presets — hoisted so every JSX site receives the same object
// reference and doesn't trigger jsx-no-new-object-as-prop.
const FADE_IN_UP = { opacity: 0, y: 20 };
const FADE_IN = { opacity: 1, y: 0 };
const FADE_IN_UP_TINY = { opacity: 0, y: -10 };
const FADE_IN_UP_XL = { opacity: 0, y: 30 };
const FADE_IN_UP_40 = { opacity: 0, y: 40 };
const FADE_IN_UP_4 = { opacity: 0, y: 4 };
const FADE_OUT_UP_4 = { opacity: 0, y: 4 };

const EASE_OUT_06_DELAY_01: Transition = { duration: 0.6, delay: 0.1, ease: "easeOut" };
const EASE_OUT_08_DELAY_05: Transition = { duration: 0.8, delay: 0.5, ease: "easeOut" };
const EASE_OUT_05: Transition = { duration: 0.5, ease: "easeOut" };
const EASE_OUT_015: Transition = { duration: 0.15, ease: "easeOut" };
const DURATION_05: Transition = { duration: 0.5 };

const VIEWPORT_60 = { once: true, margin: "-60px" };
const AGENT_LIST_GRID_STYLE = {
  gridTemplateColumns: "auto auto auto minmax(0, 1fr)",
};

// A ~240px-wide phone rotated 15° only foreshortens a couple percent at
// perspective 1200 — it reads as a flat, skewed card. The side phones already
// sit on a correctly projecting plane (the frame and its scaled interior share
// one flattened texture), so the interior just needs the projection to be
// strong enough to see: a tighter perspective gives the trio a real book-fold.
const PHONE_PERSPECTIVE_STYLE = { minHeight: 480, perspective: 700 };
import { CursorFieldProvider } from "~/components/butterfly";
import { CommandDialog } from "~/components/command-dialog";
import { AGENT_PAGES } from "~/data/agent-pages";
import {
  appStoreUrl,
  playStoreUrl,
  getDesktopDownload,
  MOBILE_STORES,
  AppleIcon,
  PlayStoreIcon,
  TerminalIcon,
} from "~/downloads";
import type { DesktopPlatform, MobilePlatform } from "~/platform";
import { isMobilePlatform } from "~/platform";
import { useRelease, useVisitorPlatform } from "~/routes/__root";
import { HeroMockup } from "~/components/hero-mockup";
import {
  ClaudeCodeIcon,
  CodexIcon,
  CursorIcon,
  OpenCodeIcon,
  PiIcon,
} from "~/components/agent-icons";
import { DiscordIcon, GitHubIcon, SlackIcon } from "~/components/brand-icons";
import { ClaudeIcon, MobileChat, MobileDiff, MobileSidebar, PhoneFrame } from "~/components/mockup";
import { FAQItem } from "~/components/faq-item";
import { SiteFooter } from "~/components/site-footer";
import { SiteHeader } from "~/components/site-header";
import "~/styles.css";

interface LandingPageProps {
  title: React.ReactNode;
  subtitle: React.ReactNode;
}

export function LandingPage({ title, subtitle }: LandingPageProps) {
  return (
    <CursorFieldProvider>
      {/* Hero section with background image */}
      <div className="relative bg-cover bg-center bg-no-repeat">
        <div className="relative px-6 pt-4 pb-10 md:px-32 md:pt-6 md:pb-12 max-w-7xl mx-auto">
          <Nav />
          <Hero title={title} subtitle={subtitle} />
          <GetStarted />
        </div>

        {/* Mockup - inside hero so it's above the gradient, positioned to overflow into black section */}
        <motion.div
          initial={FADE_IN_UP_40}
          animate={FADE_IN}
          transition={EASE_OUT_08_DELAY_05}
          className="relative px-6 md:px-8 pt-4 md:pt-8 pb-8 md:pb-16"
        >
          <div className="max-w-7xl mx-auto">
            <HeroMockup />
          </div>
        </motion.div>
      </div>

      {/* Phone showcase */}
      <PhoneShowcase />

      {/* Content section */}
      <div className="landing-content bg-background">
        <main className="p-6 md:p-20 md:pt-40 max-w-5xl mx-auto">
          <div className="space-y-24">
            <SocialProofWall />
            <MultiProviderSection />
            <TurnkeySection />
            <AutomationSection />
            <ExtensibleSection />
            <FAQ />
            <SponsorCTA />
          </div>
        </main>
        <SiteFooter />
      </div>
    </CursorFieldProvider>
  );
}

function Nav() {
  return (
    <nav className="mb-20 md:mb-24">
      <SiteHeader />
    </nav>
  );
}

function Hero({ title, subtitle }: { title: React.ReactNode; subtitle: React.ReactNode }) {
  return (
    <div className="space-y-6 text-center">
      <h1 className="text-4xl md:text-6xl font-medium tracking-tight leading-[0.95]">{title}</h1>
      <p className="text-base leading-relaxed text-white/70 md:text-lg max-w-lg mx-auto">
        {subtitle}
      </p>
    </div>
  );
}

const CLAUDE_CODE_BADGE_ICON = <ClaudeCodeIcon className="h-6 w-6" />;
const CODEX_BADGE_ICON = <CodexIcon className="h-6 w-6" />;
const OPENCODE_BADGE_ICON = <OpenCodeIcon className="h-6 w-6" />;
const PI_BADGE_ICON = <PiIcon className="h-6 w-6" />;
const CURSOR_BADGE_ICON = <CursorIcon className="h-6 w-6" />;

const FEATURED_AGENT_COUNT = 5;
const ADDITIONAL_AGENT_COUNT = AGENT_PAGES.length - FEATURED_AGENT_COUNT;

const SOCIAL_PROOF_TWEETS = [
  {
    name: "Cam",
    handle: "@ceeebeeebeee",
    date: "Apr 6, 2026",
    avatar: "/social-proof/ceeebeeebeee.jpg",
    url: "https://x.com/ceeebeeebeee/status/2041008798798864537",
    text: "without a doubt the most slept on orchestrator right now. Open source, every OS, and a mobile experience that truly blew me away.",
  },
  {
    name: "Erik Sherman",
    handle: "@erikksherman",
    date: "Apr 11, 2026",
    avatar: "/social-proof/erikksherman.jpg",
    url: "https://x.com/erikksherman/status/2043011630590751008",
    text: "control agents from anywhere - mac, phone, web. one simple change transformed my health while INCREASING productivity",
  },
  {
    name: "Aman Kumar Jagdev",
    handle: "@amankumarjagdev",
    date: "Apr 16, 2026",
    avatar: "/social-proof/amankumarjagdev.jpg",
    url: "https://x.com/amankumarjagdev/status/2044815258414674307",
    text: "I have tried 100s of agent orchestrator, cli and gui. the best one i have found. Please give it a try! it's really good",
  },
  {
    name: "RUI",
    handle: "@tietougongshiba",
    date: "May 3, 2026",
    avatar: "/social-proof/tietougongshiba.jpg",
    url: "https://x.com/tietougongshiba/status/2050886374941925754",
    text: "Being able to check and manage agent progress from my phone while I'm out is so convenient.",
  },
  {
    name: "Jason Torres",
    handle: "@jasontorres",
    date: "May 11, 2026",
    avatar: "/social-proof/jasontorres.jpg",
    url: "https://x.com/jasontorres/status/2053875385515790731",
    text: "Can interchange between Codex, Claude Code, Opencode, Pi. Stable mobile and desktop apps connected through a secure relay from your VMs.",
  },
  {
    name: "A9",
    handle: "@aadtyn",
    date: "May 29, 2026",
    avatar: "/social-proof/aadtyn.jpg",
    url: "https://x.com/aadtyn/status/2060371229773803943",
    text: "cross platform agent orchestration with inbuilt relay and tailscale / self host daemon options + the best UI ive seen in this segment",
  },
  {
    name: "boris evstratov",
    handle: "@bevstratov",
    date: "May 30, 2026",
    avatar: "/social-proof/bevstratov.jpg",
    url: "https://x.com/bevstratov/status/2060733983042781550",
    text: "It’s an incredible piece of software. The last building block I needed to fully work from my phone. everything super smooth.",
  },
  {
    name: "Arnold Gamboa",
    handle: "@arnoldgamboa",
    date: "May 28, 2026",
    avatar: "/social-proof/arnoldgamboa.jpg",
    url: "https://x.com/arnoldgamboa/status/2059832028099436921",
    text: "Paseo is a really good interface for Pi. It’s not the only thing it does, but that’s my current use case for now.",
  },
  {
    name: "Dong",
    handle: "@dongnaebi",
    date: "Apr 12, 2026",
    avatar: "/social-proof/dongnaebi.jpg",
    url: "https://x.com/dongnaebi/status/2043162391941398735",
    text: "Paseo is the best software I've used this year. Absolutely amazing!",
  },
] as const;

const SOCIAL_PROOF_ROWS = [
  { id: "top", tweets: SOCIAL_PROOF_TWEETS.slice(0, 5), reverse: false },
  { id: "bottom", tweets: SOCIAL_PROOF_TWEETS.slice(5), reverse: true },
] as const;

type SocialProofTweet = (typeof SOCIAL_PROOF_TWEETS)[number];

function AgentBadge({ name, icon }: { name: string; icon: React.ReactNode }) {
  const [hovered, setHovered] = React.useState(false);
  const handleMouseEnter = React.useCallback(() => setHovered(true), []);
  const handleMouseLeave = React.useCallback(() => setHovered(false), []);

  return (
    <span
      className="relative inline-flex items-center justify-center rounded-full p-1.5 text-white/60"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {icon}
      <AnimatePresence>
        {hovered && (
          <motion.span
            initial={FADE_IN_UP_4}
            animate={FADE_IN}
            exit={FADE_OUT_UP_4}
            transition={EASE_OUT_015}
            className="absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 rounded bg-white text-black text-xs whitespace-nowrap pointer-events-none"
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
  badge,
  links,
  children,
}: {
  title: string;
  description: string;
  badge?: string;
  links?: ReadonlyArray<{ href: string; label: string }>;
  children: React.ReactNode;
}) {
  return (
    <motion.section
      initial={FADE_IN_UP}
      whileInView={FADE_IN}
      viewport={VIEWPORT_60}
      transition={EASE_OUT_05}
    >
      <SectionTitle title={title} description={description} badge={badge} links={links} />
      {children}
    </motion.section>
  );
}

function SectionTitle({
  title,
  description,
  badge,
  links,
}: {
  title: string;
  description: string;
  badge?: string;
  links?: ReadonlyArray<{ href: string; label: string }>;
}) {
  return (
    <div className="mb-12 space-y-2">
      <div className="flex items-center gap-3">
        <h2 className="text-3xl font-medium">{title}</h2>
        {badge && (
          <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-xs text-emerald-300">
            {badge}
          </span>
        )}
      </div>
      <p className="text-base text-pretty text-muted-foreground max-w-lg">{description}</p>
      {links ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-extra-muted-foreground transition-colors hover:text-muted-foreground"
            >
              {link.label}
              <ExternalLink className="h-3 w-3" />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SocialProofWall() {
  return (
    <motion.section
      initial={FADE_IN_UP}
      whileInView={FADE_IN}
      viewport={VIEWPORT_60}
      transition={EASE_OUT_05}
    >
      <SectionTitle
        title="Loved by developers"
        description="See what developers are saying about Paseo"
      />

      <div className="social-proof-marquee space-y-4 overflow-hidden">
        {SOCIAL_PROOF_ROWS.map((row) => (
          <SocialProofRow key={row.id} tweets={row.tweets} reverse={row.reverse} />
        ))}
      </div>
    </motion.section>
  );
}

function SocialProofRow({
  tweets,
  reverse,
}: {
  tweets: readonly SocialProofTweet[];
  reverse: boolean;
}) {
  return (
    <div className="social-proof-row">
      <div className={`social-proof-track ${reverse ? "social-proof-track-reverse" : ""}`}>
        <div className="flex shrink-0 gap-4 pr-4">
          {tweets.map((tweet) => (
            <SocialProofCard key={tweet.url} tweet={tweet} />
          ))}
        </div>
        <div className="flex shrink-0 gap-4 pr-4" aria-hidden="true">
          {tweets.map((tweet) => (
            <SocialProofCard key={`${tweet.url}-clone`} tweet={tweet} inert />
          ))}
        </div>
      </div>
    </div>
  );
}

function SocialProofCard({ tweet, inert }: { tweet: SocialProofTweet; inert?: boolean }) {
  return (
    <a
      href={tweet.url}
      target="_blank"
      rel="noreferrer"
      tabIndex={inert ? -1 : undefined}
      className="group flex h-[154px] w-[320px] shrink-0 flex-col justify-between overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/20 hover:bg-white/[0.05] md:w-[420px]"
      aria-label={`Read ${tweet.name}'s original post`}
    >
      <div>
        <div className="flex min-w-0 items-center gap-3">
          <img
            src={tweet.avatar}
            alt=""
            width={28}
            height={28}
            loading="lazy"
            decoding="async"
            className="h-7 w-7 shrink-0 rounded-full bg-white/10 object-cover"
          />
          <p className="truncate text-sm font-medium text-white/60">{tweet.handle}</p>
        </div>
        <p className="social-proof-card-text mt-4 text-sm leading-relaxed text-white/72">
          {tweet.text}
        </p>
      </div>
    </a>
  );
}

const PROVIDER_ICON_CLASS = "h-5 w-5 sm:h-7 sm:w-7";

function MultiProviderSection() {
  const providers = [
    { name: "Claude Code", icon: <ClaudeIcon className={PROVIDER_ICON_CLASS} /> },
    { name: "Codex", icon: <CodexIcon className={PROVIDER_ICON_CLASS} /> },
    { name: "OpenCode", icon: <OpenCodeIcon className={PROVIDER_ICON_CLASS} /> },
    { name: "Pi", icon: <PiIcon className={PROVIDER_ICON_CLASS} /> },
    { name: "Cursor", icon: <CursorIcon className={PROVIDER_ICON_CLASS} /> },
  ];

  return (
    <FeatureSection
      title="Works with your tools"
      description="Bring your subscriptions, skills and configuration"
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-4">
        {providers.map((p) => (
          <div
            key={p.name}
            className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 sm:gap-3 sm:px-5 sm:py-4"
          >
            <span className="shrink-0 text-white/80">{p.icon}</span>
            <span className="truncate text-sm font-medium sm:text-base">{p.name}</span>
          </div>
        ))}
        <a
          href="/agents"
          className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-white/10 bg-white/[0.01] px-3 py-3 text-white/50 hover:text-white/80 hover:border-white/20 hover:bg-white/[0.03] transition-colors sm:gap-3 sm:px-5 sm:py-4"
        >
          <span className="text-sm font-medium sm:text-base">+{ADDITIONAL_AGENT_COUNT} more</span>
        </a>
      </div>
    </FeatureSection>
  );
}

function TurnkeySection() {
  return (
    <FeatureSection
      title="Run it anywhere"
      description="Use Paseo locally, from another machine, or with a team"
    >
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="flex flex-col gap-6 border-b border-white/10 p-6 sm:flex-row sm:items-center sm:justify-between md:p-8">
          <div className="flex items-start gap-4">
            <div className="rounded-xl border border-white/10 bg-white/[0.06] p-3 text-muted-foreground">
              <Monitor className="h-6 w-6" strokeWidth={1.5} />
            </div>
            <div className="space-y-0.5">
              <h3 className="text-xl font-medium text-white/90">Desktop app</h3>
              <p className="max-w-lg text-sm leading-relaxed text-white/50">
                The one click experience, download the app and it just works
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 md:p-8">
          <div className="grid gap-4 md:grid-cols-3">
            <TurnkeyExtensionCard
              icon={Smartphone}
              title="Mobile and web"
              description="Connect to the same workspaces from any client"
              ctaHref="/download"
              ctaLabel="Download"
            />
            <TurnkeyExtensionCard
              icon={Laptop}
              title="Remote machines"
              description="Run Paseo on a home lab, or a cloud machine"
              ctaHref="/docs#server--cli"
              ctaLabel="Docs"
            />
            <TurnkeyExtensionCard
              icon={Users}
              title="Teams and triggers"
              description="Share access or start work from GitHub, Slack, and Discord"
              ctaHref="/hub"
              ctaLabel="Paseo Hub"
              showIntegrationIcons
            />
          </div>
        </div>
      </div>
    </FeatureSection>
  );
}

function TurnkeyExtensionCard({
  icon: Icon,
  title,
  description,
  ctaHref,
  ctaLabel,
  showIntegrationIcons = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  ctaHref: string;
  ctaLabel: string;
  showIntegrationIcons?: boolean;
}) {
  return (
    <div className="flex min-h-48 flex-col rounded-xl border border-white/10 bg-white/[0.025] p-5">
      <div className="mb-5 flex items-center gap-3 text-muted-foreground">
        <Icon className="h-5 w-5" strokeWidth={1.5} />
        {showIntegrationIcons ? (
          <>
            <GitHubIcon className="h-4 w-4" />
            <SlackIcon className="h-4 w-4" />
            <DiscordIcon className="h-4 w-4" />
          </>
        ) : null}
      </div>
      <h3 className="font-medium text-white/85">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-white/45">{description}</p>
      <div className="mt-auto pt-5">
        <a
          href={ctaHref}
          className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-2.5 py-1.5 text-xs text-background transition-colors hover:bg-foreground/90"
        >
          {ctaLabel}
          <ArrowRight className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  );
}

type AutomationKind = "mcp" | "cli" | "sdk";

const AUTOMATION_OPTIONS: Array<{
  kind: AutomationKind;
  label: string;
  caption: string;
  icon: LucideIcon;
}> = [
  {
    kind: "mcp",
    label: "MCP",
    caption: "From another agent",
    icon: Bot,
  },
  {
    kind: "cli",
    label: "CLI",
    caption: "From the terminal",
    icon: Terminal,
  },
  {
    kind: "sdk",
    label: "SDK",
    caption: "From code",
    icon: Braces,
  },
];

const AUTOMATION_LINKS = [
  { href: "/docs/mcp", label: "MCP docs" },
  { href: "/docs/cli", label: "CLI docs" },
  { href: "/docs/sdk", label: "SDK docs" },
] as const;

function AutomationSection() {
  const [activeKind, setActiveKind] = React.useState<AutomationKind>("mcp");

  return (
    <FeatureSection
      title="Built for automation"
      description="Use MCP, the CLI, or the TypeScript SDK to automate Paseo"
      links={AUTOMATION_LINKS}
    >
      <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="grid self-start gap-2" role="tablist">
          {AUTOMATION_OPTIONS.map((option) => (
            <AutomationSelector
              key={option.kind}
              option={option}
              active={option.kind === activeKind}
              onSelect={setActiveKind}
            />
          ))}
        </div>
        <AutomationDetail kind={activeKind} />
      </div>
    </FeatureSection>
  );
}

function AutomationSelector({
  option,
  active,
  onSelect,
}: {
  option: (typeof AUTOMATION_OPTIONS)[number];
  active: boolean;
  onSelect: (kind: AutomationKind) => void;
}) {
  const Icon = option.icon;
  const handleClick = React.useCallback(() => onSelect(option.kind), [onSelect, option.kind]);

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={handleClick}
      className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors md:block md:p-4 ${
        active
          ? "border-white/20 bg-white/[0.07]"
          : "border-white/10 bg-white/[0.025] hover:border-white/15 hover:bg-white/[0.04]"
      }`}
    >
      <div className="flex shrink-0 items-center gap-2 text-muted-foreground md:mb-1">
        <Icon className="h-3 w-3" strokeWidth={1.5} />
        <span className="text-[10px]">{option.label}</span>
      </div>
      <p className="text-xs leading-snug text-white/85 md:text-sm">{option.caption}</p>
    </button>
  );
}

function AutomationDetail({ kind }: { kind: AutomationKind }) {
  return (
    <div
      role="tabpanel"
      className="min-h-80 min-w-0 overflow-hidden rounded-xl border border-white/10 bg-black/20 p-5 md:h-[26rem] md:p-6"
    >
      {kind === "mcp" ? <McpAutomationTranscript /> : null}
      {kind === "cli" ? <CliAutomationExample /> : null}
      {kind === "sdk" ? <SdkAutomationExample /> : null}
    </div>
  );
}

function McpAutomationTranscript() {
  return (
    <div className="space-y-5">
      <div className="ml-auto w-fit max-w-xl rounded-xl rounded-tr-none bg-white/[0.07] px-4 py-3">
        <p className="text-sm leading-relaxed text-white/75">
          Take the open GitHub issues labeled ready and fan them out to separate worktree agents.
        </p>
      </div>
      <div className="flex items-start gap-3">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <div className="min-w-0 flex-1 space-y-4">
          <p className="text-sm leading-relaxed text-white/55">
            I found two ready issues. I will run each in its own worktree.
          </p>
          <div className="space-y-2 font-mono text-[11px]">
            <McpAgentCall issue="#412" provider="claude/opus-4.6" />
            <McpAgentCall issue="#417" provider="codex/gpt-5.6-sol" />
          </div>
          <p className="text-sm leading-relaxed text-white/55">
            Done, two agents are running. I will let you know when they finish.
          </p>
        </div>
      </div>
    </div>
  );
}

function McpAgentCall({ issue, provider }: { issue: string; provider: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-white/[0.07] bg-white/[0.025] px-3 py-2">
      <span className="text-sky-300/80">create_agent</span>
      <span className="text-white/25">{issue}</span>
      <span className="text-white/35">{provider}</span>
      <span className="text-white/25">worktree</span>
    </div>
  );
}

function CliAutomationExample() {
  return (
    <div className="font-mono text-[11px] leading-5 text-white/60">
      <div className="space-y-6">
        <div>
          <ShellPrompt>
            <span className="text-white">paseo run</span> <span className="text-white/35">\</span>
          </ShellPrompt>
          <div className="pl-5">
            <span className="text-sky-300/75">--provider</span>{" "}
            <span className="text-white/75">codex/gpt-5.6-sol</span>{" "}
            <span className="text-white/35">\</span>
          </div>
          <div className="pl-5 text-emerald-300/80">{'"Fix issue #412 and add tests."'}</div>
          <div className="mt-1 text-emerald-300/65">✓ Started agent a7f3c2</div>
        </div>

        <div className="space-y-1">
          <ShellPrompt>
            <span className="text-white">paseo ls</span>
          </ShellPrompt>
          <AgentListOutput />
        </div>

        <div>
          <div className="text-white/30"># Target another host</div>
          <ShellPrompt>
            <span className="text-white">paseo ls</span>{" "}
            <span className="text-sky-300/75">--host</span>{" "}
            <span className="text-white/75">devbox:6767</span>
          </ShellPrompt>
        </div>
      </div>
    </div>
  );
}

function ShellPrompt({ children }: { children: React.ReactNode }) {
  return (
    <div className="whitespace-nowrap">
      <span className="select-none text-white/25">$ </span>
      {children}
    </div>
  );
}

function AgentListOutput() {
  return (
    <div className="grid gap-x-5" style={AGENT_LIST_GRID_STYLE}>
      <span className="text-white/30">AGENT</span>
      <span className="text-white/30">STATUS</span>
      <span className="text-white/30">PROVIDER/MODEL</span>
      <span className="text-white/30">TITLE</span>
      <span className="text-white/55">a7f3c2</span>
      <span className="text-emerald-300/70">running</span>
      <span className="text-white/55">codex/gpt-5.6-sol</span>
      <span className="text-white/55">Fix issue #412 and add tests.</span>
    </div>
  );
}

function SdkAutomationExample() {
  return (
    <pre className="overflow-x-auto font-mono text-[11px] leading-5 text-white/60">
      <span className="text-purple-300">import</span> {"{"} createPaseoClient {"}"}{" "}
      <span className="text-purple-300">from</span>{" "}
      <span className="text-emerald-300/80">{'"@getpaseo/client"'}</span>;{"\n\n"}
      <span className="text-purple-300">const</span> client ={" "}
      <span className="text-sky-300">createPaseoClient</span>({"{"}
      {"\n"} url: <span className="text-emerald-300/80">{'"ws://127.0.0.1:6767/ws"'}</span>,{"\n"}
      {"}"});
      {"\n"}
      <span className="text-purple-300">await</span> client.
      <span className="text-sky-300">connect</span>();
      {"\n\n"}
      <span className="text-purple-300">const</span> agent ={" "}
      <span className="text-purple-300">await</span> client.agents.
      <span className="text-sky-300">create</span>({"{"}
      {"\n"} config: {"{"} provider:{" "}
      <span className="text-emerald-300/80">{'"codex/gpt-5.6-sol"'}</span> {"}"},{"\n"} cwd:{" "}
      <span className="text-emerald-300/80">{'"/Users/me/dev/paseo"'}</span>,{"\n"} prompt:{" "}
      <span className="text-emerald-300/80">{'"Fix issue #412 and add tests."'}</span>,{"\n"}
      {"}"});
      {"\n\n"}
      <span className="text-purple-300">const</span> result ={" "}
      <span className="text-purple-300">await</span> agent.
      <span className="text-sky-300">waitForFinish</span>();
    </pre>
  );
}

function ExtensibleSection() {
  return (
    <FeatureSection title="Make it yours" description="Extend Paseo to work just the way you want">
      <div className="grid gap-4 md:grid-cols-2">
        <ExtensibleCard
          icon={Puzzle}
          title="Plugins"
          description="Plugins can add server-side functionality and modify the client with custom components. They work across all clients, including mobile"
          links={PLUGIN_CARD_LINKS}
        />
        <ExtensibleCard
          icon={GitFork}
          title="Fork the repo"
          description="Paseo is licensed under Apache 2.0. You can inspect the implementation, fork the project, and adapt it to your workflow or organization"
          links={FORK_CARD_LINKS}
        />
      </div>
    </FeatureSection>
  );
}

interface ExtensibleCardLink {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  external?: boolean;
  /** Accent links stand out without hover, for destinations worth noticing. */
  accent?: boolean;
}

const PLUGIN_CARD_LINKS: ReadonlyArray<ExtensibleCardLink> = [
  { href: "/docs/plugins", label: "Plugin documentation", icon: BookOpen },
  {
    href: "https://paseo.cafe",
    label: "Community plugins",
    icon: Coffee,
    external: true,
    accent: true,
  },
];

const FORK_CARD_LINKS: ReadonlyArray<ExtensibleCardLink> = [
  {
    href: "https://github.com/getpaseo/paseo",
    label: "View the repository",
    icon: GitHubIcon,
    external: true,
  },
];

function ExtensibleCard({
  icon: Icon,
  title,
  description,
  links,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  links: ReadonlyArray<ExtensibleCardLink>;
}) {
  return (
    <div className="flex min-h-64 flex-col rounded-xl border border-white/10 bg-white/[0.025] p-6">
      <div className="mb-8 text-muted-foreground">
        <Icon className="h-6 w-6" strokeWidth={1.5} />
      </div>
      <h3 className="text-lg font-medium text-white/85">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-white/45">{description}</p>
      <div className="mt-auto flex flex-col items-start gap-3 pt-6">
        {links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            className={
              link.accent
                ? "inline-flex items-center gap-2 text-sm text-emerald-300/85 transition-colors hover:text-emerald-200"
                : "inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            }
          >
            <link.icon className="h-4 w-4" />
            {link.label}
            {link.external ? <ExternalLink className="h-3.5 w-3.5 opacity-70" /> : null}
          </a>
        ))}
      </div>
    </div>
  );
}

function GetStarted() {
  const platform = useVisitorPlatform();
  return (
    <div className="pt-10">
      {/* The primary call to action owns its own row on phones so the small icon
          buttons never wrap and orphan one of themselves onto a line alone. It
          still hugs its label rather than stretching across the row. */}
      <div className="mx-auto flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
        {isMobilePlatform(platform) ? (
          <StoreButton platform={platform} />
        ) : (
          <DesktopDownloadButton platform={platform} />
        )}
        <div className="flex items-center justify-center gap-3">
          {isMobilePlatform(platform) ? <DesktopAppLink /> : <StoreIconLinks />}
          <ServerInstallButton />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pt-6">
        <span className="text-xs text-muted-foreground">Supports</span>
        <div className="flex items-center gap-1">
          <AgentBadge name="Claude Code" icon={CLAUDE_CODE_BADGE_ICON} />
          <AgentBadge name="Codex" icon={CODEX_BADGE_ICON} />
          <AgentBadge name="OpenCode" icon={OPENCODE_BADGE_ICON} />
          <AgentBadge name="Pi" icon={PI_BADGE_ICON} />
          <AgentBadge name="Cursor" icon={CURSOR_BADGE_ICON} />
        </div>
        <a
          href="/agents"
          className="whitespace-nowrap text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          +{ADDITIONAL_AGENT_COUNT} more
        </a>
      </div>
    </div>
  );
}

const PRIMARY_CTA_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:bg-foreground/90 transition-colors";
const SECONDARY_CTA_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-white/12 px-3 py-2.5 text-sm text-white hover:bg-white/10 transition-colors";

function DesktopDownloadButton({ platform }: { platform: DesktopPlatform }) {
  const download = getDesktopDownload(useRelease(), platform);
  const Icon = download.icon;
  return (
    <a href={download.href} target="_blank" rel="noopener noreferrer" className={PRIMARY_CTA_CLASS}>
      <Icon className="h-4 w-4" />
      Download for {download.label}
    </a>
  );
}

function StoreButton({ platform }: { platform: MobilePlatform }) {
  const store = MOBILE_STORES[platform];
  const Icon = store.icon;
  return (
    <a href={store.href} target="_blank" rel="noopener noreferrer" className={PRIMARY_CTA_CLASS}>
      <Icon className="h-4 w-4" />
      Get the {store.label} app
    </a>
  );
}

// On a phone the desktop build is the secondary path, so it points at /download
// instead of handing the visitor a .dmg they cannot open.
function DesktopAppLink() {
  return (
    <a href="/download" className={SECONDARY_CTA_CLASS}>
      <Monitor className="h-4 w-4" strokeWidth={1.5} />
      Desktop app
    </a>
  );
}

function StoreIconLinks() {
  return (
    <>
      <a
        href={appStoreUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={SECONDARY_CTA_CLASS}
        aria-label="App Store"
      >
        <AppleIcon className="h-5 w-5" />
      </a>
      <a
        href={playStoreUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={SECONDARY_CTA_CLASS}
        aria-label="Google Play"
      >
        <PlayStoreIcon className="h-5 w-5" />
      </a>
    </>
  );
}

const SERVER_INSTALL_TRIGGER = (
  <span
    className="inline-flex items-center justify-center rounded-lg border border-white/12 px-3 py-2.5 text-white hover:bg-white/10 transition-colors"
    aria-label="Install the daemon on a remote machine"
  >
    <TerminalIcon className="h-5 w-5" />
  </span>
);

const SERVER_INSTALL_FOOTNOTE = (
  <>
    Requires Node.js 18+. Run <span className="font-mono text-white/40">paseo</span> to start the
    daemon.
  </>
);

function ServerInstallButton() {
  return (
    <CommandDialog
      trigger={SERVER_INSTALL_TRIGGER}
      title="Run agents on a remote machine"
      description="For headless machines you want to connect to from the Paseo apps. The desktop app already includes a built-in daemon"
      command="npm install -g @getpaseo/cli && paseo"
      footnote={SERVER_INSTALL_FOOTNOTE}
    />
  );
}

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

  const leftPhoneStyle = React.useMemo(
    () => ({ opacity: sideOpacity, x: leftX, rotateY: -15, scale: 0.97 }),
    [sideOpacity, leftX],
  );
  const rightPhoneStyle = React.useMemo(
    () => ({ opacity: sideOpacity, x: rightX, rotateY: 15, scale: 0.97 }),
    [sideOpacity, rightX],
  );
  const centerPhoneAnimate = React.useMemo(() => (textInView ? FADE_IN : {}), [textInView]);
  const textAnimate = React.useMemo(() => (textInView ? FADE_IN : {}), [textInView]);

  return (
    <div ref={containerRef} className="flex flex-col items-center pt-4 pb-16 gap-20">
      {/* Arrow + text */}
      <motion.div
        initial={FADE_IN_UP_TINY}
        animate={textAnimate}
        transition={DURATION_05}
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
        <p className="max-w-md text-balance text-center text-lg text-white/80">
          When you want to step away from your desk, you can.
        </p>
        <p className="max-w-sm text-balance text-center text-sm text-white/50">
          The native mobile app has full feature parity with desktop.
        </p>
      </motion.div>

      {/* Phone trio — side phones are absolute, start behind center, slide outward with perspective rotation */}
      <div
        className="relative flex items-center justify-center overflow-x-clip w-full"
        style={PHONE_PERSPECTIVE_STYLE}
      >
        {/* Left phone — workspace drawer, rotated to face inward */}
        <motion.div
          style={leftPhoneStyle}
          className="w-[160px] md:w-[240px] absolute"
          role="img"
          aria-label="Paseo workspace drawer"
        >
          <PhoneFrame time="18:54" depth="right">
            <MobileSidebar />
          </PhoneFrame>
        </motion.div>

        {/* Center phone — agent chat */}
        <motion.div
          initial={FADE_IN_UP_XL}
          animate={centerPhoneAnimate}
          transition={EASE_OUT_06_DELAY_01}
          className="w-[220px] md:w-[240px] relative z-10"
          role="img"
          aria-label="Paseo agent chat"
        >
          <PhoneFrame time="18:53">
            <MobileChat />
          </PhoneFrame>
        </motion.div>

        {/* Right phone — diff view, rotated to face inward */}
        <motion.div
          style={rightPhoneStyle}
          className="w-[160px] md:w-[240px] absolute"
          role="img"
          aria-label="Paseo diff view"
        >
          <PhoneFrame time="18:55" depth="left">
            <MobileDiff />
          </PhoneFrame>
        </motion.div>
      </div>
    </div>
  );
}

function FAQ() {
  return (
    <motion.div
      initial={FADE_IN_UP}
      whileInView={FADE_IN}
      viewport={VIEWPORT_60}
      transition={EASE_OUT_05}
      className="space-y-6"
    >
      <h2 className="text-3xl font-medium">FAQ</h2>
      <div className="space-y-6">
        <FAQItem question="Is this free?">
          Yes. Paseo is free and open source. You need agent providers installed with your own
          credentials. Voice is local-first by default and can optionally use cloud speech providers
          if you configure them.
        </FAQItem>
        <FAQItem question="Does my code leave my machine?">
          Paseo doesn&apos;t send your code anywhere. Agents run locally and talk to their own APIs
          as they normally would. For remote access, you can use the optional{" "}
          <a href="/docs/security" className="underline hover:text-white/80">
            end-to-end encrypted relay
          </a>
          , connect directly over your local network, or use your own tunnel.
        </FAQItem>
        <FAQItem question="What agents does it support?">
          Paseo supports many providers. It has custom implementations for Claude, Codex, OpenCode,
          Pi, and OMP, and supports many more via ACP. See the full list here:{" "}
          <a href="/agents" className="underline hover:text-white/80">
            all supported providers
          </a>
          .
        </FAQItem>
        <FAQItem question="How does Paseo run providers?">
          Paseo runs the providers installed on your machine as you&apos;d normally run them. Paseo
          doesn&apos;t modify or change their behavior.
        </FAQItem>
        <FAQItem question="Do I need the desktop app?">
          No. You can run the daemon headless and use any client to connect. The desktop app just
          bundles the daemon with a UI.
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
          Yes. You can use the hosted relay (end-to-end encrypted, Paseo can&apos;t read your
          traffic), set up your own tunnel (Tailscale, Cloudflare Tunnel, etc.), or expose the
          daemon port directly. See{" "}
          <a href="/docs/configuration" className="underline hover:text-white/80">
            configuration
          </a>
          .
        </FAQItem>
        <FAQItem question="Do I need git or GitHub?">
          No. Paseo works in any directory. Worktrees are optional and only relevant if you use git.
          You can run agents anywhere you&apos;d normally work.
        </FAQItem>
        <FAQItem question="Can I get banned for using Paseo?">
          Paseo is designed to use each provider&apos;s officially supported integration and does
          not attempt to bypass its terms of service. It doesn&apos;t extract tokens or call
          inference APIs directly.
        </FAQItem>
        <FAQItem question="How do worktrees work?">
          When you launch an agent with the worktree option (from the app, desktop, or CLI), Paseo
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

function SponsorCTA() {
  return (
    <motion.div
      initial={FADE_IN_UP}
      whileInView={FADE_IN}
      viewport={VIEWPORT_60}
      transition={EASE_OUT_05}
      className="rounded-xl bg-white/5 border border-white/10 p-8 md:p-10 text-left space-y-4 max-w-xl mx-auto"
    >
      <div className="text-sm text-muted-foreground leading-relaxed space-y-3">
        <p>Paseo is an independent open source project for running coding agents.</p>
        <p>Its guiding principle is optionality and freedom of choice.</p>
        <p>
          I wanted to use any provider without being locked into any ecosystem, run it on my own
          infrastructure, access it from anywhere, and have it be fully automatable.
        </p>
        <p>I am hoping that you will enjoy Paseo as much as I do.</p>
        <p>If you like Paseo, sponsorship is the best way to support continued development.</p>
        <p>- Mo</p>
      </div>
      <div className="pt-2">
        <a
          href="/sponsor"
          className="inline-flex items-center gap-2 rounded-lg bg-white/10 border border-white/20 px-5 py-2.5 text-sm font-medium text-white hover:bg-white/15 transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="text-pink-400"
          >
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
          Sponsor Paseo
        </a>
      </div>
    </motion.div>
  );
}
