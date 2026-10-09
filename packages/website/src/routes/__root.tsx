import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import type { ReleaseChannels, ReleaseInfo } from "~/latest-release";
import type { VisitorPlatform } from "~/platform";
import { getVisitorPlatform } from "~/platform";
import { getLatestRelease } from "~/release";
import { getStarCount } from "~/stars";

interface StarsContext {
  stars: string;
}

const ReleaseCtx = createContext<ReleaseChannels>({
  stable: {
    version: "",
    linuxAppImageAsset: "",
    windowsX64Asset: null,
    windowsArm64Asset: null,
  },
  beta: null,
});
const StarsCtx = createContext<StarsContext>({ stars: "" });
const PlatformCtx = createContext<VisitorPlatform>("mac");

const PLAUSIBLE_INIT_SCRIPT = {
  __html: `window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()`,
};

/** The latest stable release. Everything on the site points here by default. */
export function useRelease(): ReleaseInfo {
  return useContext(ReleaseCtx).stable;
}

/** The current beta, or null when there is no beta ahead of stable. */
export function useBetaRelease(): ReleaseInfo | null {
  return useContext(ReleaseCtx).beta;
}

export function useStars(): StarsContext {
  return useContext(StarsCtx);
}

/** The platform the visitor is browsing from, resolved from the request user agent during SSR. */
export function useVisitorPlatform(): VisitorPlatform {
  return useContext(PlatformCtx);
}

export const Route = createRootRoute({
  loader: async () => {
    const [release, stars, platform] = await Promise.all([
      getLatestRelease(),
      getStarCount(),
      getVisitorPlatform(),
    ]);
    return { release, platform, ...stars };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#101615" },
      { property: "og:site_name", content: "Paseo" },
      { property: "og:type", content: "website" },
      { property: "og:image", content: "https://paseo.sh/og-image.png" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: "https://paseo.sh/og-image.png" },
    ],
    links: [
      { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/favicon.svg" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  const data = Route.useLoaderData();
  return (
    <ReleaseCtx value={data.release}>
      <StarsCtx value={data}>
        <PlatformCtx value={data.platform}>
          <RootDocument>
            <Outlet />
          </RootDocument>
        </PlatformCtx>
      </StarsCtx>
    </ReleaseCtx>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script async src="https://plausible.io/js/pa-cKNUoWbeH_Iksb2fh82s3.js" />
        <script dangerouslySetInnerHTML={PLAUSIBLE_INIT_SCRIPT} />
      </head>
      <body className="antialiased bg-background text-foreground">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
