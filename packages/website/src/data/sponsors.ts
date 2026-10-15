/**
 * Company sponsors. This file is the inventory: every page of the site shows
 * these logos above the footer, and the open spots invite the next sponsor.
 *
 * Approving a sponsor means three edits, or the site promises something it does
 * not deliver:
 *
 * 1. Add the entry below and drop both logo inks in `public/sponsors/`.
 * 2. In the sponsors table after the intro of `README.md`, `README.zh-CN.md`,
 *    `README.ja.md` and `README.ko.md`, replace a "become a sponsor" cell with
 *    the logo and its description, in this same order, linked to `sponsorHref(sponsor, "readme")`
 *    with both inks referenced from `packages/website/public`, so the README
 *    renders from the repository and never waits on a site deploy.
 *    `sponsors.test.ts` fails until they match.
 * 3. Remove all of it when the subscription ends.
 *
 * The Stripe payment link caps itself at `SPONSOR_SPOT_COUNT` completed
 * checkouts, and a checkout you decline and refund still counts against that
 * cap. When you refund one, raise the link's completed-session limit by one, or
 * the page will offer a spot the link refuses to sell.
 */
export interface Sponsor {
  name: string;
  /** The sponsor's own URL, without tracking. Links go through `sponsorHref`. */
  url: string;
  /** Paths under `public/`, one per ground. Use the sponsor's official lockup. */
  logo: { onDark: string; onLight: string };
  /** What the product is, in a few words from the sponsor's own site. Shown under the logo. */
  description: string;
}

export const SPONSORS: ReadonlyArray<Sponsor> = [
  {
    name: "Hoplite",
    url: "https://hoplite.sh",
    logo: {
      onDark: "/sponsors/hoplite-on-dark.svg",
      onLight: "/sponsors/hoplite-on-light.svg",
    },
    description: "Cloud coding agents",
  },
];

/** Where a sponsor link is shown. Becomes the link's `utm_medium`. */
export type SponsorPlacement = "website" | "readme" | "discord" | "x";

export function sponsorHref(sponsor: Sponsor, placement: SponsorPlacement): string {
  const url = new URL(sponsor.url);
  url.searchParams.set("utm_source", "paseo");
  url.searchParams.set("utm_medium", placement);
  url.searchParams.set("utm_campaign", "sponsor");
  return url.toString();
}

export const SPONSOR_SPOT_COUNT = 4;
export const SPONSOR_SPOT_PRICE = "$500";

/** Stripe Payment Link for the monthly spot subscription. */
export const SPONSOR_SPOT_CHECKOUT_URL = "https://buy.stripe.com/8x24gBczR7LNaokcve2sM00";

export const SPONSOR_CONTACT_EMAIL = "hello@paseo.sh";

export const GITHUB_SPONSORS_URL = "https://github.com/sponsors/boudra";
export const OPEN_COLLECTIVE_URL =
  "https://opencollective.com/paseo-ai/donate?interval=month&amount=10&contributeAs=me";
export const BUY_ME_A_COFFEE_URL = "https://buymeacoffee.com/paseo";

export function openSpotCount(): number {
  return Math.max(0, SPONSOR_SPOT_COUNT - SPONSORS.length);
}
