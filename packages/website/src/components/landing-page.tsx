import { PLUGINS_LINKED } from "~/plugins/launch";
import { categoryHref } from "~/plugins/links";
import type { CategorySlug } from "~/plugins/categories";
import * as React from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  ArrowRight,
  Blocks,
  Bot,
  Braces,
  Compass,
  ExternalLink,
  Gem,
  GitFork,
  GitPullRequest,
  Laptop,
  Lock,
  Merge,
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
  useReducedMotion,
  useScroll,
  useTransform,
  type Transition,
  type Variants,
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
import { useLocale, useLocalizePath } from "~/i18n";
import {
  AntigravityIcon,
  ClaudeCodeIcon,
  CodexIcon,
  CursorIcon,
  MuseCodeIcon,
  OmpIcon,
  OpenCodeIcon,
  PiIcon,
} from "~/components/agent-icons";
import { HubLandingFlow } from "~/components/hub-flow";
import {
  ChapterBand,
  ChapterDivider,
  HairlineGrid,
  PageHeaderBand,
  SectionOpener,
} from "~/components/page-frame";
import { PaseoHubLockup, PaseoHubMark, PaseoMark } from "~/components/paseo-brand";
import {
  MobileChat,
  MobileDiff,
  MobileSidebar,
  PhoneFrame,
  type ToolCall,
  ToolCallRow,
} from "~/components/mockup";
import { FAQItem } from "~/components/faq-item";
import { SiteFooter } from "~/components/site-footer";
import { HomepageSponsorsSection } from "~/components/sponsorship";
import "~/styles.css";

interface LandingPageProps {
  title: React.ReactNode;
  subtitle: React.ReactNode;
  pluginCount?: number | null;
  showHubEyebrow?: boolean;
}

export function LandingPage({
  title,
  subtitle,
  pluginCount = null,
  showHubEyebrow = false,
}: LandingPageProps) {
  return (
    <CursorFieldProvider>
      <div className="min-h-screen bg-background">
        <PageHeaderBand />

        <main>
          {/* Opening bookend: centered hero, interactive desktop mockup, and phone trio */}
          <ChapterBand spacing="none" ruled={false} ticks={false} framed={false}>
            <div className="pt-12 pb-8 md:pt-16 md:pb-10">
              <Hero title={title} subtitle={subtitle} showHubEyebrow={showHubEyebrow} />
              <GetStarted />
            </div>

            <motion.div
              initial={FADE_IN_UP_40}
              animate={FADE_IN}
              transition={EASE_OUT_08_DELAY_05}
              className="relative pt-4 pb-6 md:pt-6 md:pb-8"
            >
              <div>
                <HeroMockup />
              </div>
            </motion.div>

            <TrustStrip />

            <PhoneShowcase />
          </ChapterBand>

          {/* Chapter 1: Community proof */}
          <ChapterBand spacing="compact">
            <SocialProofWall />
          </ChapterBand>

          {/* Chapter 2: The product (Providers, Deployment, Extensibility, Automation) */}
          <ChapterBand spacing="none">
            <div className="py-16 md:py-20">
              <MultiProviderSection />
            </div>
            <ChapterDivider />
            <div className="py-16 md:py-20">
              <TurnkeySection />
            </div>
            <ChapterDivider />
            <div className="py-16 md:py-20">
              <ExtensibleSection pluginCount={pluginCount} />
            </div>
            <ChapterDivider />
            <div className="py-16 md:py-20">
              <AutomationSection />
            </div>
          </ChapterBand>

          {/* Chapter 3: Paseo Hub */}
          <ChapterBand spacing="chapter" tint="subtle">
            <HubSection />
          </ChapterBand>

          {/* Chapter 4: Open source philosophy and consolidated sponsorship */}
          <ChapterBand spacing="none">
            <div className="py-16 md:py-20">
              <PhilosophySection />
            </div>
            <ChapterDivider />
            <div className="py-16 md:py-20">
              <HomepageSponsorsSection />
            </div>
          </ChapterBand>

          {/* Chapter 5: FAQ */}
          <ChapterBand spacing="section">
            <FAQ />
          </ChapterBand>

          {/* Closing bookend: centered download CTA */}
          <ChapterBand spacing="chapter" tint="subtle">
            <ClosingCtaSection />
          </ChapterBand>
        </main>

        <SiteFooter width="default" sponsors={false} />
      </div>
    </CursorFieldProvider>
  );
}

