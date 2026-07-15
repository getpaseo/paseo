import * as React from "react";
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

const SVG_OVERFLOW_VISIBLE_STYLE = { overflow: "visible" as const };
const PHONE_PERSPECTIVE_STYLE = { minHeight: 480, perspective: 1200 };
import { CursorFieldProvider } from "~/components/butterfly";
import { CommandDialog } from "~/components/command-dialog";
import { AGENT_PAGES } from "~/data/agent-pages";
import {
  appStoreUrl,
  playStoreUrl,
  webAppUrl,
  getDownloadOptions,
  useDetectedPlatform,
  AppleIcon,
  PlayStoreIcon,
  TerminalIcon,
  GlobeIcon,
} from "~/downloads";
import { useRelease } from "~/routes/__root";
import { Mic } from "lucide-react";
import { HeroMockup } from "~/components/hero-mockup";
import { ClaudeIcon } from "~/components/mockup";
import { FAQItem } from "~/components/faq-item";
import { SiteFooter } from "~/components/site-footer";
import { SiteHeader } from "~/components/site-header";
import "~/styles.css";

interface LandingPageProps {
  title: React.ReactNode;
  subtitle: string;
}

export function LandingPage({ title, subtitle }: LandingPageProps) {
  return (
    <CursorFieldProvider>
      {/* Hero section with background image */}
      <div className="relative bg-cover bg-center bg-no-repeat">
        <div className="relative p-6 pb-10 md:px-32 md:pt-20 md:pb-12 max-w-7xl mx-auto">
          <Nav />
          <Hero title={title} subtitle={subtitle} />
          <GetStarted />
        </div>

        {/* Mockup - inside hero so it's above the gradient, positioned to overflow into black section */}
        <motion.div
          initial={FADE_IN_UP_40}
          animate={FADE_IN}
          transition={EASE_OUT_08_DELAY_05}
          className="relative px-6 md:px-8 pb-8 md:pb-16"
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
            <SelfHostedSection />
            <WorkflowSection />
            <SplitPanelsSection />
            <ServiceProxySection />
            <ShortcutsSection />
            <LocalVoiceSection />
            <CLISection />
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
    <nav className="mb-16">
      <SiteHeader />
    </nav>
  );
}

function Hero({ title, subtitle }: { title: React.ReactNode; subtitle: string }) {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl md:text-5xl font-medium tracking-tight">{title}</h1>
      <p className="text-white/70 text-lg leading-relaxed max-w-lg">{subtitle}</p>
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
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <motion.section
      initial={FADE_IN_UP}
      whileInView={FADE_IN}
      viewport={VIEWPORT_60}
      transition={EASE_OUT_05}
    >
      <SectionTitle title={title} description={description} />
      {children}
    </motion.section>
  );
}

