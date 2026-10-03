export const CATEGORIES = [
  { slug: "themes", label: "Themes", description: "Change how Paseo looks." },
  {
    slug: "agents-and-providers",
    label: "Agents & providers",
    description: "Run more coding agents through Paseo.",
  },
  {
    slug: "monitoring",
    label: "Monitoring & orchestration",
    description: "See every agent at once and steer work across workspaces.",
  },
  {
    slug: "timeline-and-composer",
    label: "Timeline & composer",
    description: "Change what a conversation shows and how you write to agents.",
  },
  {
    slug: "workspace-panels",
    label: "Workspace panels",
    description: "Tools that open as tabs next to your agents.",
  },
  {
    slug: "git-and-code-review",
    label: "Git & code review",
    description: "Branches, worktrees, and pull requests.",
  },
  {
    slug: "automation",
    label: "Automation & scheduling",
    description: "Run things later, on a schedule, or when an agent goes idle.",
  },
  { slug: "notifications", label: "Notifications", description: "Know when an agent needs you." },
  {
    slug: "usage-and-pricing",
    label: "Usage & pricing",
    description: "What models cost and how much you have used.",
  },
  {
    slug: "integrations",
    label: "Integrations",
    description: "Issues, tasks, and tools from other services inside Paseo.",
  },
  { slug: "utilities", label: "Utilities", description: "Small helpers for everyday work." },
] as const;

export type CategorySlug = (typeof CATEGORIES)[number]["slug"];
export type Category = (typeof CATEGORIES)[number];