function Hero({
  title,
  subtitle,
  showHubEyebrow = false,
}: {
  title: React.ReactNode;
  subtitle: React.ReactNode;
  showHubEyebrow?: boolean;
}) {
  return (
    <div className="space-y-6 text-center">
      {showHubEyebrow ? <HubHeroEyebrow /> : null}
      <h1 className="font-display text-4xl font-semibold tracking-[-0.025em] leading-[1.02] md:text-6xl">
        {title}
      </h1>
      <p className="mx-auto max-w-lg text-base leading-relaxed text-white/70 md:text-lg">
        {subtitle}
      </p>
    </div>
  );
}

function HubHeroEyebrow() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <div className="flex justify-center">
      <a
        href={localize("/hub")}
        className="group inline-flex max-w-full items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-white/75 transition-colors hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
      >
        <PaseoHubMark className="h-3.5 w-3.5 shrink-0 text-white/90" />
        <span className="font-medium text-white/90">{t("landing.hubEyebrow.product")}</span>
        <span aria-hidden="true" className="h-3 w-px shrink-0 bg-white/15" />
        <span className="truncate text-white/65">{t("landing.hubEyebrow.label")}</span>
        <ArrowRight
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-white/45 transition-transform group-hover:translate-x-0.5 group-hover:text-white/80"
        />
      </a>
    </div>
  );
}

const FEATURED_AGENTS = [
  { name: "Claude Code", Icon: ClaudeCodeIcon },
  { name: "Codex", Icon: CodexIcon },
  { name: "OpenCode", Icon: OpenCodeIcon },
  { name: "Pi", Icon: PiIcon },
  { name: "OMP", Icon: OmpIcon },
  { name: "Cursor", Icon: CursorIcon },
  { name: "Muse Code", Icon: MuseCodeIcon },
  { name: "Antigravity", Icon: AntigravityIcon },
] as const;

const ADDITIONAL_AGENT_COUNT = AGENT_PAGES.length - FEATURED_AGENTS.length;

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

function AgentBadge({ name, Icon }: (typeof FEATURED_AGENTS)[number]) {
  const [hovered, setHovered] = React.useState(false);
  const handleMouseEnter = React.useCallback(() => setHovered(true), []);
  const handleMouseLeave = React.useCallback(() => setHovered(false), []);

  return (
    <span
      className="relative inline-flex items-center justify-center rounded-full p-1.5 text-white/60"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Icon className="h-6 w-6" />
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
  eyebrow,
  title,
  description,
  badge,
  links,
  children,
}: {
  eyebrow?: string;
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
      <SectionOpener
        eyebrow={eyebrow}
        title={title}
        description={description}
        badge={badge}
        links={links}
      />
      {children}
    </motion.section>
  );
}

