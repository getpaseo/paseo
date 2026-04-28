import { createFileRoute } from "@tanstack/react-router";
import { CommandDialog } from "~/components/command-dialog";
import { pageMeta } from "~/meta";
import { SiteHeader } from "~/components/site-header";
import { PlansGrid } from "~/components/plans";
import {
  downloadUrls,
  webAppUrl,
  AppleIcon,
  AndroidIcon,
  WindowsIcon,
  LinuxIcon,
  TerminalIcon,
  GlobeIcon,
} from "~/downloads";
import { useRelease } from "~/routes/__root";
import "~/styles.css";

export const Route = createFileRoute("/download")({
  head: () => ({
    meta: pageMeta(
      "Download — Hubcode",
      "Download the Hubcode desktop app for macOS or Linux, run the Web App in your browser, or install the CLI on any Unix-like host. Windows, iOS and Android builds are on the way.",
    ),
  }),
  component: Download,
});

function Download() {
  const { version } = useRelease();
  const urls = downloadUrls(version);

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 h-[420px] w-[900px] rounded-full opacity-30 blur-[140px]"
        style={{
          background: "radial-gradient(closest-side, rgba(216,27,96,0.55), rgba(216,27,96,0) 70%)",
        }}
      />
      <div className="max-w-6xl mx-auto p-6 md:p-12 relative">
        <div className="max-w-3xl mx-auto">
          <div className="mb-12">
            <SiteHeader />
          </div>

          <h1 className="text-3xl md:text-5xl font-medium tracking-tight mb-2">Download</h1>
          <p className="text-sm text-white/50 mb-10">v{version}</p>

          {/* Available now */}
          <section className="rounded-xl border border-white/10 bg-white/[0.02] p-6 md:p-8 mb-6 space-y-6">
            <div className="flex items-center gap-2">
              <span className="block h-[2px] w-8 rounded-full bg-gradient-to-r from-[#D81B60] to-[#FF4081]" />
              <h2 className="text-xl font-medium">Available now</h2>
            </div>

            <div className="divide-y divide-white/5">
              <Row
                icon={<AppleIcon className="h-5 w-5" />}
                name="macOS"
                note="Apple Silicon and Intel"
                actions={
                  <>
                    <PrimaryPill href={urls.macAppleSilicon} label="Apple Silicon" />
                    <SecondaryPill href={urls.macIntel} label="Intel" />
                    <CommandDialog
                      trigger={
                        <span className="inline-flex items-center justify-center rounded-full border border-white/15 px-4 py-1.5 text-sm font-medium text-white hover:bg-white/5 transition-colors cursor-pointer">
                          Homebrew
                        </span>
                      }
                      title="Install via Homebrew"
                      command="brew install --cask hubcode"
                    />
                  </>
                }
              />
              <Row
                icon={<LinuxIcon className="h-5 w-5" />}
                name="Linux"
                note="x86_64 AppImage and Debian package."
                actions={
                  <>
                    <PrimaryPill href={urls.linuxAppImage} label="AppImage" />
                    <SecondaryPill href={urls.linuxDeb} label="DEB" />
                  </>
                }
              />
              <Row
                icon={<GlobeIcon className="h-5 w-5" />}
                name="Web App"
                note="Runs in any modern browser. Connects to your local daemon over LAN or the optional E2E relay."
                actions={<PrimaryPill href={webAppUrl} label="Open" external />}
              />
              <Row
                icon={<TerminalIcon className="h-5 w-5" />}
                name="CLI / headless"
                note="Install on a server, VM, or any host without a desktop. Pair with a phone or another machine via QR code."
                actions={
                  <CommandDialog
                    trigger={
                      <span className="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-[#D81B60] to-[#FF4081] px-4 py-1.5 text-sm font-medium text-white shadow-[0_0_18px_-4px_rgba(216,27,96,0.7)] hover:from-[#E91E63] hover:to-[#FF6090] transition-all cursor-pointer">
                        npm install
                      </span>
                    }
                    title="Install the Hubcode CLI"
                    command="npm install -g @hubcode/cli && hubcode"
                    footnote={
                      <>
                        Requires Node.js 18+. Run{" "}
                        <span className="font-mono text-white/40">hubcode</span> to start the
                        daemon.
                      </>
                    }
                  />
                }
              />
            </div>
          </section>

          {/* Coming soon */}
          <section className="rounded-xl border border-white/10 bg-white/[0.01] p-6 md:p-8">
            <div className="flex items-center gap-2 mb-6">
              <span className="block h-[2px] w-8 rounded-full bg-white/20" />
              <h2 className="text-xl font-medium text-white/80">Coming soon</h2>
            </div>
            <div className="divide-y divide-white/5">
              <Row
                icon={<WindowsIcon className="h-5 w-5 text-white/50" />}
                name="Windows"
                note="Use the CLI for now."
                actions={<ComingSoonPill />}
                dim
              />
              <Row
                icon={<AppleIcon className="h-5 w-5 text-white/50" />}
                name="iOS"
                note="Native app submitted to App Store review."
                actions={<ComingSoonPill />}
                dim
              />
              <Row
                icon={<AndroidIcon className="h-5 w-5 text-white/50" />}
                name="Android"
                note="Play Store + APK coming."
                actions={<ComingSoonPill />}
                dim
              />
            </div>
          </section>

          <p className="text-center text-xs text-white/40 mt-8">
            All releases are also published on{" "}
            <a
              href="https://github.com/hubtool/hubcode/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-[#FF80AB] hover:text-[#FF4081] transition-colors"
            >
              GitHub
            </a>
            .
          </p>
        </div>

        {/* Plans */}
        <section className="mt-20">
          <div className="text-center max-w-2xl mx-auto mb-10 space-y-3">
            <span className="inline-flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-[#FF80AB]">
              <span className="block h-[2px] w-8 rounded-full bg-gradient-to-r from-[#D81B60] to-[#FF4081]" />
              Plans
            </span>
            <h2 className="text-2xl md:text-3xl font-medium tracking-tight">
              Free with your keys, Pro for the Hubtool agent
            </h2>
            <p className="text-sm text-white/55">
              The download is free on every plan. Pro and Enterprise unlock the curated Hubtool
              agent, organization chat, audit log, SSO and team-scale capacity.
            </p>
          </div>
          <PlansGrid />
          <div className="mt-6 text-center">
            <a href="/pricing" className="text-xs text-[#FF80AB] hover:text-[#FF4081] underline">
              See the full plan comparison →
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}

