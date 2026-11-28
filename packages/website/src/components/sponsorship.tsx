import { ArrowRight, Check, ExternalLink, Heart } from "lucide-react";
import * as React from "react";
import { Trans, useTranslation } from "react-i18next";
import { BuyMeACoffeeIcon, GitHubIcon, OpenCollectiveIcon } from "~/components/brand-icons";
import { HairlineGrid, SectionOpener } from "~/components/page-frame";
import {
  BUY_ME_A_COFFEE_URL,
  GITHUB_SPONSORS_URL,
  OPEN_COLLECTIVE_URL,
  SPONSORS,
  SPONSOR_CONTACT_EMAIL,
  SPONSOR_SPOT_CHECKOUT_URL,
  SPONSOR_SPOT_PRICE,
  openSpotCount,
  sponsorHref,
} from "~/data/sponsors";
import { useLocalizePath } from "~/i18n";

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
    <div className="mb-10 space-y-2.5">
      <div className="flex items-center gap-3">
        <Heading className="font-display text-3xl font-semibold tracking-[-0.025em] md:text-[42px]">
          {title}
        </Heading>
        {badge ? (
          <span className="rounded-full border border-brand-green/40 bg-brand-green/20 px-2.5 py-0.5 text-xs text-accent-text">
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

const MAINTAINER_COMPONENTS = {
  maintainer: (
    <a
      href="https://github.com/boudra"
      target="_blank"
      rel="noopener noreferrer"
      className="underline hover:text-white/80"
    />
  ),
};

const MAINTAINER_SIGNATURE = (
  <p className="text-sm text-white/50">
    <Trans i18nKey="sponsor.maintainer" components={MAINTAINER_COMPONENTS} />
  </p>
);

/** Links `<hub>` in sponsorship copy to the Hub page in the reader's language. */
function useHubLinkComponents() {
  const localize = useLocalizePath();
  return React.useMemo(
    () => ({
      hub: <a href={localize("/hub")} className="underline hover:text-white/90" />,
    }),
    [localize],
  );
}

export function FounderNote() {
  const { t } = useTranslation();
  const hubLink = useHubLinkComponents();
  return (
    <div className="max-w-2xl space-y-5 leading-relaxed text-white/70">
      <p>{t("sponsor.note.independent")}</p>
      <p>{t("sponsor.note.maintained")}</p>
      <p>{t("sponsor.note.community")}</p>
      <p>{t("sponsor.note.neutral")}</p>
      <p>
        <Trans i18nKey="sponsor.note.selfFunded" components={hubLink} />
      </p>
      {MAINTAINER_SIGNATURE}
    </div>
  );
}

interface BackingOption {
  href: string;
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  external: boolean;
}

const DONATION_OPTIONS: ReadonlyArray<BackingOption> = [
  {
    href: GITHUB_SPONSORS_URL,
    name: "GitHub Sponsors",
    icon: GitHubIcon,
    external: true,
  },
  {
    href: OPEN_COLLECTIVE_URL,
    name: "Open Collective",
    icon: OpenCollectiveIcon,
    external: true,
  },
  {
    href: BUY_ME_A_COFFEE_URL,
    name: "Buy Me a Coffee",
    icon: BuyMeACoffeeIcon,
    external: true,
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
  const { t } = useTranslation();
  const localize = useLocalizePath();
  const options = React.useMemo(
    () => [
      ...DONATION_OPTIONS,
      {
        href: localize("/sponsor#spot"),
        name: t("sponsor.company.title"),
        icon: SpotIcon,
        external: false,
      },
    ],
    [localize, t],
  );
  return (
    <HairlineGrid columns="2">
      {options.map((option) => (
        <a
          key={option.href}
          href={option.href}
          {...(option.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="group flex items-center justify-between gap-4 bg-background px-5 py-4 transition-colors hover:bg-white/[0.03]"
        >
          <span className="flex items-center gap-3.5">
            <option.icon className="h-5 w-5 shrink-0 text-white/60 transition-colors group-hover:text-white/90" />
            <span className="text-sm font-medium text-white/90 group-hover:text-white">
              {option.name}
            </span>
          </span>
          {option.external ? (
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-white/35 transition-colors group-hover:text-accent-text" />
          ) : (
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-white/35 transition-colors group-hover:text-accent-text" />
          )}
        </a>
      ))}
    </HairlineGrid>
  );
}

const SPOT_FEATURES = ["homepage", "readme", "discord", "x"] as const;

export function SponsorSpotSection() {
  const { t } = useTranslation();
  const open = openSpotCount();
  return (
    <section id="spot" className="scroll-mt-8">
      <SectionHeading
        as="h2"
        title={t("sponsor.company.title")}
        description={t("sponsor.company.description")}
      />
      <div className="space-y-8">
        <div className="flex items-end gap-2">
          <span className="text-4xl font-medium tracking-tight">{SPONSOR_SPOT_PRICE}</span>
          <span className="mb-1 text-sm text-white/45">{t("sponsor.company.perMonth")}</span>
        </div>
        <ul className="grid max-w-2xl gap-3 text-white/70">
          {SPOT_FEATURES.map((feature) => (
            <li key={feature} className="flex items-start gap-2.5">
              <Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-accent-text" />
              <span>{t(`sponsor.company.${feature}`)}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          {open > 0 ? (
            <a
              href={SPONSOR_SPOT_CHECKOUT_URL}
              className="inline-flex items-center rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-foreground/90"
            >
              {t("sponsor.becomeSponsor")}
            </a>
          ) : null}
          <a
            href={`mailto:${SPONSOR_CONTACT_EMAIL}`}
            className="text-sm text-white/60 underline transition-colors hover:text-white/90"
          >
            {open > 0 ? t("sponsor.company.emailFirst") : t("sponsor.company.emailWhenOpen")}
          </a>
        </div>
      </div>
    </section>
  );
}

/** The /sponsor page's first section: the note and the ways to back the work. */
export function SponsorPaseoSection() {
  const { t } = useTranslation();
  return (
    <section>
      <SectionHeading as="h1" title={t("sponsor.title")} />
      <div className="space-y-10">
        <FounderNote />
        <BackingOptions />
      </div>
    </section>
  );
}

/** Standalone short sponsor note + backing options (used on /download/thanks). */
export function SponsorSection() {
  const { t } = useTranslation();
  const hubLink = useHubLinkComponents();
  return (
    <section>
      <SectionHeading as="h2" title={t("sponsor.title")} />
      <div className="space-y-8">
        <div className="max-w-2xl space-y-4 text-sm leading-relaxed text-white/70">
          <p>{t("sponsor.note.independent")}</p>
          <p>{t("sponsor.shortNote.maintained")}</p>
          <p>
            <Trans i18nKey="sponsor.shortNote.selfFunded" components={hubLink} />
          </p>
          {MAINTAINER_SIGNATURE}
        </div>
        <BackingOptions />
      </div>
    </section>
  );
}

/**
 * Consolidated homepage Sponsors + Sponsor Paseo section.
 * Keeps `aria-labelledby="sponsors-heading"` with heading text "Sponsors" so the Sponsors region
 * contract stays intact while unifying the logo row, founder note, and backing options into one
 * coherent chapter.
 */
export function HomepageSponsorsSection() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  const hubLink = useHubLinkComponents();
  const open = openSpotCount();

  return (
    <section aria-labelledby="sponsors-heading">
      <SectionOpener headingId="sponsors-heading" title={t("sponsor.sponsors")} className="mb-10" />

      <ul className="flex flex-wrap items-start gap-x-14 gap-y-8">
        {SPONSORS.map((sponsor) => (
          <li key={sponsor.url}>
            <a
              href={sponsorHref(sponsor, "website")}
              target="_blank"
              rel="noopener noreferrer"
              className="block"
            >
              <img src={sponsor.logo.onDark} alt={sponsor.name} className="h-12 w-auto" />
            </a>
            <p className="mt-2 max-w-72 text-sm text-balance text-white/55">
              {sponsor.description}
            </p>
          </li>
        ))}
        {open > 0 ? (
          <li>
            <a
              href={localize("/sponsor#spot")}
              className="inline-flex h-11 items-center rounded-lg border border-dashed border-white/15 px-4 text-sm text-white/50 transition-colors hover:border-white/30 hover:text-white/80"
            >
              {t("sponsor.becomeSponsor")}
            </a>
          </li>
        ) : null}
      </ul>

      <div className="mt-10 grid gap-10 border-t border-white/[0.07] pt-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
        <div className="space-y-4 text-sm leading-relaxed text-white/70">
          <p>{t("sponsor.note.independent")}</p>
          <p>{t("sponsor.shortNote.maintained")}</p>
          <p>
            <Trans i18nKey="sponsor.shortNote.selfFunded" components={hubLink} />
          </p>
          {MAINTAINER_SIGNATURE}
        </div>
        <BackingOptions />
      </div>
    </section>
  );
}

const SPONSORS_PLACEMENTS = {
  page: {
    section: "space-y-10",
    heading: "gap-2.5 text-3xl font-medium tracking-tight",
    heart: "size-6",
    list: "gap-x-14",
    link: "",
    logo: "h-14",
    description: "mt-2 max-w-72 text-sm text-balance text-white/55",
    button: "h-12 px-5 text-sm",
  },
  footer: {
    section: "space-y-5 py-8",
    heading:
      "gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-extra-muted-foreground",
    heart: "size-3",
    // Narrower than `page` so two captions and the invitation fit one row in the docs column.
    list: "gap-x-10",
    link: "opacity-85 transition-opacity hover:opacity-100",
    logo: "h-9",
    description: "mt-1.5 max-w-58 text-xs text-balance text-white/45",
    button: "h-9 px-3.5 text-xs",
  },
} as const;

interface SponsorsSectionProps {
  /** `page` is a standalone section; `footer` is the band above other pages' footers. */
  placement: keyof typeof SPONSORS_PLACEMENTS;
}

/**
 * The companies sponsoring Paseo: one monochrome logo per sponsor and, while
 * spots are open, a quiet invitation. Every page shows it once.
 */
export function SponsorsSection({ placement }: SponsorsSectionProps) {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  const style = SPONSORS_PLACEMENTS[placement];
  const open = openSpotCount();
  return (
    <section aria-labelledby="sponsors-heading" className={style.section}>
      <h2 id="sponsors-heading" className={`flex items-center ${style.heading}`}>
        <Heart
          aria-hidden="true"
          className={`fill-rose-300/80 text-rose-300/80 ${style.heart}`}
          strokeWidth={1.5}
        />
        {t("sponsor.sponsors")}
      </h2>
      <ul className={`flex flex-wrap items-start gap-y-8 ${style.list}`}>
        {SPONSORS.map((sponsor) => (
          <li key={sponsor.url}>
            <a
              href={sponsorHref(sponsor, "website")}
              target="_blank"
              rel="noopener noreferrer"
              className={`block ${style.link}`}
            >
              <img
                src={sponsor.logo.onDark}
                alt={sponsor.name}
                className={`${style.logo} w-auto`}
              />
            </a>
            <p className={style.description}>{sponsor.description}</p>
          </li>
        ))}
        {open > 0 ? (
          <li>
            <a
              href={localize("/sponsor#spot")}
              className={`inline-flex items-center rounded-lg border border-dashed border-white/15 text-white/45 transition-colors hover:border-white/30 hover:text-white/75 ${style.button}`}
            >
              {t("sponsor.becomeSponsor")}
            </a>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