function SocialProofWall() {
  const { t } = useTranslation();
  return (
    <motion.section
      initial={FADE_IN_UP}
      whileInView={FADE_IN}
      viewport={VIEWPORT_60}
      transition={EASE_OUT_05}
    >
      <SectionOpener
        title={t("landing.socialProof.title")}
        description={t("landing.socialProof.description")}
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
  const { t } = useTranslation();
  return (
    <a
      href={tweet.url}
      target="_blank"
      rel="noreferrer"
      tabIndex={inert ? -1 : undefined}
      className="group flex h-[154px] w-[300px] shrink-0 flex-col justify-between overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 transition-colors hover:border-white/20 hover:bg-white/[0.04] md:w-[380px]"
      aria-label={t("landing.socialProof.readPost", { name: tweet.name })}
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
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <FeatureSection
      eyebrow={t("landing.eyebrows.providers")}
      title={t("landing.providers.title")}
      description={t("landing.providers.description")}
    >
      <HairlineGrid columns="2-3">
        {FEATURED_AGENTS.map((agent) => (
          <div
            key={agent.name}
            className="flex items-center gap-3 bg-background px-5 py-4 transition-colors hover:bg-white/[0.025] sm:px-6 sm:py-5"
          >
            <span className="shrink-0 text-white/80">
              <agent.Icon className="h-5 w-5 sm:h-6 sm:w-6" />
            </span>
            <span className="truncate text-sm font-medium text-white/90 sm:text-base">
              {agent.name}
            </span>
          </div>
        ))}
        <a
          href={localize("/agents")}
          className="flex items-center justify-between gap-2 bg-background px-5 py-4 text-white/55 transition-colors hover:bg-white/[0.025] hover:text-accent-text sm:px-6 sm:py-5"
        >
          <span className="text-sm font-medium sm:text-base">
            {t("common.more", { count: ADDITIONAL_AGENT_COUNT })}
          </span>
          <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
        </a>
      </HairlineGrid>
    </FeatureSection>
  );
}

function TurnkeySection() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <FeatureSection
      title={t("landing.runAnywhere.title")}
      description={t("landing.runAnywhere.description")}
    >
      <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.08]">
        <div className="bg-background p-6 md:p-7">
          <ProductLead
            icon={Monitor}
            title={t("landing.runAnywhere.desktopTitle")}
            description={t("landing.runAnywhere.desktopDescription")}
          />
        </div>
        <div className="grid gap-px border-t border-white/[0.08] md:grid-cols-3">
          <TurnkeyExtensionCard
            icon={Smartphone}
            title={t("landing.runAnywhere.mobileTitle")}
            description={t("landing.runAnywhere.mobileDescription")}
            ctaHref={localize("/download")}
            ctaLabel={t("landing.runAnywhere.mobileCta")}
          />
          <TurnkeyExtensionCard
            icon={Laptop}
            title={t("landing.runAnywhere.remoteTitle")}
            description={t("landing.runAnywhere.remoteDescription")}
            ctaHref={localize("/docs#server--cli")}
            ctaLabel={t("landing.runAnywhere.remoteCta")}
          />
          <TurnkeyExtensionCard
            icon={Users}
            title={t("landing.runAnywhere.teamsTitle")}
            description={t("landing.runAnywhere.teamsDescription")}
            ctaHref={localize("/hub")}
            ctaLabel={t("landing.runAnywhere.teamsCta")}
            ctaIcon={PASEO_HUB_CTA_ICON}
          />
        </div>
      </div>
    </FeatureSection>
  );
}

const PASEO_HUB_CTA_ICON = <PaseoHubMark className="h-4 w-4 shrink-0" />;

function TurnkeyExtensionCard({
  icon: Icon,
  title,
  description,
  ctaHref,
  ctaLabel,
  ctaIcon,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  ctaHref: string;
  ctaLabel: string;
  ctaIcon?: React.ReactNode;
}) {
  return (
    <FeatureCell icon={Icon} title={title} description={description}>
      <a
        href={ctaHref}
        className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90"
      >
        {ctaIcon}
        {ctaLabel}
        <ArrowRight className="h-3.5 w-3.5" />
      </a>
    </FeatureCell>
  );
}

