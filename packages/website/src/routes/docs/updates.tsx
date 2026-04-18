import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/docs/updates")({
  head: () => ({
    meta: pageMeta(
      "Updates - Paseo Docs",
      "How to update Paseo daemon and apps across web, desktop, and mobile.",
    ),
  }),
  component: UpdatesDocs,
});

function UpdatesDocs() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-medium font-title mb-4">Updates</h1>
        <p className="text-white/60 leading-relaxed">
          Keep your daemon and apps current to get the latest fixes and features.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Version compatibility</h2>
        <p className="text-white/60">
          For now, daemon and app versions should be kept in lockstep. If your daemon is version X,
          make sure your clients are also version X.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Update the daemon</h2>
        <p className="text-white/60">Install the latest CLI/daemon package globally:</p>
        <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm">
          <span className="text-muted-foreground select-none">$ </span>
          <span>npm install -g @getpaseo/cli@latest</span>
        </div>
        <p className="text-white/60">Then restart the daemon:</p>
        <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm">
          <span className="text-muted-foreground select-none">$ </span>
          <span>paseo daemon restart</span>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Web app</h2>
        <p className="text-white/60">
          <a
            href="https://app.paseo.sh"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white/80"
          >
            app.paseo.sh
          </a>{" "}
          is always up to date. No manual update needed.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Desktop app</h2>
        <p className="text-white/60">
          Download the latest desktop build from the GitHub releases page and install it over your
          current version.
        </p>
        <a
          href="https://github.com/getpaseo/paseo/releases"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-white/80"
        >
          Paseo releases
        </a>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Mobile apps</h2>
        <p className="text-white/60">
          Mobile apps are available on the App Store and Play Store. Update through your respective
          store. Store versions may lag behind the latest release due to review processes.
        </p>
      </section>
    </div>
  );
}
