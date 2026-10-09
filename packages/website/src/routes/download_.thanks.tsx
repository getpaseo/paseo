import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { DiscordIcon, GitHubIcon, RedditIcon } from "~/components/brand-icons";
import { SiteShell } from "~/components/site-shell";
import { SponsorSection } from "~/components/sponsorship";
import { parseReleaseAssetUrl } from "~/downloads";
import { pageMeta } from "~/meta";
import "~/styles.css";

interface ThanksSearch {
  file?: string;
}

export const Route = createFileRoute("/download_/thanks")({
  validateSearch: (search: Record<string, unknown>): ThanksSearch => {
    const file = parseReleaseAssetUrl(search.file);
    return file ? { file } : {};
  },
  head: () =>
    pageMeta(
      "Thanks for downloading Paseo",
      "Your Paseo download is starting. Join the community on Discord, GitHub, and Reddit, or sponsor Paseo.",
      "/download/thanks",
    ),
  component: DownloadThanks,
});

const COMMUNITY = [
  {
    name: "Discord",
    icon: <DiscordIcon className="h-6 w-6" />,
    body: "Get help and share feedback.",
    href: "https://discord.gg/jz8T2uahpH",
  },
  {
    name: "GitHub",
    icon: <GitHubIcon className="h-6 w-6" />,
    body: "Star, report issues, contribute.",
    href: "https://github.com/getpaseo/paseo",
  },
  {
    name: "Reddit",
    icon: <RedditIcon className="h-6 w-6" />,
    body: "Workflows and questions.",
    href: "https://www.reddit.com/r/PaseoAI/",
  },
];

function DownloadThanks() {
  const { file } = Route.useSearch();

  useEffect(() => {
    if (file) window.location.assign(file);
  }, [file]);

  return (
    <SiteShell width="default">
      <h1 className="text-3xl font-medium tracking-tight mb-4">Thanks for downloading Paseo</h1>
      <p className="text-lg text-white/70 leading-relaxed max-w-2xl">
        Get help, share feedback, and follow along.
      </p>
      {file && (
        <p className="text-white/40 text-sm mt-3">
          Download didn&apos;t start?{" "}
          <a href={file} className="underline hover:text-white/80">
            Try again
          </a>
        </p>
      )}

      <div className="space-y-20 mt-16">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {COMMUNITY.map((item) => (
            <a
              key={item.name}
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4 transition-colors hover:border-white/20 hover:bg-white/[0.05]"
            >
              <span className="flex text-white/80">{item.icon}</span>
              <span className="min-w-0">
                <span className="block font-medium [text-box:trim-start_cap_alphabetic]">
                  {item.name}
                </span>
                <span className="block text-xs text-muted-foreground">{item.body}</span>
              </span>
            </a>
          ))}
        </div>
        <SponsorSection />
      </div>
    </SiteShell>
  );
}