/** The lead product of a section: an icon tile and title. */
function ProductLead({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-4">
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.04] p-3 text-accent-text">
          <Icon className="h-5 w-5" strokeWidth={1.5} />
        </div>
        <div className="space-y-0.5">
          <h3 className="text-lg font-medium text-white/95">{title}</h3>
          {description ? (
            <p className="text-sm leading-relaxed text-white/55">{description}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-3">{actions}</div> : null}
    </div>
  );
}

/** A hairline grid cell: icon and title on one line, the blurb below, an optional action last. */
function FeatureCell({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col bg-background p-6">
      <div className="flex items-center gap-2.5">
        <Icon className="h-4 w-4 shrink-0 text-accent-text" strokeWidth={1.5} />
        <h3 className="text-sm font-medium text-white/90">{title}</h3>
      </div>
      <p className="mt-2.5 text-sm leading-relaxed text-white/55">{description}</p>
      {children ? <div className="mt-auto pt-5">{children}</div> : null}
    </div>
  );
}

type AutomationKind = "mcp" | "cli" | "sdk";

const AUTOMATION_OPTIONS: Array<{
  kind: AutomationKind;
  label: string;
  icon: LucideIcon;
}> = [
  { kind: "mcp", label: "MCP", icon: Bot },
  { kind: "cli", label: "CLI", icon: Terminal },
  { kind: "sdk", label: "SDK", icon: Braces },
];

function AutomationSection() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  const [activeKind, setActiveKind] = React.useState<AutomationKind>("mcp");
  const links = React.useMemo(
    () =>
      AUTOMATION_OPTIONS.map((option) => ({
        href: localize(`/docs/${option.kind}`),
        label: t(`landing.automation.${option.kind}Docs`),
      })),
    [localize, t],
  );

  return (
    <FeatureSection
      title={t("landing.automation.title")}
      description={t("landing.automation.description")}
      links={links}
    >
      <div className="grid gap-px overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.08] md:grid-cols-[15rem_minmax(0,1fr)]">
        <div
          className="grid grid-cols-3 gap-px bg-white/[0.08] md:grid-cols-1 md:content-start md:bg-background"
          role="tablist"
        >
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
  const { t } = useTranslation();
  const Icon = option.icon;
  const handleClick = React.useCallback(() => onSelect(option.kind), [onSelect, option.kind]);

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={handleClick}
      className={`cursor-pointer border-b-2 p-3.5 text-left transition-colors md:border-b md:border-b-white/[0.07] md:border-l-2 md:p-5 ${
        active
          ? "border-b-brand-green bg-white/[0.045] md:border-l-brand-green"
          : "border-b-transparent bg-background hover:bg-white/[0.025] md:border-l-transparent"
      }`}
    >
      <div className="flex shrink-0 items-center gap-2 font-mono md:mb-1.5">
        <Icon
          className={`h-3.5 w-3.5 ${active ? "text-accent-text" : "text-muted-foreground"}`}
          strokeWidth={1.5}
        />
        <span className={`text-[11px] ${active ? "text-accent-text" : "text-muted-foreground"}`}>
          {option.label}
        </span>
      </div>
      <p className="mt-1 text-xs leading-snug text-white/85 md:mt-0 md:text-sm">
        {t(`landing.automation.${option.kind}Caption`)}
      </p>
    </button>
  );
}

function AutomationDetail({ kind }: { kind: AutomationKind }) {
  return (
    <div
      role="tabpanel"
      className="min-h-80 min-w-0 overflow-hidden bg-[#0c1110] p-5 md:h-[26rem] md:p-6"
    >
      {kind === "mcp" ? <McpAutomationTranscript /> : null}
      {kind === "cli" ? <CliAutomationExample /> : null}
      {kind === "sdk" ? <SdkAutomationExample /> : null}
    </div>
  );
}

const MCP_AGENT_CALLS: ToolCall[] = [
  { kind: "paseo", label: "Create agent", detail: "Fix #412: relay handshake race" },
  { kind: "paseo", label: "Create agent", detail: "Fix #417: menu bar icon on macOS" },
];

function McpAutomationTranscript() {
  const { t } = useTranslation();
  return (
    <AgentTurn request={t("landing.automation.transcriptRequest")}>
      <AgentText>{t("landing.automation.transcriptPlan")}</AgentText>
      <ToolCalls calls={MCP_AGENT_CALLS} />
      <AgentText>{t("landing.automation.transcriptDone")}</AgentText>
    </AgentTurn>
  );
}

/** A user message and the agent's reply, laid out like the app's timeline. */
function AgentTurn({ request, children }: { request: string; children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <UserMessage>{request}</UserMessage>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function UserMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="ml-auto w-fit max-w-md rounded-xl bg-white/[0.07] px-4 py-3">
      <p className="text-sm leading-relaxed text-white/80">{children}</p>
    </div>
  );
}

