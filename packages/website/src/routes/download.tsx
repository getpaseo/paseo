import { Link, createFileRoute } from "@tanstack/react-router";
import { CommandDialog } from "~/components/command-dialog";
import { pageMeta } from "~/meta";
import {
  downloadUrls,
  appStoreUrl,
  playStoreUrl,
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
      "Download - Paseo",
      "Download Paseo for macOS, Windows, Linux, iOS, and Android. Your dev environment, in your pocket.",
    ),
  }),
  component: Download,
});

function Download() {
  const { version } = useRelease();
  const urls = downloadUrls(version);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto p-6 md:p-12">
        <header className="flex items-center justify-between gap-4 mb-12">
          <Link to="/" className="flex items-center gap-3">
            <img src="/logo.svg" alt="Paseo" className="w-6 h-6" />
            <span className="text-lg font-medium">Paseo</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link
              to="/docs"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Docs
            </Link>
            <Link
              to="/changelog"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Changelog
            </Link>
            <a
              href="https://discord.gg/jz8T2uahpH"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Discord"
              className="text-muted-foreground hover:text-foreground transition-colors inline-flex items-center"
            >
              <svg
                role="img"
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
              </svg>
            </a>
            <a
              href="https://github.com/getpaseo/paseo"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub"
              className="text-muted-foreground hover:text-foreground transition-colors inline-flex items-center"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M12 0C5.37 0 0 5.484 0 12.252c0 5.418 3.438 10.013 8.205 11.637.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.738-4.042-1.61-4.042-1.61-.546-1.403-1.333-1.776-1.333-1.776-1.089-.756.084-.741.084-.741 1.205.087 1.838 1.262 1.838 1.262 1.07 1.87 2.809 1.33 3.495 1.017.108-.79.417-1.33.76-1.636-2.665-.31-5.467-1.35-5.467-6.005 0-1.327.465-2.413 1.235-3.262-.124-.31-.535-1.556.117-3.243 0 0 1.008-.33 3.3 1.248a11.2 11.2 0 0 1 3.003-.404c1.02.005 2.045.138 3.003.404 2.29-1.578 3.297-1.248 3.297-1.248.653 1.687.242 2.933.118 3.243.77.85 1.233 1.935 1.233 3.262 0 4.667-2.807 5.692-5.48 5.995.43.38.823 1.133.823 2.285 0 1.65-.015 2.98-.015 3.386 0 .315.218.694.825.576C20.565 22.26 24 17.667 24 12.252 24 5.484 18.627 0 12 0z" />
              </svg>
            </a>
          </div>
        </header>

        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight mb-2">Download</h1>
        <p className="text-muted-foreground mb-10">v{version}</p>

        {/* Desktop */}
        <section className="rounded-xl border border-border bg-card/40 p-6 md:p-8 mb-6">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-semibold">Desktop</h2>
            <MonitorIcon className="h-5 w-5 text-muted-foreground" />
          </div>

          <div className="divide-y divide-border">
            {/* macOS */}
            <div className="flex items-center justify-between py-5 first:pt-0 last:pb-0">
              <div className="flex items-center gap-3">
                <AppleIcon className="h-5 w-5 text-foreground" />
                <span className="font-medium">macOS</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <DownloadPill href={urls.macAppleSilicon} label="Apple Silicon" />
                <DownloadPill href={urls.macIntel} label="Intel" />
                <CommandDialog
                  trigger={
                    <span className="inline-flex items-center justify-center rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background hover:bg-foreground/85 transition-colors">
                      Homebrew
                    </span>
                  }
                  title="Install via Homebrew"
                  command="brew install --cask paseo"
                />
              </div>
            </div>

            {/* Windows */}
            <div className="flex items-center justify-between py-5 first:pt-0 last:pb-0">
              <div className="flex items-center gap-3">
                <WindowsIcon className="h-5 w-5 text-foreground" />
                <span className="font-medium">Windows</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <DownloadPill href={urls.windowsExe} label="Download" />
              </div>
            </div>

            {/* Linux */}
            <div className="flex items-center justify-between py-5 first:pt-0 last:pb-0">
              <div className="flex items-center gap-3">
                <LinuxIcon className="h-5 w-5 text-foreground" />
                <span className="font-medium">Linux</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <DownloadPill href={urls.linuxAppImage} label="AppImage" />
                <DownloadPill href={urls.linuxDeb} label="DEB" />
                <DownloadPill href={urls.linuxRpm} label="RPM" />
              </div>
            </div>
          </div>
        </section>

        {/* Mobile */}
        <section className="rounded-xl border border-border bg-card/40 p-6 md:p-8 mb-6">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-semibold">Mobile</h2>
            <PhoneIcon className="h-5 w-5 text-muted-foreground" />
          </div>

          <div className="divide-y divide-border">
            {/* Android */}
            <div className="flex items-center justify-between py-5 first:pt-0 last:pb-0">
              <div className="flex items-center gap-3">
                <AndroidIcon className="h-5 w-5 text-foreground" />
                <span className="font-medium">Android</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <DownloadPill href={playStoreUrl} label="Play Store" external />
                <DownloadPill href={urls.androidApk} label="APK" />
              </div>
            </div>

            {/* iOS */}
            <div className="flex items-center justify-between py-5 first:pt-0 last:pb-0">
              <div className="flex items-center gap-3">
                <AppleIcon className="h-5 w-5 text-foreground" />
                <span className="font-medium">iOS</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <DownloadPill href={appStoreUrl} label="App Store" external />
              </div>
            </div>
          </div>
        </section>

        {/* Web & CLI */}
        <section className="rounded-xl border border-border bg-card/40 p-6 md:p-8">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-semibold">Web & CLI</h2>
            <TerminalIcon className="h-5 w-5 text-muted-foreground" />
          </div>

          <div className="divide-y divide-border">
            <div className="flex items-center justify-between py-5 first:pt-0 last:pb-0">
              <div className="flex items-center gap-3">
                <GlobeIcon className="h-5 w-5 text-foreground" />
                <span className="font-medium">Web App</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <DownloadPill href={webAppUrl} label="Open" external />
              </div>
            </div>

            <div className="flex items-center justify-between py-5 first:pt-0 last:pb-0">
              <div className="flex items-center gap-3">
                <TerminalIcon className="h-5 w-5 text-foreground" />
                <span className="font-medium">CLI</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <code className="text-sm text-muted-foreground font-mono bg-muted px-3 py-1.5 rounded-lg">
                  npm install -g @getpaseo/cli
                </code>
              </div>
            </div>
          </div>
        </section>

        <p className="text-center text-xs text-muted-foreground mt-8">
          All releases are available on{" "}
          <a
            href="https://github.com/getpaseo/paseo/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground transition-colors"
          >
            GitHub
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function DownloadPill({
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
      className="inline-flex items-center justify-center rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background hover:bg-foreground/85 transition-colors"
    >
      {label}
      {external && (
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
      )}
    </a>
  );
}

function MonitorIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  );
}

function PhoneIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
      <path d="M12 18h.01" />
    </svg>
  );
}
