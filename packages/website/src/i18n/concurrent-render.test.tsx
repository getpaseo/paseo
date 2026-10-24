import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Suspense, use } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { PassThrough } from "node:stream";
import { useTranslation } from "react-i18next";
import { describe, expect, it } from "vitest";
import { getTranslator, LocaleProvider } from "~/i18n";

/** A promise the test settles by hand, so two renders can be interleaved deterministically. */
function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Suspends until `waitFor` settles, then reads copy, as a page waiting on data does. */
function Navigation({ waitFor }: { waitFor: Promise<void> }) {
  use(waitFor);
  const { t } = useTranslation();
  return <nav>{`${t("nav.docs")}|${t("nav.changelog")}`}</nav>;
}

async function startRender(url: string, waitFor: Promise<void>) {
  const rootRoute = createRootRoute();
  const localeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "{-$locale}",
    component: () => (
      <LocaleProvider>
        <Suspense fallback={null}>
          <Navigation waitFor={waitFor} />
        </Suspense>
      </LocaleProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([localeRoute]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  let html = "";
  const output = new PassThrough();
  output.on("data", (chunk: Buffer) => {
    html += chunk.toString();
  });
  const finished = new Promise<string>((resolve, reject) => {
    output.on("end", () => resolve(html));
    renderToPipeableStream(<RouterProvider router={router} />, { onShellError: reject }).pipe(
      output,
    );
  });
  return () => finished;
}

describe("concurrent requests in different languages", () => {
  it("each render with their own language when their renders interleave", async () => {
    const chineseData = gate();
    const englishData = gate();
    const chinese = await startRender("/zh-CN", chineseData.promise);
    const english = await startRender("/", englishData.promise);

    englishData.open();
    const englishHtml = await english();
    chineseData.open();
    const chineseHtml = await chinese();

    expect(englishHtml).toContain("Docs|Changelog");
    expect(chineseHtml).toContain("文档|更新日志");
    expect(chineseHtml).not.toContain("Docs");
  });

  it("translate outside React without one language leaking into the other", () => {
    const chinese = getTranslator("zh-CN");
    const english = getTranslator("en");

    expect([chinese("nav.docs"), english("nav.docs"), chinese("nav.docs")]).toEqual([
      "文档",
      "Docs",
      "文档",
    ]);
  });
});