function SectionTitle({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-12 space-y-2">
      <h2 className="text-3xl font-medium">{title}</h2>
      <p className="text-base text-muted-foreground max-w-lg">{description}</p>
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
        description="See what developers are saying about Paseo."
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

function MultiProviderSection() {
  const providers = [
    { name: "Claude Code", icon: <ClaudeIcon size={28} /> },
    { name: "Codex", icon: <CodexIcon className="w-7 h-7" /> },
    { name: "OpenCode", icon: <OpenCodeIcon className="w-7 h-7" /> },
    { name: "Pi", icon: <PiIcon className="w-7 h-7" /> },
    { name: "Cursor", icon: <CursorIcon className="w-7 h-7" /> },
  ];

  return (
    <FeatureSection
      title="Works with your tools"
      description="Run your agents from one interface. Paseo uses each provider's native harness, so your subscriptions, skills, config, and MCP servers keep working."
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {providers.map((p) => (
          <div
            key={p.name}
            className="flex items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4"
          >
            <span className="text-white/80">{p.icon}</span>
            <span className="font-medium">{p.name}</span>
          </div>
        ))}
        <a
          href="/agents"
          className="flex items-center justify-center gap-3 rounded-xl border border-dashed border-white/10 bg-white/[0.01] px-5 py-4 text-white/50 hover:text-white/80 hover:border-white/20 hover:bg-white/[0.03] transition-colors"
        >
          <span className="font-medium">+{ADDITIONAL_AGENT_COUNT} more</span>
        </a>
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

  const setClientRef = React.useCallback(
    (index: number) => (el: HTMLDivElement | null) => {
      clientRefs.current[index] = el;
    },
    [],
  );
  const setHostRef = React.useCallback(
    (index: number) => (el: HTMLDivElement | null) => {
      hostRefs.current[index] = el;
    },
    [],
  );
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
              className="flex items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4"
            >
              <span className="text-white/80">{c.icon}</span>
              <span className="font-medium">{c.name}</span>
            </div>
          ))}
        </div>
        <div className="w-px h-6 border-l border-dashed border-white/25" />
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-6 py-5 text-center space-y-1">
          <p className="text-xs font-medium text-white/50">E2E Encrypted Relay</p>
          <p className="text-[10px] text-white/25">or</p>
          <p className="text-xs font-medium text-white/50">Direct Connection</p>
        </div>
        <div className="w-px h-6 border-l border-dashed border-white/25" />
        <div className="space-y-2 w-full">
          {hosts.map((h) => (
            <div
              key={h}
              className="flex items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4"
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
          style={SVG_OVERFLOW_VISIBLE_STYLE}
        >
          {[...paths.left, ...paths.right].map(
            (d) =>
              d && (
                <path
                  key={d}
                  d={d}
                  fill="none"
                  stroke="rgba(255,255,255,0.25)"
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
              ref={setClientRef(i)}
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
          className="flex-shrink-0 rounded-xl border border-white/10 bg-white/[0.03] px-8 py-6 text-center space-y-1.5 relative z-10 backdrop-blur-sm"
        >
          <p className="text-sm font-medium text-white/50">E2E Encrypted Relay</p>
          <p className="text-xs text-white/25">or</p>
          <p className="text-sm font-medium text-white/50">Direct Connection</p>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Hosts */}
        <div className="space-y-3 flex-shrink-0 relative z-10">
          {hosts.map((h, i) => (
            <div
              key={h}
              ref={setHostRef(i)}
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
      title="Runs where you work"
      description="Start agents on your laptop, a VM, or a dev server. Use them from any device over a direct connection or the end-to-end encrypted relay."
    >
      <SelfHostedDiagram />
    </FeatureSection>
  );
}

const WORKFLOW_STEPS = ["Worktree", "Preview", "Review", "Commit", "PR", "Merge"] as const;

const REVIEW_FILES = [
  { path: "src/auth/session.ts", delta: "+42" },
  { path: "src/auth/middleware.ts", delta: "+18 -9" },
  { path: "tests/auth.test.ts", delta: "+31" },
] as const;

function WorkflowSection() {
  return (
    <FeatureSection
      title="Review, preview, ship"
      description="Create branches, preview the app in the browser, review the diff inline, then commit, open a PR, and merge without leaving Paseo."
    >
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <WorkflowHeader />
        <div className="grid gap-4 p-4 md:grid-cols-[1.1fr_0.9fr]">
          <WorkflowPreview />
          <WorkflowReviewAndShip />
        </div>
      </div>
    </FeatureSection>
  );
}

function WorkflowHeader() {
  return (
    <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2.5">
        <div className="h-2 w-2 rounded-full bg-emerald-400" />
        <span className="text-sm text-white/80">fix-auth</span>
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/40">worktree</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-white/40">
        {WORKFLOW_STEPS.map((step) => (
          <span key={step} className="rounded-full border border-white/10 px-2 py-1">
            {step}
          </span>
        ))}
      </div>
    </div>
  );
}

function WorkflowPreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-black/20">
      <BrowserChrome />
      <div className="space-y-5 p-5">
        <PreviewHeader />
        <div className="grid gap-3 sm:grid-cols-2">
          <PreviewFormCard titleWidth="w-16" ctaClassName="bg-white/[0.06]" />
          <PreviewFormCard titleWidth="w-20" ctaClassName="bg-emerald-400/20" />
        </div>
      </div>
    </div>
  );
}

function BrowserChrome() {
  return (
    <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="flex gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-300/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/60" />
      </div>
      <div className="min-w-0 flex-1 rounded-md bg-black/30 px-2 py-1 text-center font-mono text-[10px] text-white/35">
        web.fix-auth.my-app.localhost
      </div>
    </div>
  );
}

function PreviewHeader() {
  return (
    <div className="space-y-2">
      <div className="h-3 w-28 rounded-full bg-white/25" />
      <div className="h-2 w-44 rounded-full bg-white/10" />
    </div>
  );
}

function PreviewFormCard({
  titleWidth,
  ctaClassName,
}: {
  titleWidth: string;
  ctaClassName: string;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div className={`h-2 rounded-full bg-white/15 ${titleWidth}`} />
      <div className="h-8 rounded-md bg-white/10" />
      <div className={`h-8 rounded-md ${ctaClassName}`} />
    </div>
  );
}

function WorkflowReviewAndShip() {
  return (
    <div className="space-y-4">
      <InlineReviewPanel />
      <ShipPanel />
    </div>
  );
}

function InlineReviewPanel() {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-sm text-white/80">Inline review</span>
        <span className="text-xs text-white/35">3 files changed</span>
      </div>
      <div className="space-y-2">
        {REVIEW_FILES.map((file) => (
          <ReviewFileRow key={file.path} path={file.path} delta={file.delta} />
        ))}
      </div>
    </div>
  );
}

function ReviewFileRow({ path, delta }: { path: string; delta: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="truncate font-mono text-white/50">{path}</span>
      <span className="flex gap-1 font-mono">
        {delta.split(" ").map((part) => (
          <span
            key={part}
            className={part.startsWith("-") ? "text-red-300/70" : "text-emerald-300/70"}
          >
            {part}
          </span>
        ))}
      </span>
    </div>
  );
}

function ShipPanel() {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-sm text-white/80">Ready to ship</span>
        <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-xs text-emerald-300">
          checks passed
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-white/70">
          Commit
        </div>
        <div className="rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-white/70">
          Open PR
        </div>
        <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/15 px-3 py-2 text-emerald-200">
          Merge
        </div>
      </div>
    </div>
  );
}

function SplitPanelsSection() {
  return (
    <FeatureSection
      title="Split panels"
      description="Open agents, browsers, terminals, diffs, and logs in the same workspace. Split them side by side or group them in tabs."
    >
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3">
        <div className="grid gap-3 md:h-[360px] md:grid-cols-[1.05fr_0.95fr]">
          <PanelTile label="Agent" className="min-h-48 md:min-h-0" />
          <div className="grid gap-3 md:grid-rows-[1fr_0.75fr]">
            <PanelTile label="Browser" className="min-h-36" />
            <div className="grid gap-3 sm:grid-cols-2">
              <PanelTile label="Terminal" className="min-h-28" />
              <PanelTile label="Diff" className="min-h-28" />
            </div>
          </div>
        </div>
      </div>
    </FeatureSection>
  );
}

function PanelTile({ label, className }: { label: string; className: string }) {
  return (
    <div
      className={`flex items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-sm text-white/70 ${className}`}
    >
      {label}
    </div>
  );
}

function ServiceProxySection() {
  const workspaces = [
    { name: "fix-auth", url: "web.fix-auth.my-app.localhost" },
    { name: "add-search", url: "web.add-search.my-app.localhost" },
    { name: "upgrade-deps", url: "web.upgrade-deps.my-app.localhost" },
  ];

  return (
    <FeatureSection
      title="Forget about ports"
      description="When agents work in parallel, they all run dev servers. Paseo gives each one a URL based on the branch name, no port conflicts, no guessing."
    >
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
        <div className="px-5 py-4 space-y-3">
          {/* Project */}
          <div className="flex items-center gap-2.5">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-white/40"
            >
              <path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H13L11 5H5C3.89543 5 3 5.89543 3 7Z" />
            </svg>
            <span className="text-sm font-medium text-white/60">my-app</span>
          </div>

          {/* Workspaces indented */}
          <div className="pl-6 space-y-2">
            {workspaces.map((ws) => (
              <div key={ws.name} className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  <span className="text-sm text-white/80">{ws.name}</span>
                  <span className="text-xs text-white/25 font-mono">npm run dev</span>
                </div>
                <span className="text-xs font-mono text-white/30">{ws.url}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
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
                  className="text-xs px-1.5 py-0.5 rounded bg-white/10 text-white/50 font-mono"
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

interface VoiceBarProps {
  index: number;
  barCount: number;
}

function VoiceBar({ index, barCount }: VoiceBarProps) {
  const style = React.useMemo(() => {
    const center = barCount / 2;
    const dist = Math.abs(index - center) / center;
    const envelope = 1 - dist * dist;
    const minH = 4;
    const maxH = 56;
    const baseH = minH + (maxH - minH) * envelope;
    const jitter = Math.sin(index * 2.3) * 0.3 + Math.cos(index * 1.7) * 0.2;
    const h = Math.max(minH, baseH * (0.5 + 0.5 * Math.abs(jitter + Math.sin(index * 0.8))));
    return {
      height: h,
      animationName: "voice-bar",
      animationDuration: `${800 + (index % 5) * 200}ms`,
      animationTimingFunction: "ease-in-out",
      animationIterationCount: "infinite",
      animationDirection: "alternate" as const,
      animationDelay: `${(index % 7) * 80}ms`,
    };
  }, [index, barCount]);
  return <div className="w-[3px] rounded-full bg-white/30" style={style} />;
}

const VOICE_BAR_COUNT = 48;
const VOICE_BAR_INDICES = Array.from({ length: VOICE_BAR_COUNT }, (_, i) => i);

function VoiceWaveform() {
  return (
    <div className="flex items-center justify-center gap-[3px] h-16">
      {VOICE_BAR_INDICES.map((i) => (
        <VoiceBar key={`voice-bar-${i}`} index={i} barCount={VOICE_BAR_COUNT} />
      ))}
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

function makeWordKey(words: string[], i: number): string {
  const word = words[i];
  let occurrence = 0;
  for (let j = 0; j < i; j++) {
    if (words[j] === word) occurrence++;
  }
  return `${word}#${occurrence}`;
}

function WordSpan({ word, confirmed }: { word: string; confirmed: boolean }) {
  return (
    <span
      className={`transition-colors duration-300 ${confirmed ? "text-white/90" : "text-white/40"}`}
    >
      {word}{" "}
    </span>
  );
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
          return <WordSpan key={makeWordKey(words, i)} word={word} confirmed={confirmed} />;
        })}
      </p>
    </div>
  );
}

function LocalVoiceSection() {
  const { dictationWordIndex, responseWordIndex, showResponse } = useVoiceConversation();

  return (
    <FeatureSection
      title="Voice control, fully local"
      description="Fully local voice stack. Speech-to-text and text-to-speech run entirely on your machine, nothing leaves your network."
    >
      <div className="relative w-full rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
        <div className="px-6 pt-8 pb-6 space-y-3">
          {/* Waveform area */}
          <div className="relative">
            <VoiceWaveform />
          </div>

          {/* User dictation */}
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
              <Mic size={16} className="text-white/60" />
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
    <div className="pt-10">
      <div className="flex flex-row flex-wrap gap-3">
        <DownloadButton />
        <a
          href={webAppUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 transition-colors"
        >
          <GlobeIcon className="h-4 w-4" />
          Web App
        </a>
        <a
          href={appStoreUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center rounded-lg border border-white/20 px-3 py-2 text-white hover:bg-white/10 transition-colors"
          aria-label="App Store"
        >
          <AppleIcon className="h-5 w-5" />
        </a>
        <a
          href={playStoreUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center rounded-lg border border-white/20 px-3 py-2 text-white hover:bg-white/10 transition-colors"
          aria-label="Google Play"
        >
          <PlayStoreIcon className="h-5 w-5" />
        </a>
        <ServerInstallButton />
      </div>
      <div className="pt-3">
        <a
          href="/download"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          All download options
        </a>
      </div>
      <div className="flex items-center gap-2 pt-6">
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
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          +{ADDITIONAL_AGENT_COUNT} more
        </a>
      </div>
    </div>
  );
}

function DownloadButton() {
  const release = useRelease();
  const detectedPlatform = useDetectedPlatform();
  const primary = getDownloadOptions(release).find((o) => o.platform === detectedPlatform)!;
  const PrimaryIcon = primary.icon;

  return (
    <a
      href={primary.href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-foreground/90 transition-colors"
    >
      <PrimaryIcon className="h-4 w-4" />
      Download for {primary.label}
    </a>
  );
}

const SERVER_INSTALL_TRIGGER = (
  <span className="inline-flex items-center justify-center rounded-lg border border-white/20 px-3 py-2 text-white hover:bg-white/10 transition-colors">
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
      description="For headless machines you want to connect to from the Paseo apps. The desktop app already includes a built-in daemon."
      command="npm install -g @getpaseo/cli && paseo"
      footnote={SERVER_INSTALL_FOOTNOTE}
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

function CursorIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 466.73 532.09"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
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
const bashCommands = new Set(["paseo", "echo", "jq"]);

function tokenizeBashComment(code: string, i: number): { node: React.ReactNode; len: number } {
  const end = code.indexOf("\n", i);
  const comment = end === -1 ? code.slice(i) : code.slice(i, end);
  return {
    node: <span className="text-white/30 italic">{comment}</span>,
    len: comment.length,
  };
}

function tokenizeBashDoubleQuoted(code: string, i: number): { node: React.ReactNode; len: number } {
  let j = i + 1;
  while (j < code.length && code[j] !== '"') {
    if (code[j] === "\\") j++;
    j++;
  }
  const str = code.slice(i, j + 1);
  return { node: <span className="text-green-400/80">{str}</span>, len: str.length };
}

function tokenizeBashSingleQuoted(code: string, i: number): { node: React.ReactNode; len: number } {
  let j = i + 1;
  while (j < code.length && code[j] !== "'") j++;
  const str = code.slice(i, j + 1);
  return { node: <span className="text-green-400/80">{str}</span>, len: str.length };
}

function tokenizeBashDollar(code: string, i: number): { node: React.ReactNode; len: number } {
  if (code[i + 1] === "(") {
    return { node: <span className="text-amber-300/70">$(</span>, len: 2 };
  }
  let j = i + 1;
  while (j < code.length && /\w/.test(code[j])) j++;
  return {
    node: <span className="text-amber-300/70">{code.slice(i, j)}</span>,
    len: j - i,
  };
}

function tokenizeBashFlag(code: string, i: number): { node: React.ReactNode; len: number } {
  let j = i;
  if (code[j + 1] === "-") j++;
  j++;
  while (j < code.length && /[\w-]/.test(code[j])) j++;
  return {
    node: <span className="text-sky-300/70">{code.slice(i, j)}</span>,
    len: j - i,
  };
}

function tokenizeBashWord(code: string, i: number): { node: React.ReactNode; len: number } {
  let j = i;
  while (j < code.length && /\w/.test(code[j])) j++;
  const word = code.slice(i, j);
  const len = j - i;
  if (bashKeywords.has(word)) {
    return { node: <span className="text-purple-400">{word}</span>, len };
  }
  if (bashCommands.has(word)) {
    return { node: <span className="text-white">{word}</span>, len };
  }
  return { node: word, len };
}

function isBashFlagStart(code: string, i: number): boolean {
  return (
    code[i] === "-" &&
    (i === 0 || /\s/.test(code[i - 1])) &&
    i + 1 < code.length &&
    /[\w-]/.test(code[i + 1])
  );
}

function isBashCommentStart(code: string, i: number): boolean {
  return code[i] === "#" && (i === 0 || /[\s(]/.test(code[i - 1]));
}

function tokenizeBashChar(code: string, i: number): { node: React.ReactNode; len: number } {
  const c = code[i];
  if (c === "|" || (c === "&" && code[i + 1] === "&")) {
    const op = c === "|" ? "|" : "&&";
    return { node: <span className="text-white/40">{op}</span>, len: op.length };
  }
  if (c === "\\") return { node: <span className="text-white/40">\</span>, len: 1 };
  if (c === ")") return { node: <span className="text-amber-300/70">)</span>, len: 1 };
  return { node: c, len: 1 };
}

function nextBashToken(code: string, i: number): { node: React.ReactNode; len: number } {
  if (isBashCommentStart(code, i)) return tokenizeBashComment(code, i);
  if (code[i] === '"') return tokenizeBashDoubleQuoted(code, i);
  if (code[i] === "'") return tokenizeBashSingleQuoted(code, i);
  if (code[i] === "$") return tokenizeBashDollar(code, i);
  if (isBashFlagStart(code, i)) return tokenizeBashFlag(code, i);
  if (/[a-zA-Z_]/.test(code[i])) return tokenizeBashWord(code, i);
  return tokenizeBashChar(code, i);
}

function highlightBash(code: string): React.ReactNode {
  const tokens: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < code.length) {
    const { node, len } = nextBashToken(code, i);
    if (React.isValidElement(node)) {
      tokens.push(React.cloneElement(node, { key: key++ }));
    } else {
      tokens.push(node);
    }
    i += len;
  }

  return tokens;
}

function CLICodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(() => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [children]);

  return (
    <div className="relative bg-white/5 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-3 right-3 text-white/30 hover:text-white/70 transition-colors p-1"
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
      <pre className="p-4 pr-10 text-xs leading-relaxed overflow-x-auto text-white/70 font-mono whitespace-pre">
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
    code: `paseo run "implement user authentication"
paseo run --provider codex --worktree feature-x "implement feature X"
paseo run --host devbox:6767 "run the full test suite"

paseo ls                           # list running agents
paseo attach abc123                # stream live output
paseo send abc123 "also add tests" # follow-up task`,
  },
  {
    title: "Loops",
    description:
      "Have one agent do the work, another verify the result, and loop until it passes. Built-in, no shell scripting needed.",
    code: `# Worker-verifier loop: fix tests until they pass
paseo loop run "make all tests pass" \\
  --verify "verify tests pass and the code is production-ready" \\
  --verify-check "npm test" \\
  --max-iterations 5

paseo loop ls                        # list running loops
paseo loop logs abc123               # stream loop output`,
  },
  {
    title: "Schedules",
    description:
      "Run agents on a cron schedule. Automate recurring tasks like dependency updates, security audits, or report generation.",
    code: `# Run a security audit every Monday at 9am
paseo schedule create --cron "0 9 * * 1" \\
  "audit the codebase for security issues and open PRs for fixes"

paseo schedule ls                    # list all schedules
paseo schedule pause abc123          # pause a schedule
paseo schedule delete abc123         # remove a schedule`,
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
        style={PHONE_PERSPECTIVE_STYLE}
      >
        {/* Left phone — rotated to face inward */}
        <motion.div style={leftPhoneStyle} className="w-[160px] md:w-[240px] absolute">
          <img
            src="/phone-1-480.webp"
            srcSet="/phone-1-320.webp 320w, /phone-1-480.webp 480w"
            sizes="(min-width: 768px) 240px, 160px"
            alt="Paseo sessions list"
            width={480}
            height={1044}
            loading="lazy"
            decoding="async"
            className="w-full rounded-[40px] shadow-2xl border-[3px] border-black outline-[3px] outline-white/20"
          />
        </motion.div>

        {/* Center phone */}
        <motion.div
          initial={FADE_IN_UP_XL}
          animate={centerPhoneAnimate}
          transition={EASE_OUT_06_DELAY_01}
          className="w-[220px] md:w-[240px] relative z-10"
        >
          <img
            src="/phone-2-480.webp"
            srcSet="/phone-2-320.webp 320w, /phone-2-480.webp 480w"
            sizes="(min-width: 768px) 240px, 220px"
            alt="Paseo agent chat"
            width={480}
            height={1044}
            loading="lazy"
            decoding="async"
            className="w-full rounded-[40px] shadow-2xl border-[3px] border-black outline-[3px] outline-white/20"
          />
        </motion.div>

        {/* Right phone — rotated to face inward */}
        <motion.div style={rightPhoneStyle} className="w-[160px] md:w-[240px] absolute">
          <img
            src="/phone-3-480.webp"
            srcSet="/phone-3-320.webp 320w, /phone-3-480.webp 480w"
            sizes="(min-width: 768px) 240px, 160px"
            alt="Paseo diff view"
            width={480}
            height={1044}
            loading="lazy"
            decoding="async"
            className="w-full rounded-[40px] shadow-2xl border-[3px] border-black outline-[3px] outline-white/20"
          />
        </motion.div>
      </div>
    </div>
  );
}

function CLITabButton({
  title,
  index,
  active,
  onSelect,
}: {
  title: string;
  index: number;
  active: boolean;
  onSelect: (i: number) => void;
}) {
  const handleClick = React.useCallback(() => onSelect(index), [onSelect, index]);
  return (
    <button
      type="button"
      onClick={handleClick}
      className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
        active
          ? "border-white/40 text-white bg-white/10"
          : "border-white/15 text-white/50 hover:text-white/80 hover:border-white/30"
      }`}
    >
      {title}
    </button>
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
      <div className="mb-3 flex flex-wrap gap-2">
        {cliExamples.map((example, i) => (
          <CLITabButton
            key={example.title}
            title={example.title}
            index={i}
            active={i === activeIndex}
            onSelect={setActiveIndex}
          />
        ))}
      </div>

      <div className="mb-3">
        <CLICodeBlock>{active.code}</CLICodeBlock>
      </div>

      <a
        href="/docs/cli"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
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
      initial={FADE_IN_UP}
      whileInView={FADE_IN}
      viewport={VIEWPORT_60}
      transition={EASE_OUT_05}
      className="space-y-6"
    >
      <h2 className="text-3xl font-medium">FAQ</h2>
      <div className="space-y-6">
        <FAQItem question="Is this free?">
          Yes. Paseo is free and open source. You need Claude Code, Codex, Cursor, OpenCode, or Pi
          installed with your own credentials. Voice is local-first by default and can optionally
          use OpenAI speech providers if you configure them.
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
          Claude Code, Codex, Cursor, OpenCode, and Pi. Each agent runs as its own process using its
          own CLI or local integration. Paseo doesn&apos;t modify or wrap their behavior.
        </FAQItem>
        <FAQItem question="Do I need the desktop app?">
          No. You can run the daemon headless with{" "}
          <code className="font-mono text-muted-foreground">
            npm install -g @getpaseo/cli && paseo
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
          <p>We can&apos;t make promises on behalf of providers.</p>
          <p>
            That said, Paseo launches each provider&apos;s local CLI or integration (Claude Code,
            Codex, Cursor, OpenCode, Pi) as a subprocess. It doesn&apos;t extract tokens or call
            inference APIs directly. From the provider&apos;s perspective, usage through Paseo is
            indistinguishable from running the provider yourself.
          </p>
          <p>I&apos;ve been using Paseo with all providers for months without issue.</p>
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
        <p>
          Paseo is an independent open source project for running coding agents across your own
          machines, phone, desktop, and CLI.
        </p>
        <p>
          It&apos;s built around freedom of choice: use the provider you want, run it on your own
          infrastructure, and keep your workflow portable.
        </p>
        <p>If you like Paseo, sponsorship is the best way to support continued development.</p>
        <p>- Mo</p>
      </div>
      <div className="pt-2">
        <a
          href="https://github.com/sponsors/boudra"
          target="_blank"
          rel="noopener noreferrer"
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
          Sponsor on GitHub
        </a>
      </div>
    </motion.div>
  );
}