function Row({
  icon,
  name,
  note,
  actions,
  dim,
}: {
  icon: React.ReactNode;
  name: string;
  note?: string;
  actions: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 py-5 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-white/80">{icon}</span>
        <div className="space-y-0.5">
          <p className={`font-medium ${dim ? "text-white/70" : "text-white"}`}>{name}</p>
          {note ? <p className="text-xs text-white/40 max-w-md">{note}</p> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

function PrimaryPill({
  href,
  label,
  external,
}: {
  href: string;
  label: string;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-[#D81B60] to-[#FF4081] px-4 py-1.5 text-sm font-medium text-white shadow-[0_0_18px_-4px_rgba(216,27,96,0.7)] hover:from-[#E91E63] hover:to-[#FF6090] transition-all"
    >
      {label}
      {external && <ExternalArrow />}
    </a>
  );
}

function SecondaryPill({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center justify-center rounded-full border border-white/15 px-4 py-1.5 text-sm font-medium text-white hover:bg-white/5 transition-colors"
    >
      {label}
    </a>
  );
}

function ComingSoonPill() {
  return (
    <span className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs font-medium text-white/50">
      Coming soon
    </span>
  );
}

function ExternalArrow() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="ml-1.5 h-3 w-3"
      aria-hidden="true"
    >
      <path d="M7 17L17 7" />
      <path d="M7 7h10v10" />
    </svg>
  );
}
