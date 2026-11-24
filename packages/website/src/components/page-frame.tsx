import { ExternalLink } from "lucide-react";
import type * as React from "react";
import { SiteHeader } from "~/components/site-header";

/** Shared outer container width. Uses a transparent md:border-x when unframed to avoid a 1px shift. */
export const PAGE_CONTAINER_CLASS =
  "mx-auto w-full max-w-[1160px] md:border-x md:border-transparent";

/** Shared outer rail width and vertical hairlines across marketing pages. */
export const PAGE_RAIL_CLASS = "mx-auto w-full max-w-[1160px] md:border-x md:border-white/[0.07]";

/** Shared inner horizontal padding so every page element shares one left/right rail. */
export const PAGE_INSET_CLASS = "px-5 sm:px-8 md:px-14";

/** Extend scrollable content from the mobile inset to the viewport edges. */
export const MOBILE_PAGE_BLEED_CLASS = "-mx-5 px-5";

/** Full-width header band locking logo and navigation to the same (x, y) across pages. */
export function PageHeaderBand({ framed = false }: { framed?: boolean }) {
  return (
    <div className={framed ? "border-b border-white/[0.07]" : ""}>
      <div
        className={`${framed ? PAGE_RAIL_CLASS : PAGE_CONTAINER_CLASS} ${PAGE_INSET_CLASS} py-4 md:py-5`}
      >
        <SiteHeader />
      </div>
    </div>
  );
}

const BAND_PADDING = {
  chapter: "py-16 md:py-24",
  section: "py-14 md:py-20",
  compact: "py-12 md:py-16",
  hero: "pt-12 pb-14 md:pt-16 md:pb-20",
  none: "",
} as const;

/**
 * A full-width architectural band separated by a 1px horizontal hairline with quiet crosshair
 * ticks where the horizontal rule meets the vertical frame rails.
 */
export function ChapterBand({
  children,
  spacing = "chapter",
  ruled = true,
  ticks = true,
  framed = true,
  tint = "none",
  className = "",
  id,
}: {
  children: React.ReactNode;
  spacing?: keyof typeof BAND_PADDING;
  ruled?: boolean;
  ticks?: boolean;
  framed?: boolean;
  tint?: "none" | "subtle";
  className?: string;
  id?: string;
}) {
  return (
    <div
      id={id}
      className={`overflow-x-clip ${ruled ? "border-t border-white/[0.07]" : ""} ${
        tint === "subtle" ? "bg-white/[0.014]" : ""
      } ${className}`}
    >
      <div
        className={`relative ${framed ? PAGE_RAIL_CLASS : PAGE_CONTAINER_CLASS} ${PAGE_INSET_CLASS} ${BAND_PADDING[spacing]}`}
      >
        {ruled && ticks && framed ? <RailIntersectionTicks /> : null}
        {children}
      </div>
    </div>
  );
}

/** Quiet 9px hairlines centered on the left and right vertical rail intersections. */
function RailIntersectionTicks() {
  return (
    <>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-[4.5px] -left-[4.5px] hidden h-[9px] w-[9px] md:block"
      >
        <span className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-white/25" />
        <span className="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-white/25" />
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-[4.5px] -right-[4.5px] hidden h-[9px] w-[9px] md:block"
      >
        <span className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-white/25" />
        <span className="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-white/25" />
      </span>
    </>
  );
}

/** Internal sub-section divider inside a multi-part chapter, staying inside the frame rails. */
export function ChapterDivider({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`-mx-5 border-t border-white/[0.07] sm:-mx-8 md:-mx-14 ${className}`}
    />
  );
}

/**
 * Unified section opener used across `/` and `/hub`:
 * mono uppercase green eyebrow -> commanding 44px H2 -> concise lede + optional external links.
 */
export function SectionOpener({
  eyebrow,
  title,
  mutedLead,
  description,
  headingId,
  badge,
  links,
  actions,
  align = "left",
  className = "mb-10 md:mb-12",
}: {
  eyebrow?: string;
  title: React.ReactNode;
  mutedLead?: string;
  description?: React.ReactNode;
  headingId?: string;
  badge?: string;
  links?: ReadonlyArray<{ href: string; label: string }>;
  actions?: React.ReactNode;
  align?: "left" | "center";
  className?: string;
}) {
  const centered = align === "center";
  return (
    <div
      className={`${className} ${
        centered
          ? "mx-auto max-w-2xl text-center"
          : "flex flex-col gap-5 md:flex-row md:items-end md:justify-between"
      }`}
    >
      <div className={`space-y-3 ${centered ? "" : "max-w-2xl"}`}>
        {eyebrow ? (
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-accent-text">
            {eyebrow}
          </p>
        ) : null}
        <div className={`flex flex-wrap items-center gap-3 ${centered ? "justify-center" : ""}`}>
          <h2
            id={headingId}
            className="font-display text-3xl font-semibold tracking-[-0.025em] leading-[1.1] text-foreground sm:text-4xl md:text-[42px]"
          >
            {mutedLead ? (
              <>
                <span className="text-white/45">{mutedLead}</span>{" "}
              </>
            ) : null}
            {title}
          </h2>
          {badge ? (
            <span className="rounded-full border border-brand-green/40 bg-brand-green/20 px-2.5 py-0.5 text-xs text-accent-text">
              {badge}
            </span>
          ) : null}
        </div>
        {description ? (
          <p
            className={`text-base leading-relaxed text-pretty text-muted-foreground ${
              centered ? "mx-auto max-w-lg" : "max-w-xl"
            }`}
          >
            {description}
          </p>
        ) : null}
        {links && links.length > 0 ? (
          <div className="flex flex-wrap gap-x-5 gap-y-1.5 pt-1 text-xs">
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-white/55 transition-colors hover:text-accent-text"
              >
                {link.label}
                <ExternalLink className="h-3 w-3" />
              </a>
            ))}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div> : null}
    </div>
  );
}

const GRID_COLUMNS = {
  "2": "grid-cols-1 lg:grid-cols-2",
  "3": "grid-cols-1 md:grid-cols-3",
  "2-3": "grid-cols-2 sm:grid-cols-3",
} as const;

/**
 * Hairline-divided shared-border cell grid. Uses 1px background gap so interior hairlines never
 * double up across responsive column counts.
 */
export function HairlineGrid({
  children,
  columns = "3",
  className = "",
  clipContents = true,
}: {
  children: React.ReactNode;
  columns?: keyof typeof GRID_COLUMNS;
  className?: string;
  clipContents?: boolean;
}) {
  return (
    <div
      className={`grid gap-px rounded-xl border border-white/[0.08] bg-white/[0.08] ${clipContents ? "overflow-hidden" : ""} ${GRID_COLUMNS[columns]} ${className}`}
    >
      {children}
    </div>
  );
}
