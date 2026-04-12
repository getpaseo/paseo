import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { getLatestRelease } from "~/release";
import { getStarCount } from "~/stars";

interface ReleaseContext {
  version: string;
}

interface StarsContext {
  stars: string;
}

const ReleaseCtx = createContext<ReleaseContext>({ version: "" });
const StarsCtx = createContext<StarsContext>({ stars: "" });

export function useRelease(): ReleaseContext {
  return useContext(ReleaseCtx);
}

export function useStars(): StarsContext {
  return useContext(StarsCtx);
}

export const Route = createRootRoute({
  loader: async () => {
    const [release, stars] = await Promise.all([getLatestRelease(), getStarCount()]);
    return { ...release, ...stars };
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
    <ReleaseCtx value={data}>
      <StarsCtx value={data}>
        <RootDocument>
          <Outlet />
        </RootDocument>
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
        <script
          dangerouslySetInnerHTML={{
            __html: `window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()`,
          }}
        />
      </head>
      <body className="antialiased bg-background text-foreground">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