function AgentText({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-white/80">{children}</p>;
}

function ToolCalls({ calls }: { calls: ReadonlyArray<ToolCall> }) {
  return (
    <div>
      {calls.map((call) => (
        <ToolCallRow key={`${call.kind}:${call.detail}`} call={call} />
      ))}
    </div>
  );
}

function CliAutomationExample() {
  const { t } = useTranslation();
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
          <div className="text-white/30">{t("landing.automation.otherHostComment")}</div>
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

function HubSection() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <motion.section
      initial={FADE_IN_UP}
      whileInView={FADE_IN}
      viewport={VIEWPORT_60}
      transition={EASE_OUT_05}
      aria-labelledby="hub-section-heading"
    >
      <div className="mb-10 space-y-3 md:mb-12">
        <h2 id="hub-section-heading">
          <PaseoHubLockup size="display" className="h-9 w-auto text-foreground md:h-11" />
          <span className="sr-only">{t("hub.title")}</span>
        </h2>
        <p className="max-w-xl text-base text-pretty text-muted-foreground">
          {t("landing.hubSection.description")}
        </p>
      </div>

      <div className="space-y-8">
        <HubLandingFlow />

        <div className="flex flex-wrap items-center gap-3">
          <a href={localize("/hub")} className={PRIMARY_CTA_CLASS}>
            {t("landing.hubSection.exploreCta")}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </a>
          <a href={localize("/docs/hub")} className={SECONDARY_CTA_CLASS}>
            {t("landing.hubSection.docsCta")}
          </a>
        </div>
      </div>
    </motion.section>
  );
}

function ExtensibleSection({ pluginCount }: { pluginCount?: number | null }) {
  const { t } = useTranslation();
  const pluginActions = React.useMemo(() => <PluginActions />, []);
  const libraryTitle =
    pluginCount && pluginCount > 0
      ? t("landing.plugins.libraryTitleCount", { count: pluginCount })
      : t("landing.plugins.libraryTitle");
  return (
    <FeatureSection
      eyebrow={t("landing.eyebrows.plugins")}
      title={t("landing.plugins.title")}
      description={t("landing.plugins.description")}
    >
      <div className="space-y-6">
        <SelfModifyDemo />
        <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.08]">
          <div className="space-y-5 bg-background p-6">
            <ProductLead
              icon={Puzzle}
              title={libraryTitle}
              description={t("landing.plugins.libraryDescription")}
              actions={pluginActions}
            />
            <PluginCategoryLinks />
          </div>
          <div className="flex flex-col gap-3 border-t border-white/[0.08] bg-background px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-white/50">{t("landing.plugins.license")}</p>
            <a
              href="https://github.com/getpaseo/paseo"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-accent-text"
            >
              <GitFork className="h-4 w-4" strokeWidth={1.5} />
              {t("landing.plugins.fork")}
              <ExternalLink className="h-3.5 w-3.5 opacity-70" />
            </a>
          </div>
        </div>
      </div>
    </FeatureSection>
  );
}

const PLUGIN_BUILD_CALLS: ToolCall[] = [
  { kind: "read", detail: "paseo-plugin/SKILL.md" },
  { kind: "shell", detail: "paseo plugin init review-queue" },
  { kind: "write", detail: "review-queue/index.ts" },
  { kind: "write", detail: "review-queue/review-queue.client.tsx" },
  { kind: "shell", detail: "paseo plugin install ./review-queue" },
];

// The demo plays once when it scrolls into view: the prompt, then each timeline
// item in turn, then the panel the agent built slides in and fills.
const DEMO_STEP_SECONDS = 0.45;
const DEMO_STEPS = {
  prompt: 0,
  plan: 1.4,
  firstCall: 2.2,
} as const;
const DEMO_DONE_STEP = DEMO_STEPS.firstCall + PLUGIN_BUILD_CALLS.length;
const DEMO_PANEL_STEP = DEMO_DONE_STEP + 1;

const DEMO_ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, y: 6 },
  shown: (step: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: step * DEMO_STEP_SECONDS, duration: 0.35, ease: "easeOut" },
  }),
};
const DEMO_PANEL_VARIANTS: Variants = {
  hidden: { opacity: 0, x: "100%" },
  shown: {
    opacity: 1,
    x: 0,
    transition: {
      delay: DEMO_PANEL_STEP * DEMO_STEP_SECONDS,
      duration: 0.6,
      ease: [0.22, 0.61, 0.36, 1],
    },
  },
};

/** One piece of the demo that fades in at its step. */
function DemoItem({ step, children }: { step: number; children: React.ReactNode }) {
  return (
    <motion.div variants={DEMO_ITEM_VARIANTS} custom={step}>
      {children}
    </motion.div>
  );
}

