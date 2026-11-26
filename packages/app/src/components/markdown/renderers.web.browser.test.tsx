import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import {
  MARKDOWN_COPY_IGNORE_ATTRIBUTE,
  MARKDOWN_COPY_TAG_ATTRIBUTE,
} from "@/assistant-selection-copy/markup";
import type { ToastApi } from "@/components/toast-host";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { i18n } from "@/i18n/i18next";
import { darkTheme } from "@/styles/theme";
import { prepareMarkdownSource } from "./source";
import { createMarkdownStyles } from "./styles";
import { WEB_RENDERERS } from "./renderers.web";

const Link = WEB_RENDERERS.link;
const LINK_TEXT = "src/index.ts";
const MD4C_FLAGS = { latexMath: false, hardSoftBreaks: true, admonitions: true };
const toast: ToastApi = { show: () => () => {}, copied: () => {}, error: () => {} };

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function anchorPropsFor(url: string) {
  return { href: url };
}

function renderAnchor(link: { url: string; sourceType?: "markdown" | "text" | "inline-code" }) {
  if (!Link) {
    throw new Error("Expected a web link renderer");
  }
  const anchorProps = anchorPropsFor(link.url);
  const client = new QueryClient();
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Link link={link} anchorProps={anchorProps}>
          {LINK_TEXT}
        </Link>
      </QueryClientProvider>,
    ),
  );
  const anchor = container.querySelector("a");
  if (!anchor) {
    throw new Error("Expected a rendered link");
  }
  return anchor;
}

it("marks a link it recognized from a path for selection copy", () => {
  const anchor = renderAnchor({ url: LINK_TEXT, sourceType: "text" });
  expect(anchor.getAttribute("href")).toBe(LINK_TEXT);
  expect(anchor.getAttribute("data-paseo-markdown-recognized-link")).toBe("true");
});

it("leaves an authored link wrapped", () => {
  const anchor = renderAnchor({ url: "https://example.test/doc", sourceType: "markdown" });
  expect(anchor.hasAttribute("data-paseo-markdown-recognized-link")).toBe(false);
});

