import { ArrowRight, Check, ExternalLink } from "lucide-react";
import { BuyMeACoffeeIcon, GitHubIcon, OpenCollectiveIcon } from "~/components/brand-icons";
import {
  BUY_ME_A_COFFEE_URL,
  GITHUB_SPONSORS_URL,
  HOMEPAGE_SPONSORS,
  HOMEPAGE_SPOT_PRICE,
  OPEN_COLLECTIVE_URL,
  SPONSOR_CONTACT_EMAIL,
  SPONSOR_SPOT_CHECKOUT_URL,
  openSpotCount,
} from "~/data/sponsors";

function SectionHeading({
  as: Heading,
  title,
  description,
  badge,
}: {
  as: "h1" | "h2";
  title: string;
  description?: string;
  badge?: string;
}) {
  return (
    <div className="mb-12 space-y-2">
      <div className="flex items-center gap-3">
        <Heading className="text-3xl font-medium tracking-tight">{title}</Heading>
        {badge ? (
          <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-xs text-emerald-300">
            {badge}
          </span>
        ) : null}
      </div>
      {description ? (
        <p className="max-w-lg text-base text-pretty text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

const MAINTAINER_LINK = (
  <a
    href="https://github.com/boudra"
    target="_blank"
    rel="noopener noreferrer"
    className="underline hover:text-white/80"
  >
    Mo
  </a>
);

export function FounderNote() {
  return (
    <div className="max-w-2xl space-y-5 leading-relaxed text-white/70">
      <p>
        I build Paseo on my own. There are no investors, no board and no company behind it, and I
        have turned down funding offers to keep it that way.
      </p>
      <p>
        A tool that sits between you and your code, your keys and your machines has to stay neutral,
        and that gets hard once someone else owns a return on it. Funding creates pressure to
        monetize, and that pressure changes what gets built.
      </p>
      <p>
        Paseo is self-funded: the work is paid for by sponsorship and by{" "}
        <a href="/hub" className="underline hover:text-white/90">
          Paseo Hub
        </a>
        , an optional hosted service. Your support is what lets me work on Paseo full time.
      </p>
      <p className="text-white/50">{MAINTAINER_LINK}, maintainer</p>
    </div>
  );
}

interface BackingOption {
  href: string;
  name: string;
  detail: string;
  icon: React.ComponentType<{ className?: string }>;
  external: boolean;
  primary?: boolean;
}

const BACKING_OPTIONS: ReadonlyArray<BackingOption> = [
  {
    href: GITHUB_SPONSORS_URL,
    name: "GitHub Sponsors",
    detail: "From $5 a month, or one time",
    icon: GitHubIcon,
    external: true,
    primary: true,
  },
  {
    href: OPEN_COLLECTIVE_URL,
    name: "Open Collective",
    detail: "Monthly or one time, with an invoice",
    icon: OpenCollectiveIcon,
    external: true,
  },
  {
    href: BUY_ME_A_COFFEE_URL,
    name: "Buy Me a Coffee",
    detail: "One time, no account needed",
    icon: BuyMeACoffeeIcon,
    external: true,
  },
  {
    href: "/sponsor#spot",
    name: "Sponsor a spot",
    detail: "For companies",
    icon: SpotIcon,
    external: false,
  },
];

function SpotIcon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block rounded-md border border-dashed border-current ${className ?? ""}`}
    />
  );
}

export function BackingOptions() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {BACKING_OPTIONS.map((option) => (
        <a
          key={option.href}
          href={option.href}
          {...(option.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className={`flex items-start gap-4 rounded-xl border p-4 transition-colors ${
            option.primary
              ? "border-white/25 bg-white/[0.06] hover:border-white/40 hover:bg-white/[0.08]"
              : "border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.05]"
          }`}
        >
          <option.icon className="mt-0.5 h-6 w-6 shrink-0 text-white/60" />
          <div className="space-y-1">
            <p className="flex items-center gap-1.5 font-medium text-white">
              {option.name}
              {option.external ? (
                <ExternalLink className="h-3.5 w-3.5 text-white/40" />
              ) : (
                <ArrowRight className="h-3.5 w-3.5 text-white/40" />
              )}
            </p>
            <p className="text-sm text-white/50">{option.detail}</p>
          </div>
        </a>
      ))}
    </div>
  );
}

/** The four homepage spots: sponsor logos first, then a placeholder for each open spot. */
function SponsorLogoRow() {
  const placeholders = Array.from({ length: openSpotCount() }, (_, index) => index);
  return (
    <ul className="grid grid-cols-2 gap-4">
      {HOMEPAGE_SPONSORS.map((sponsor) => (
        <li key={sponsor.href}>
          <a
            href={sponsor.href}
            target="_blank"
            rel="noopener noreferrer sponsored"
            className="flex h-32 items-center justify-center rounded-xl border border-white/10 bg-white/[0.02] px-6 transition-colors hover:border-white/20 hover:bg-white/[0.05]"
          >
            <img src={sponsor.logo} alt={sponsor.name} className="max-h-10 max-w-full opacity-80" />
          </a>
        </li>
      ))}
      {placeholders.map((index) => (
        <li key={index}>
          <a
            href="/sponsor#spot"
            className="flex h-32 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-white/20 transition-colors hover:border-white/40 hover:bg-white/[0.03]"
          >
            <span className="text-sm font-medium text-white/70">Sponsor</span>
            <span className="text-xs text-white/40">{HOMEPAGE_SPOT_PRICE} a month</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

const SPOT_FEATURES: ReadonlyArray<string> = [
  "Your logo on the homepage of paseo.sh, around 70,000 visitors a month",
  "Your logo in the GitHub README, around 30,000 visitors a month",
  "An announcement in the Discord, around 2,000 members",
  "A mention in the changelog",
];

export function SponsorSpotSection() {
  const open = openSpotCount();
  return (
    <section id="spot" className="scroll-mt-8">
      <SectionHeading
        as="h2"
        title="Sponsor a spot"
        description="Support an independent project and put your company in front of a fast-growing audience of developers."
      />
      <div className="space-y-8">
        <div className="flex items-end gap-2">
          <span className="text-4xl font-medium tracking-tight">{HOMEPAGE_SPOT_PRICE}</span>
          <span className="mb-1 text-sm text-white/45">a month</span>
        </div>
        <ul className="grid max-w-2xl gap-3 text-white/70">
          {SPOT_FEATURES.map((feature) => (
            <li key={feature} className="flex items-start gap-2.5">
              <Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-emerald-300" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          {open > 0 ? (
            <a
              href={SPONSOR_SPOT_CHECKOUT_URL}
              className="inline-flex items-center rounded-md bg-white px-5 py-2.5 text-sm font-medium text-black transition-colors hover:bg-white/90"
            >
              Sponsor a spot
            </a>
          ) : null}
          <a
            href={`mailto:${SPONSOR_CONTACT_EMAIL}`}
            className="text-sm text-white/60 underline transition-colors hover:text-white/90"
          >
            {open > 0 ? "Or email me first" : "Email me to hear when a spot opens"}
          </a>
        </div>
      </div>
    </section>
  );
}

/** The /sponsor page's first section: the note and the ways to back the work. */
export function SponsorPaseoSection() {
  return (
    <section>
      <SectionHeading as="h1" title="Sponsor Paseo" />
      <div className="space-y-10">
        <FounderNote />
        <BackingOptions />
      </div>
    </section>
  );
}

/** Homepage: a short version of the note with the same links as /sponsor. */
export function SponsorSection() {
  return (
    <section>
      <SectionHeading as="h2" title="Sponsor Paseo" />
      <div className="space-y-10">
        <div className="max-w-2xl space-y-5 leading-relaxed text-white/70">
          <p>
            I build Paseo on my own, with no investors and no company behind it, and I have turned
            down funding offers to keep it that way. A tool that sits between you and your code,
            your keys and your machines has to stay neutral, and funding creates pressure to
            monetize.
          </p>
          <p>
            Paseo is self-funded through sponsorship and{" "}
            <a href="/hub" className="underline hover:text-white/90">
              Paseo Hub
            </a>
            , and your support is what lets me work on it full time.
          </p>
          <p className="text-white/50">{MAINTAINER_LINK}, maintainer</p>
        </div>
        <BackingOptions />
      </div>
    </section>
  );
}

/** Homepage: the four sponsor spots, as they look once filled. */
export function SponsorsSection() {
  return (
    <section>
      <SectionHeading as="h2" title="Sponsors" badge="New" />
      <SponsorLogoRow />
    </section>
  );
}
