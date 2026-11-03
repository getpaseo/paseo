import { getAlternativePages } from "~/data/alternative-pages";
import { AGENT_PAGES, getAgentPage } from "~/data/agent-pages";
import { type Doc, getDocs } from "~/docs";
import { getTranslator, type Locale, localizePath, withLocalePrefix } from "~/i18n";

const SITE_URL = "https://paseo.sh";

interface LlmsCopy {
  preamble: string;
  docs: string;
  alternatives: string;
  agents: string;
  optional: string;
  /** Pages under "Optional", by language-neutral path. */
  pages: { path: string; title: string; description: string }[];
}

const COPY: Record<Locale, LlmsCopy> = {
  en: {
    preamble: `# Paseo

> Open source agentic development environment for desktop, mobile, web, and CLI.

Paseo is a full agentic development environment. For agent-driven development, it replaces your IDE: run coding agents, edit files, review diffs and pull requests, run tests in terminals, and check your app in the built-in desktop browser. Arrange agents, files, terminals, and browser tabs in split panes within a workspace.

Run many agents in parallel, each in its own git worktree and branch. Choose a provider and model for each task, inspect the results, and decide what to merge. Agents can also create worktrees, launch other agents, and communicate with them through Paseo's orchestration tools.

Agents run on your own machines with your existing tools, configuration, and credentials. Work from desktop, the full native iOS and Android app, a web browser, or the CLI. The desktop app starts its local daemon automatically. For remote work, run the daemon on another machine and connect directly or through the optional end-to-end encrypted relay.

Paseo supports Claude Code, Codex, GitHub Copilot, OpenCode, Pi, Antigravity, Muse Code, and additional ACP-compatible agents. The CLI, TypeScript SDK, and MCP tools expose agent and workspace operations for automation. Plugins extend providers, workflows, and the app's interface.

Distribution: native apps for Mac, Windows, Linux, iOS, and Android; web app; Homebrew; npm. Source: Apache-2.0 at https://github.com/getpaseo/paseo. Marketing site: https://paseo.sh.
`,
    docs: "Docs",
    alternatives: "Alternatives",
    agents: "Supported agents",
    optional: "Optional",
    pages: [
      {
        path: "/changelog",
        title: "Changelog",
        description: "Release notes for the Paseo daemon, CLI, desktop, and mobile apps.",
      },
      {
        path: "/download",
        title: "Download",
        description: "Install Paseo on Mac, Windows, Linux, iOS, Android, or run the web app.",
      },
      {
        path: "/hub",
        title: "Paseo Hub",
        description:
          "Connect daemons and run GitHub, Slack, Discord, and Linear workflows through the hosted service or your own deployment.",
      },
      {
        path: "/blog",
        title: "Blog",
        description: "Updates and technical posts from the Paseo team.",
      },
      { path: "/privacy", title: "Privacy", description: "Privacy policy." },
      {
        path: "/terms",
        title: "Terms",
        description: "Terms for the official relay and hosted Hub.",
      },
      {
        path: "https://github.com/getpaseo/paseo",
        title: "GitHub",
        description: "Source code, issues, and releases.",
      },
    ],
  },
  "zh-CN": {
    preamble: `# Paseo

> 面向桌面、移动端、Web 和 CLI 的开源 Agent 开发环境。

Paseo 是一个完整的 Agent 开发环境。在以 Agent 驱动的开发中，它可以取代你的 IDE：运行编程 Agent、编辑文件、审查 diff 和 PR、在终端中运行测试，并在内置的桌面浏览器中检查你的应用。在一个工作区内，用分屏排列 Agent、文件、终端和浏览器标签页。

并行运行多个 Agent，每个 Agent 都有自己的 git worktree 和分支。为每个任务选择 Provider 和模型，检查结果，再决定合并什么。Agent 还可以创建 worktree、启动其他 Agent，并通过 Paseo 的编排工具与它们通信。

Agent 运行在你自己的机器上，使用你现有的工具、配置和凭据。你可以在桌面端、完整的原生 iOS 和 Android 应用、Web 浏览器或 CLI 中工作。桌面应用会自动启动本地 daemon。进行远程工作时，在另一台机器上运行 daemon，然后直接连接，或通过可选的端到端加密中继连接。

Paseo 支持 Claude Code、Codex、GitHub Copilot、OpenCode、Pi、Antigravity、Muse Code，以及其他兼容 ACP 的 Agent。CLI、TypeScript SDK 和 MCP 工具为自动化开放了 Agent 和工作区操作。插件可以扩展 Provider、工作流和应用界面。

分发方式：Mac、Windows、Linux、iOS 和 Android 原生应用；Web 应用；Homebrew；npm。源代码：Apache-2.0，位于 https://github.com/getpaseo/paseo。官网：https://paseo.sh。
`,
    docs: "文档",
    alternatives: "替代方案",
    agents: "支持的 Agent",
    optional: "可选",
    pages: [
      {
        path: "/changelog",
        title: "更新日志",
        description: "Paseo daemon、CLI、桌面和移动应用的发布说明。",
      },
      {
        path: "/download",
        title: "下载",
        description: "在 Mac、Windows、Linux、iOS、Android 上安装 Paseo，或运行 Web 应用。",
      },
      {
        path: "/hub",
        title: "Paseo Hub",
        description:
          "连接 daemon，通过托管服务或你自己的部署运行 GitHub、Slack、Discord 和 Linear 工作流。",
      },
      { path: "/blog", title: "博客", description: "Paseo 团队的动态和技术文章。" },
      { path: "/privacy", title: "隐私", description: "隐私政策。" },
      { path: "/terms", title: "条款", description: "官方中继和托管 Hub 的条款。" },
      {
        path: "https://github.com/getpaseo/paseo",
        title: "GitHub",
        description: "源代码、issue 和发布版本。",
      },
    ],
  },
};