describe("bidirectional Markdown rendering", () => {
  async function renderMarkdown(source: string, dir: "auto" | "ltr" | "rtl" = "auto") {
    const client = new QueryClient();
    const prepared = prepareMarkdownSource(source, "/repo");
    const { markdownStyle, containerStyle } = createMarkdownStyles(darkTheme, { blockGap: 16 });
    act(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <ToastApiProvider api={toast}>
            <QueryClientProvider client={client}>
              <EnrichedMarkdownText
                markdown={prepared.render()}
                markdownStyle={markdownStyle}
                containerStyle={containerStyle}
                flavor="github"
                dir={dir}
                md4cFlags={MD4C_FLAGS}
                linkRecognition={prepared.linkRecognition}
                enableTaskListItemToggle={false}
                renderers={WEB_RENDERERS}
              />
            </QueryClientProvider>
          </ToastApiProvider>
        </I18nextProvider>,
      ),
    );
    await vi.waitFor(() => {
      const wrapper = container.querySelector(".enrm-text");
      expect(wrapper?.getAttribute("aria-busy")).toBe("false");
    });
  }

  it("skips per-block dir attributes for pure LTR documents", async () => {
    await renderMarkdown("# Heading\n\nPlain English paragraph.\n\n- Item one");
    expect(container.querySelector("h1")?.hasAttribute("dir")).toBe(false);
    expect(container.querySelector("p")?.hasAttribute("dir")).toBe(false);
    expect(container.querySelector("ul")?.hasAttribute("dir")).toBe(false);
  });

  it("resolves per-block direction for prose, inline code, links, and code blocks", async () => {
    const source = [
      "# عنوان رئيسي",
      "English paragraph.",
      "`useEffect` يشغل الدالة عند التحميل.",
      "agent يقوم بتشغيل الاختبارات الآن.",
      "```ts\n// تعليق\nconst value = 1;\n```",
      "راجع https://example.com ثم [التوثيق](https://example.com) الآن.",
    ].join("\n\n");

    await renderMarkdown(source);

    expect(container.querySelector("h1")?.getAttribute("dir")).toBe("rtl");

    const paragraphs = Array.from(container.querySelectorAll(":scope .enrm-text > p"));
    expect(paragraphs.map((p) => p.getAttribute("dir"))).toEqual(["ltr", "rtl", "rtl", "rtl"]);

    const inlineCode = paragraphs[1]?.querySelector("code");
    expect(inlineCode?.getAttribute("dir")).toBe("ltr");
    expect(getComputedStyle(inlineCode!).unicodeBidi).toBe("isolate");

    const codeBlock = container.querySelector(`[${MARKDOWN_COPY_TAG_ATTRIBUTE}="pre"]`);
    expect(codeBlock?.closest('[dir="ltr"]')).toBeTruthy();

    const links = Array.from(paragraphs[3]?.querySelectorAll("a") ?? []);
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("dir")).toBe("ltr");
    expect(getComputedStyle(links[0]!).unicodeBidi).toBe("isolate");
    expect(links[1]?.hasAttribute("dir")).toBe(false);
  });

  it("isolates list item text while keeping list markers and checkboxes aligned", async () => {
    const source = [
      "1. الخطوة الأولى\n2. English step!",
      "- [x] مهمة مكتملة\n- [ ] English task",
    ].join("\n\n");

    await renderMarkdown(source);

    const orderedList = container.querySelector("ol");
    expect(orderedList?.getAttribute("dir")).toBe("rtl");
    const orderedItems = Array.from(orderedList?.querySelectorAll("li") ?? []);
    expect(orderedItems[0]?.querySelector('span[dir="rtl"]')).toBeTruthy();
    expect(orderedItems[1]?.querySelector('span[dir="ltr"]')).toBeTruthy();

    const taskList = container.querySelector("ul");
    expect(taskList?.getAttribute("dir")).toBe("rtl");
    const taskCheckboxes = taskList?.querySelectorAll('input[type="checkbox"]') ?? [];
    expect(taskCheckboxes).toHaveLength(2);
    expect(taskCheckboxes[1]?.closest('span[dir="ltr"]')).toBeNull();
  });

  it("applies RTL direction to blockquotes, admonitions, and tables", async () => {
    const source = [
      "> ملاحظة مهمة جدا في الاقتباس",
      "> [!NOTE]\n> تنبيه مهم باللغة العربية",
      "| الاسم | المحاذاة |\n| --- | :--- |\n| src/app.ts | جاهز |",
    ].join("\n\n");

    await renderMarkdown(source);

    const quote = container.querySelector("blockquote");
    expect(quote?.getAttribute("dir")).toBe("rtl");
    expect(Number.parseFloat(getComputedStyle(quote!).borderRightWidth)).toBeGreaterThan(0);
    const quoteCopy = quote?.querySelector(`[${MARKDOWN_COPY_IGNORE_ATTRIBUTE}="true"]`);
    expect(quoteCopy).toBeTruthy();
    expect(getComputedStyle(quoteCopy!).left).not.toBe("auto");

    const admonition = container.querySelector(".enrm-admonition");
    expect(admonition?.getAttribute("dir")).toBe("rtl");

    const table = container.querySelector("table");
    expect(table?.parentElement?.getAttribute("dir")).toBe("rtl");
    const headerCells = Array.from(table?.querySelectorAll("th") ?? []);
    expect(headerCells[0]?.style.textAlign).toBe("start");
    expect(headerCells[1]?.style.textAlign).toBe("left");
    const firstBodyCell = table?.querySelector("tbody td");
    expect(firstBodyCell?.querySelector('a[dir="ltr"]')).toBeTruthy();
  });

  it("honors explicit root dir overrides without per-block auto detection", async () => {
    await renderMarkdown("Hello world\n\nمرحبا بالعالم", "rtl");
    const rootWrapper = container.querySelector(".enrm-text");
    expect(rootWrapper?.getAttribute("dir")).toBe("rtl");
    const paragraphs = Array.from(container.querySelectorAll("p"));
    expect(paragraphs.every((p) => !p.hasAttribute("dir"))).toBe(true);
  });
});
