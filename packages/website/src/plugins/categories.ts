export const CATEGORIES = [
  {
    slug: "daemon-management",
    label: "Daemon management",
    description: "Manage hosts, daemon jobs, resources, approvals, and MCP servers.",
  },
  {
    slug: "themes",
    label: "Themes",
    description: "Change the app color scheme.",
  },
  {
    slug: "providers",
    label: "Providers",
    description:
      "Connect coding agents, ACP servers, and model routers, with account and quota fallback.",
  },
  {
    slug: "orchestration",
    label: "Orchestration",
    description: "Coordinate agents, delegate work, and send messages across hosts.",
  },
  {
    slug: "git",
    label: "Git",
    description: "Work with branches, worktrees, pull requests, stacks, diffs, and reviews.",
  },
  {
    slug: "workspaces",
    label: "Workspaces",
    description: "Add workspace panels and tabs for boards, browsers, documents, and terminals.",
  },
  {
    slug: "sidebar",
    label: "Sidebar",
    description: "Add sidebar items and panels for usage, notifications, pricing, and links.",
  },
  {
    slug: "extras",
    label: "Extras",
    description: "Add presence, pets, puzzles, wellbeing reminders, and demos.",
  },
  {
    slug: "utils",
    label: "Utils",
    description:
      "Extend the composer and timeline with commands, prompts, skills, and small helpers.",
  },
] as const;

export type CategorySlug = (typeof CATEGORIES)[number]["slug"];
export type Category = (typeof CATEGORIES)[number];
