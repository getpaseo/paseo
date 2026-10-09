import { getAlternativePages } from "~/data/alternative-pages";
import { AGENT_PAGES } from "~/data/agent-pages";
import { type Doc, getDocs } from "~/docs";

const SITE_URL = "https://paseo.sh";

const PRODUCT_PREAMBLE = `# Paseo

> Open source agentic development environment for desktop, mobile, web, and CLI.

Paseo is a full agentic development environment. For agent-driven development, it replaces your IDE: run coding agents, edit files, review diffs and pull requests, run tests in terminals, and check your app in the built-in desktop browser. Arrange agents, files, terminals, and browser tabs in split panes within a workspace.

Run many agents in parallel, each in its own git worktree and branch. Choose a provider and model for each task, inspect the results, and decide what to merge. Agents can also create worktrees, launch other agents, and communicate with them through Paseo's orchestration tools.

Agents run on your own machines with your existing tools, configuration, and credentials. Work from desktop, the full native iOS and Android app, a web browser, or the CLI. The desktop app starts its local daemon automatically. For remote work, run the daemon on another machine and connect directly or through the optional end-to-end encrypted relay.

Paseo supports Claude Code, Codex, GitHub Copilot, OpenCode, Pi, Antigravity, Muse Code, and additional ACP-compatible agents. The CLI, TypeScript SDK, and MCP tools expose agent and workspace operations for automation. Plugins extend providers, workflows, and the app's interface.

Distribution: native apps for Mac, Windows, Linux, iOS, and Android; web app; Homebrew; npm. Source: Apache-2.0 at https://github.com/getpaseo/paseo. Marketing site: https://paseo.sh.
`;

function docLine(doc: Doc): string {
  const url = `${SITE_URL}${doc.href}.md`;
  const description = doc.frontmatter.description?.trim();
  const suffix = description ? `: ${description}` : "";
  return `- [${doc.frontmatter.title}](${url})${suffix}`;
}

function agentLine(agent: (typeof AGENT_PAGES)[number]): string {
  return `- [${agent.name}](${SITE_URL}/${agent.slug}): ${agent.subtitle}`;
}

function alternativeLine(page: ReturnType<typeof getAlternativePages>[number]): string {
  const description = page.description.trim();
  const suffix = description ? `: ${description}` : "";
  return `- [${page.title}](${SITE_URL}${page.href})${suffix}`;
}

function topLevelDocs(): Doc[] {
  return getDocs().filter((d) => !d.slug.includes("/"));
}

export function buildLlmsTxt(): string {
  const docs = topLevelDocs().map(docLine).join("\n");
  const alternatives = getAlternativePages().map(alternativeLine).join("\n");
  const agents = AGENT_PAGES.map(agentLine).join("\n");

  return `${PRODUCT_PREAMBLE}
## Docs

${docs}

## Alternatives

${alternatives}

## Supported agents

${agents}

## Optional

- [Changelog](${SITE_URL}/changelog): Release notes for the Paseo daemon, CLI, desktop, and mobile apps.
- [Download](${SITE_URL}/download): Install Paseo on Mac, Windows, Linux, iOS, Android, or run the web app.
- [Paseo Hub](${SITE_URL}/hub): Connect daemons and run GitHub, Slack, Discord, and Linear workflows through the hosted service or your own deployment.
- [Blog](${SITE_URL}/blog): Updates and technical posts from the Paseo team.
- [Privacy](${SITE_URL}/privacy): Privacy policy.
- [Terms](${SITE_URL}/terms): Terms for the official relay and hosted Hub.
- [GitHub](https://github.com/getpaseo/paseo): Source code, issues, and releases.
`;
}