/** The ask on the left, the panel it produced on the right. */
function SelfModifyDemo() {
  const { t } = useTranslation();
  // Visitors who ask for reduced motion get the finished demo, with no slide or staging.
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      initial={reduceMotion ? "shown" : "hidden"}
      whileInView="shown"
      viewport={VIEWPORT_60}
      className="grid min-h-[22rem] grid-cols-[minmax(0,1fr)] overflow-hidden rounded-xl border border-white/[0.08] bg-[#0c1110] md:grid-cols-[minmax(0,1fr)_17rem]"
    >
      <div className="space-y-5 p-5 md:p-6">
        <DemoItem step={DEMO_STEPS.prompt}>
          <UserMessage>{t("landing.plugins.request")}</UserMessage>
        </DemoItem>
        <div className="space-y-3">
          <DemoItem step={DEMO_STEPS.plan}>
            <AgentText>{t("landing.plugins.plan")}</AgentText>
          </DemoItem>
          <div>
            {PLUGIN_BUILD_CALLS.map((call, index) => (
              <DemoItem key={`${call.kind}:${call.detail}`} step={DEMO_STEPS.firstCall + index}>
                <ToolCallRow call={call} />
              </DemoItem>
            ))}
          </div>
          <DemoItem step={DEMO_DONE_STEP}>
            <AgentText>{t("landing.plugins.done")}</AgentText>
          </DemoItem>
        </div>
      </div>
      <ReviewQueuePreview />
    </motion.div>
  );
}

const REVIEW_QUEUE = [
  { number: "#418", title: "Retry flaky relay handshake", author: "ana", age: "12m" },
  { number: "#415", title: "Group schedules by project", author: "kenji", age: "1h" },
  { number: "#409", title: "Add Gruvbox theme", author: "lea", age: "3h" },
] as const;

/** The panel the agent just built, docked like a real sidebar panel. */
function ReviewQueuePreview() {
  const { t } = useTranslation();
  return (
    <motion.div
      variants={DEMO_PANEL_VARIANTS}
      className="border-t border-white/10 bg-white/[0.025] p-4 md:border-t-0 md:border-l"
    >
      <div className="mb-3 flex items-center gap-2">
        <GitPullRequest className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
        <span className="text-sm font-medium text-white/85">{t("landing.plugins.panelTitle")}</span>
        <span className="ml-auto rounded-full bg-white/[0.07] px-2 py-0.5 text-[10px] text-white/55">
          {REVIEW_QUEUE.length}
        </span>
      </div>
      <div className="space-y-1">
        {REVIEW_QUEUE.map((pr, index) => (
          <DemoItem key={pr.number} step={DEMO_PANEL_STEP + 1.2 + index * 0.4}>
            <div className="rounded-md px-2 py-2 hover:bg-white/[0.04]">
              <p className="truncate text-xs text-white/80">{pr.title}</p>
              <p className="mt-0.5 font-mono text-[10px] text-white/35">
                {pr.number} · {pr.author} · {pr.age}
              </p>
            </div>
          </DemoItem>
        ))}
      </div>
    </motion.div>
  );
}

const SHOWCASE_CATEGORIES = [
  "themes",
  "sidebar",
  "workspaces",
  "providers",
  "orchestration",
  "git",
] as const satisfies ReadonlyArray<CategorySlug>;

function PluginCategoryLinks() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <div className="flex flex-wrap gap-2">
      {SHOWCASE_CATEGORIES.map((category) => (
        <a
          key={category}
          href={localize(categoryHref(category))}
          className="rounded-full border border-white/10 bg-white/[0.025] px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/15 hover:bg-white/[0.06] hover:text-white"
        >
          {t(`plugins.categories.${category}.label`)}
        </a>
      ))}
    </div>
  );
}

const PLUGINS_BROWSE = PLUGINS_LINKED
  ? { href: "/plugins", external: false }
  : { href: "https://paseo.cafe", external: true };

function PluginActions() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <>
      <a
        href={localize(PLUGINS_BROWSE.href)}
        {...(PLUGINS_BROWSE.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs text-background transition-colors hover:bg-foreground/90"
      >
        {t("landing.plugins.browse")}
        <ArrowRight className="h-3.5 w-3.5" />
      </a>
      <a
        href={localize("/docs/plugins")}
        className="inline-flex items-center gap-1.5 rounded-full border border-white/12 px-3 py-1.5 text-xs text-white/80 transition-colors hover:bg-white/10"
      >
        {t("landing.plugins.docs")}
      </a>
    </>
  );
}

