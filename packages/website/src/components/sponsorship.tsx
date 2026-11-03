import { ArrowRight, Check, ExternalLink, Heart } from "lucide-react";
import * as React from "react";
import { Trans, useTranslation } from "react-i18next";
import { useLocalizePath } from "~/i18n";
import { BuyMeACoffeeIcon, GitHubIcon, OpenCollectiveIcon } from "~/components/brand-icons";
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
  <p className="text-white/50">
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
    <div className="grid gap-3 md:grid-cols-2">
      {options.map((option) => (
        <a
          key={option.href}
          href={option.href}
          {...(option.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-4 transition-colors hover:border-white/20 hover:bg-white/[0.05]"
        >
          <option.icon className="h-6 w-6 shrink-0 text-white/60" />
          <p className="flex items-center gap-1.5 font-medium text-white">
            {option.name}
            {option.external ? (
              <ExternalLink className="h-3.5 w-3.5 text-white/40" />
            ) : (
              <ArrowRight className="h-3.5 w-3.5 text-white/40" />
            )}
          </p>
        </a>
      ))}
    </div>
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
              <Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-emerald-300" />
              <span>{t(`sponsor.company.${feature}`)}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          {open > 0 ? (
            <a
              href={SPONSOR_SPOT_CHECKOUT_URL}
              className="inline-flex items-center rounded-md bg-white px-5 py-2.5 text-sm font-medium text-black transition-colors hover:bg-white/90"
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

/** Homepage: a short version of the note with the same links as /sponsor. */
export function SponsorSection() {
  const { t } = useTranslation();
  const hubLink = useHubLinkComponents();
  return (
    <section>
      <SectionHeading as="h2" title={t("sponsor.title")} />
      <div className="space-y-10">
        <div className="max-w-2xl space-y-5 leading-relaxed text-white/70">
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
    link: "",
    logo: "h-14",
    description: "mt-2 text-sm text-white/55",
    button: "h-12 px-5 text-sm",
  },
  footer: {
    section: "space-y-5 border-t border-white/10 py-8",
    heading: "gap-1.5 text-sm text-extra-muted-foreground",
    heart: "size-3",
    link: "opacity-85 transition-opacity hover:opacity-100",
    logo: "h-10",
    description: "mt-1.5 text-xs text-white/45",
    button: "h-9 px-3.5 text-sm",
  },
} as const;

interface SponsorsSectionProps {
  /** `page` is a homepage section; `footer` is the band above other pages' footers. */
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
      <ul className="flex flex-wrap items-center gap-x-14 gap-y-8">
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
              className={`inline-flex items-center rounded-md border border-dashed border-white/15 text-white/45 transition-colors hover:border-white/30 hover:text-white/75 ${style.button}`}
            >
              {t("sponsor.becomeSponsor")}
            </a>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
