/**
 * Homepage sponsor spots. This file is the inventory: the site shows one open
 * placeholder for every spot not listed in `HOMEPAGE_SPONSORS`.
 *
 * Approving a sponsor means three edits, or the site promises something it does
 * not deliver:
 *
 * 1. Add the entry below and drop its logo in `public/sponsors/`.
 * 2. Add the logo under the `## Sponsors` marker in `README.md`,
 *    `README.zh-CN.md`, `README.ja.md` and `README.ko.md`, in this same order.
 * 3. Remove all of it when the subscription ends.
 *
 * The Stripe payment link caps itself at `HOMEPAGE_SPOT_COUNT` completed
 * checkouts, and a checkout you decline and refund still counts against that
 * cap. When you refund one, raise the link's completed-session limit by one, or
 * the page will offer a spot the link refuses to sell.
 */
export interface HomepageSponsor {
  name: string;
  href: string;
  /** Path under `public/`, e.g. `/sponsors/acme.svg`. Keep logos monochrome white. */
  logo: string;
}

export const HOMEPAGE_SPONSORS: ReadonlyArray<HomepageSponsor> = [];

export const HOMEPAGE_SPOT_COUNT = 4;
export const HOMEPAGE_SPOT_PRICE = "$500";

/** Stripe Payment Link for the monthly spot subscription. */
export const SPONSOR_SPOT_CHECKOUT_URL = "https://buy.stripe.com/8x24gBczR7LNaokcve2sM00";

export const SPONSOR_CONTACT_EMAIL = "hello@paseo.sh";

export const GITHUB_SPONSORS_URL = "https://github.com/sponsors/boudra";
export const OPEN_COLLECTIVE_URL =
  "https://opencollective.com/paseo-ai/donate?interval=month&amount=10&contributeAs=me";
export const BUY_ME_A_COFFEE_URL = "https://buymeacoffee.com/paseo";

export function openSpotCount(): number {
  return Math.max(0, HOMEPAGE_SPOT_COUNT - HOMEPAGE_SPONSORS.length);
}
