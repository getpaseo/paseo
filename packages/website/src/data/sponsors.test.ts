import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPONSORS, sponsorHref } from "./sponsors";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const WEBSITE_PUBLIC = fileURLToPath(new URL("../../public", import.meta.url));
const READMES = ["README.md", "README.zh-CN.md", "README.ja.md", "README.ko.md"];
const README_SPONSOR_CELLS = 3;
const SPONSOR_PAGE_URL = "https://paseo.sh/sponsor";

describe("sponsorHref", () => {
  it("tags the link with the placement it is shown in", () => {
    const sponsor = {
      name: "Acme",
      url: "https://acme.dev",
      logo: { onDark: "", onLight: "" },
      description: "",
    };

    expect(sponsorHref(sponsor, "website")).toBe(
      "https://acme.dev/?utm_source=paseo&utm_medium=website&utm_campaign=sponsor",
    );
    expect(sponsorHref(sponsor, "x")).toBe(
      "https://acme.dev/?utm_source=paseo&utm_medium=x&utm_campaign=sponsor",
    );
  });
});

function readmeSponsorCells(readme: string) {
  const text = readFileSync(`${REPO_ROOT}${readme}`, "utf8");
  const table = text.slice(text.indexOf("<!-- Sponsors:")).split("</table>")[0];
  return [...table.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(([, cell]) => {
    const logo = cell.match(
      /^<a href="([^"]+)"><picture><source media="\(prefers-color-scheme: dark\)" srcset="([^"]+)"><img src="([^"]+)"[^>]*><\/picture><\/a><br><sub>([^<]+)<\/sub>$/,
    );
    if (logo) {
      const [, href, onDark, onLight, description] = logo;
      return { href, onDark, onLight, description };
    }
    return { invite: cell.match(/^<a href="([^"]+)">/)?.[1] };
  });
}

describe("SPONSORS", () => {
  it.each(SPONSORS)("ships both logo inks for $name", (sponsor) => {
    expect(existsSync(`${WEBSITE_PUBLIC}${sponsor.logo.onDark}`)).toBe(true);
    expect(existsSync(`${WEBSITE_PUBLIC}${sponsor.logo.onLight}`)).toBe(true);
  });

  it.each(READMES)("fill the sponsors table in %s, followed by invitations", (readme) => {
    const openCells = Math.max(0, README_SPONSOR_CELLS - SPONSORS.length);

    expect(readmeSponsorCells(readme)).toEqual([
      ...SPONSORS.map((sponsor) => ({
        href: sponsorHref(sponsor, "readme"),
        onDark: `packages/website/public${sponsor.logo.onDark}`,
        onLight: `packages/website/public${sponsor.logo.onLight}`,
        description: sponsor.description,
      })),
      ...Array.from({ length: openCells }, () => ({ invite: SPONSOR_PAGE_URL })),
    ]);
  });
});
