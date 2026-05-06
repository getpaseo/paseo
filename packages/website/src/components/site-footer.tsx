import { appStoreUrl, playStoreUrl, webAppUrl } from "~/downloads";

interface SiteFooterProps {
  width?: "default" | "prose";
}

export function SiteFooter({ width = "default" }: SiteFooterProps) {
  const widthClasses =
    width === "prose" ? "max-w-prose p-6 md:p-12 md:pt-0" : "max-w-5xl p-6 md:p-20 md:pt-0";
  return (
    <footer className={`${widthClasses} mx-auto`}>
      <div className="border-t border-white/10 pt-8 pb-4 grid grid-cols-2 sm:grid-cols-4 gap-8 text-sm">
        <div className="space-y-3">
          <p className="text-white/60 font-medium">Product</p>
          <div className="space-y-2">
            <a href="/blog" className="block text-white/40 hover:text-white/60 transition-colors">
              Blog
            </a>
            <a href="/docs" className="block text-white/40 hover:text-white/60 transition-colors">
              Docs
            </a>
            <a
              href="/changelog"
              className="block text-white/40 hover:text-white/60 transition-colors"
            >
              Changelog
            </a>
            <a href="/cloud" className="block text-white/40 hover:text-white/60 transition-colors">
              Cloud
            </a>
            <a
              href="/docs/cli"
              className="block text-white/40 hover:text-white/60 transition-colors"
            >
              CLI
            </a>
            <a
              href="/privacy"
              className="block text-white/40 hover:text-white/60 transition-colors"
            >
              Privacy
            </a>
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-white/60 font-medium">Agents</p>
          <div className="space-y-2">
            <a
              href="/claude-code"
              className="block text-white/40 hover:text-white/60 transition-colors"
            >
              Claude Code
            </a>
            <a href="/codex" className="block text-white/40 hover:text-white/60 transition-colors">
              Codex
            </a>
            <a
              href="/opencode"
              className="block text-white/40 hover:text-white/60 transition-colors"
            >
              OpenCode
            </a>
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-white/60 font-medium">Community</p>
          <div className="space-y-2">
            <a
              href="https://discord.gg/jz8T2uahpH"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-white/40 hover:text-white/60 transition-colors"
            >
              Discord
            </a>
            <a
              href="https://github.com/getpaseo/paseo"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-white/40 hover:text-white/60 transition-colors"
            >
              GitHub
            </a>
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-white/60 font-medium">Download</p>
          <div className="space-y-2">
            <a
              href={appStoreUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-white/40 hover:text-white/60 transition-colors"
            >
              App Store
            </a>
            <a
              href={playStoreUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-white/40 hover:text-white/60 transition-colors"
            >
              Google Play
            </a>
            <a
              href="https://github.com/getpaseo/paseo/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-white/40 hover:text-white/60 transition-colors"
            >
              Desktop
            </a>
            <a
              href={webAppUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-white/40 hover:text-white/60 transition-colors"
            >
              Web App
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
