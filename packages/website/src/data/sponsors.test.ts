import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPONSORS, sponsorHref } from "./sponsors";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const WEBSITE_PUBLIC = fileURLToPath(new URL("../../public", import.meta.url));
const READMES = ["README.md", "README.zh-CN.md", "README.ja.md", "README.ko.md"];

describe("sponsorHref", () => {
  it("tags the link with the placement it is shown in", () => {
    const sponsor = { name: "Acme", url: "https://acme.dev", logo: { onDark: "", onLight: "" } };

    expect(sponsorHref(sponsor, "website")).toBe(
      "https://acme.dev/?utm_source=paseo&utm_medium=website&utm_campaign=sponsor",
    );
    expect(sponsorHref(sponsor, "x")).toBe(
      "https://acme.dev/?utm_source=paseo&utm_medium=x&utm_campaign=sponsor",
    );
  });
});

describe("SPONSORS", () => {
  it.each(SPONSORS)("ships both logo inks for $name", (sponsor) => {
    expect(existsSync(`${WEBSITE_PUBLIC}${sponsor.logo.onDark}`)).toBe(true);
    expect(existsSync(`${WEBSITE_PUBLIC}${sponsor.logo.onLight}`)).toBe(true);
  });

  it.each(READMES)("are linked from %s in the same order", (readme) => {
    const text = readFileSync(`${REPO_ROOT}${readme}`, "utf8");
    const sponsorsSection = text
      .slice(text.indexOf("<!-- Sponsor logos go here"))
      .split("\n## ")[0];
    const entries = [
      ...sponsorsSection.matchAll(
        /<a href="([^"]+)"><picture><source media="\(prefers-color-scheme: dark\)" srcset="([^"]+)"><img src="([^"]+)"/g,
      ),
    ].map(([, href, onDark, onLight]) => ({ href, onDark, onLight }));

    expect(entries).toEqual(
      SPONSORS.map((sponsor) => ({
        href: sponsorHref(sponsor, "readme"),
        onDark: `https://paseo.sh${sponsor.logo.onDark}`,
        onLight: `https://paseo.sh${sponsor.logo.onLight}`,
      })),
    );
  });
});
