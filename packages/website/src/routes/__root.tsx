import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { getLatestRelease } from "~/release";

interface ReleaseContext {
  version: string;
}

const ReleaseCtx = createContext<ReleaseContext>({ version: "" });

export function useRelease(): ReleaseContext {
  return useContext(ReleaseCtx);
}

export const Route = createRootRoute({
  loader: async () => {
    return getLatestRelease();
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
  const release = Route.useLoaderData();
  return (
    <ReleaseCtx value={release}>
      <RootDocument>
        <Outlet />
      </RootDocument>
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