const PRINCIPLES = [
  { icon: Lock, key: "private" },
  { icon: Compass, key: "independent" },
  { icon: Gem, key: "polished" },
  { icon: Merge, key: "unified" },
  { icon: Blocks, key: "composable" },
  { icon: Puzzle, key: "extensible" },
] as const;

function PhilosophySection() {
  const { t } = useTranslation();
  return (
    <FeatureSection
      eyebrow={t("landing.eyebrows.openSource")}
      title={t("landing.philosophy.title")}
      description={t("landing.philosophy.description")}
    >
      <HairlineGrid columns="3">
        {PRINCIPLES.map((principle) => (
          <FeatureCell
            key={principle.key}
            icon={principle.icon}
            title={t(`landing.philosophy.${principle.key}Title`)}
            description={t(`landing.philosophy.${principle.key}Description`)}
          />
        ))}
      </HairlineGrid>
    </FeatureSection>
  );
}

function DownloadActions() {
  const platform = useVisitorPlatform();
  return (
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
  );
}

function GetStarted() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <div className="pt-8">
      {/* The primary call to action owns its own row on phones so the small icon
          buttons never wrap and orphan one of themselves onto a line alone. It
          still hugs its label rather than stretching across the row. */}
      <DownloadActions />
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pt-6">
        <span className="text-xs text-muted-foreground">{t("landing.getStarted.supports")}</span>
        <div className="flex items-center gap-1">
          {FEATURED_AGENTS.map((agent) => (
            <AgentBadge key={agent.name} name={agent.name} Icon={agent.Icon} />
          ))}
        </div>
        <a
          href={localize("/agents")}
          className="whitespace-nowrap text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("common.more", { count: ADDITIONAL_AGENT_COUNT })}
        </a>
      </div>
    </div>
  );
}

function ClosingCtaSection() {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="closing-cta-heading" className="text-center">
      <div className="mb-6 flex justify-center">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-brand-green/40 bg-brand-green/15 text-accent-text">
          <PaseoMark className="h-6 w-6" />
        </span>
      </div>
      <SectionOpener
        align="center"
        eyebrow={t("landing.closingCta.eyebrow")}
        headingId="closing-cta-heading"
        title={t("landing.closingCta.title")}
        description={t("landing.closingCta.description")}
        className="mb-8"
      />
      <DownloadActions />
    </section>
  );
}

const PRIMARY_CTA_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:bg-foreground/90 transition-colors";
const SECONDARY_CTA_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-white/12 px-3 py-2.5 text-sm text-white hover:bg-white/10 transition-colors";

function DesktopDownloadButton({ platform }: { platform: DesktopPlatform }) {
  const { t } = useTranslation();
  const download = getDesktopDownload(useRelease(), platform, useLocale());
  const Icon = download.icon;
  return (
    <a href={download.href} className={PRIMARY_CTA_CLASS}>
      <Icon className="h-4 w-4" />
      {t("landing.getStarted.downloadFor", { platform: download.label })}
    </a>
  );
}

function StoreButton({ platform }: { platform: MobilePlatform }) {
  const { t } = useTranslation();
  const store = MOBILE_STORES[platform];
  const Icon = store.icon;
  return (
    <a href={store.href} target="_blank" rel="noopener noreferrer" className={PRIMARY_CTA_CLASS}>
      <Icon className="h-4 w-4" />
      {t("landing.getStarted.getStoreApp", { store: store.label })}
    </a>
  );
}

// On a phone the desktop build is the secondary path, so it points at /download
// instead of handing the visitor a .dmg they cannot open.
function DesktopAppLink() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <a href={localize("/download")} className={SECONDARY_CTA_CLASS}>
      <Monitor className="h-4 w-4" strokeWidth={1.5} />
      {t("landing.getStarted.desktopApp")}
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

const SERVER_INSTALL_FOOTNOTE_COMPONENTS = {
  code: <span className="font-mono text-white/40" />,
};

