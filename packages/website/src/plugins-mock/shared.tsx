import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { DocsMarkdown } from "~/components/docs-markdown";
import { formatInstalls, npmUrl, type Plugin } from "~/plugins";
import { PluginTile } from "~/plugins/plugin-tile";
import { BUILD_URL, type MockPlugin, readmeBody, SUBMIT_URL } from "./data";

export type DetailPlugin = MockPlugin & { readme: string };

export interface DirectionComponents {
  Directory: (props: { plugins: MockPlugin[] }) => ReactNode;
  List: (props: {
    plugins: MockPlugin[];
    category?: string;
    sort?: "new" | "installs";
  }) => ReactNode;
  Detail: (props: { plugin: DetailPlugin; plugins: MockPlugin[] }) => ReactNode;
}

export const QUIET_LINK = "text-sm text-muted-foreground transition-colors hover:text-foreground";
export const XS_LINK =
  "inline-flex items-center gap-1 text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground";

export function BuildSubmitLinks({ className = QUIET_LINK }: { className?: string }) {
  return (
    <>
      <a href={BUILD_URL} className={className}>
        Build a plugin
      </a>
      <a href={SUBMIT_URL} className={className}>
        Submit a plugin
      </a>
    </>
  );
}

export function installsLabel(plugin: Plugin): string {
  return `${formatInstalls(plugin.installs ?? 0)} installs`;
}

export { PluginTile };

/** First screenshot, or a quiet letter tile when the plugin has none. */
export function Shot({ plugin, className = "" }: { plugin: Plugin; className?: string }) {
  const url = plugin.screenshots[0];
  return (
    <div
      className={`overflow-hidden border border-white/10 bg-white/[0.03] ${className}`}
      aria-hidden
    >
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover object-left-top"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_30%_20%,rgba(35,153,86,0.12),transparent_60%)]">
          <PluginTile plugin={plugin} size="lg" />
        </div>
      )}
    </div>
  );
}

export function SourceLinks({
  plugin,
  className = XS_LINK,
}: {
  plugin: Plugin;
  className?: string;
}) {
  const npm = npmUrl(plugin);
  return (
    <>
      <a
        href={plugin.repository.url}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        Source
        <ExternalLink className="h-3 w-3" />
      </a>
      {npm && (
        <a href={npm} target="_blank" rel="noopener noreferrer" className={className}>
          npm
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </>
  );
}

export function Readme({ plugin }: { plugin: DetailPlugin }) {
  return <DocsMarkdown>{readmeBody(plugin.readme)}</DocsMarkdown>;
}

export function Screenshots({ plugin }: { plugin: Plugin }) {
  if (plugin.screenshots.length === 0) return null;
  return (
    <div className="-mx-6 flex gap-3 overflow-x-auto px-6 md:mx-0 md:px-0">
      {plugin.screenshots.map((url, index) => (
        <a
          key={url}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="aspect-video w-[85%] flex-shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] sm:w-[60%] lg:w-[calc(50%-0.375rem)]"
        >
          <img
            src={url}
            alt={`${plugin.name} screenshot ${index + 1}`}
            loading="lazy"
            className="h-full w-full object-cover object-top"
          />
        </a>
      ))}
    </div>
  );
}