function absoluteUrl(path: string, locale: Locale): string {
  const localized = localizePath(path, locale);
  return localized.startsWith("/") ? `${SITE_URL}${localized}` : localized;
}

function docLine(doc: Doc, locale: Locale): string {
  const url = `${SITE_URL}${withLocalePrefix(doc.href, locale)}.md`;
  const description = doc.frontmatter.description?.trim();
  const suffix = description ? `: ${description}` : "";
  return `- [${doc.frontmatter.title}](${url})${suffix}`;
}

function agentLine(agent: (typeof AGENT_PAGES)[number], locale: Locale): string {
  const page = getAgentPage(agent.slug, getTranslator(locale));
  return `- [${page.name}](${absoluteUrl(`/${page.slug}`, locale)}): ${page.subtitle}`;
}

function alternativeLine(
  page: ReturnType<typeof getAlternativePages>[number],
  locale: Locale,
): string {
  const description = page.description.trim();
  const suffix = description ? `: ${description}` : "";
  return `- [${page.title}](${absoluteUrl(page.href, locale)})${suffix}`;
}

function topLevelDocs(locale: Locale): Doc[] {
  return getDocs(locale).filter((d) => !d.slug.includes("/"));
}

/** The site index for language models, in a language: `/llms.txt` or `/zh-CN/llms.txt`. */
export function buildLlmsTxt(locale: Locale): string {
  const copy = COPY[locale];
  const docs = topLevelDocs(locale)
    .map((doc) => docLine(doc, locale))
    .join("\n");
  const alternatives = getAlternativePages(locale)
    .map((page) => alternativeLine(page, locale))
    .join("\n");
  const agents = AGENT_PAGES.map((agent) => agentLine(agent, locale)).join("\n");
  const pages = copy.pages
    .map((page) => `- [${page.title}](${absoluteUrl(page.path, locale)}): ${page.description}`)
    .join("\n");

  return `${copy.preamble}
## ${copy.docs}

${docs}

## ${copy.alternatives}

${alternatives}

## ${copy.agents}

${agents}

## ${copy.optional}

${pages}
`;
}