function ServerInstallButton() {
  const { t } = useTranslation();
  const trigger = React.useMemo(
    () => (
      <span
        className="inline-flex items-center justify-center rounded-lg border border-white/12 px-3 py-2.5 text-white hover:bg-white/10 transition-colors"
        aria-label={t("landing.getStarted.serverInstallLabel")}
      >
        <TerminalIcon className="h-5 w-5" />
      </span>
    ),
    [t],
  );
  const footnote = React.useMemo(
    () => (
      <Trans
        i18nKey="landing.getStarted.serverInstallFootnote"
        components={SERVER_INSTALL_FOOTNOTE_COMPONENTS}
      />
    ),
    [],
  );
  return (
    <CommandDialog
      trigger={trigger}
      title={t("landing.getStarted.serverInstallTitle")}
      description={t("landing.getStarted.serverInstallDescription")}
      command="npm install -g @getpaseo/cli && paseo"
      footnote={footnote}
    />
  );
}

function PhoneShowcase() {
  const { t } = useTranslation();
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
    <div ref={containerRef} className="flex flex-col items-center gap-14 pt-2 pb-12 md:pb-16">
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
          {t("landing.showcase.heading")}
        </p>
        <p className="max-w-sm text-balance text-center text-sm text-white/50">
          {t("landing.showcase.subheading")}
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
          aria-label={t("landing.showcase.sidebarLabel")}
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
          aria-label={t("landing.showcase.chatLabel")}
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
          aria-label={t("landing.showcase.diffLabel")}
        >
          <PhoneFrame time="18:55" depth="left">
            <MobileDiff />
          </PhoneFrame>
        </motion.div>
      </div>
    </div>
  );
}

const FAQ_ENTRIES = [
  "free",
  "code",
  "agents",
  "providers",
  "desktop",
  "voice",
  "network",
  "git",
  "ban",
  "worktrees",
] as const;

const FAQ_LINKS = {
  relay: "/docs/security",
  agents: "/agents",
  muse: "/docs/supported-providers/muse-code",
  voice: "/docs/voice",
  connectivity: "/docs/connectivity",
  worktrees: "/docs/worktrees",
};

function TrustStrip() {
  const { t } = useTranslation();
  return (
    <div className="pb-10 md:pb-14">
      <ul className="flex flex-col items-center justify-center gap-y-2 text-xs text-white/60 sm:flex-row sm:flex-wrap sm:gap-x-4 md:text-sm">
        <li className="flex items-center gap-x-3 sm:gap-x-4">
          <span>{t("landing.trustStrip.noTelemetry")}</span>
          <span aria-hidden="true" className="select-none text-white/25">
            ·
          </span>
          <span>{t("landing.trustStrip.e2eeRelay")}</span>
        </li>
        <li aria-hidden="true" className="hidden select-none text-white/25 sm:block">
          ·
        </li>
        <li className="flex items-center gap-x-3 sm:gap-x-4">
          <span>{t("landing.trustStrip.openSource")}</span>
          <span aria-hidden="true" className="select-none text-white/25">
            ·
          </span>
          <span>{t("landing.trustStrip.independent")}</span>
        </li>
      </ul>
    </div>
  );
}

function FAQ() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  const links = React.useMemo(
    () =>
      Object.fromEntries(
        Object.entries(FAQ_LINKS).map(([name, href]) => [
          name,
          <a key={name} href={localize(href)} className="underline hover:text-white/80" />,
        ]),
      ),
    [localize],
  );
  return (
    <motion.section
      initial={FADE_IN_UP}
      whileInView={FADE_IN}
      viewport={VIEWPORT_60}
      transition={EASE_OUT_05}
      aria-labelledby="home-faq-heading"
      className="grid items-start gap-10 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:gap-16"
    >
      <SectionOpener
        headingId="home-faq-heading"
        title={t("landing.faq.title")}
        className="mb-0 self-start"
      />
      <div className="divide-y divide-white/[0.08] border-y border-white/[0.08]">
        {FAQ_ENTRIES.map((entry) => (
          <FAQItem key={entry} question={t(`landing.faq.${entry}Question`)}>
            <Trans i18nKey={`landing.faq.${entry}Answer`} components={links} />
          </FAQItem>
        ))}
      </div>
    </motion.section>
  );
}
