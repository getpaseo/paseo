import { z } from "zod";
import type {
  ProviderCommand,
  ProviderLaunch,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { probe } from "./process.js";
import { AntigravityError } from "./wire.js";

const skillsPrintSchema = z.object({
  status: z.literal("SUCCESS"),
  command: z.object({
    name: z.literal("skills"),
    data: z.object({
      skills: z.array(
        z.object({
          name: z.string().min(1),
          description: z.string().default(""),
        }),
      ),
    }),
  }),
});

export const BUILTIN_PROMPT_COMMANDS: readonly ProviderCommand[] = [
  {
    name: "plan",
    description: "Create a step-by-step plan before executing complex tasks",
    argumentHint: "[task]",
  },
  {
    name: "grill-me",
    description: "Align on a plan through an interactive interview to resolve design decisions",
    argumentHint: "[topic]",
  },
  {
    name: "goal",
    description: "Run a thorough, long-running task until the goal is fully achieved",
    argumentHint: "[goal]",
  },
  {
    name: "schedule",
    description: "Run an instruction on a recurring schedule or set a one-time timer",
    argumentHint: "[schedule]",
  },
  {
    name: "browser",
    description: "Browse the web, search, or interact with web applications",
    argumentHint: "[task]",
  },
  {
    name: "teamwork",
    description: "Coordinate a team of autonomous subagents for a large project",
    argumentHint: "[project]",
  },
  {
    name: "learn",
    description: "Persist a correction or setup pattern for future tasks",
    argumentHint: "[lesson]",
  },
];

function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

export async function getCommands(
  launch: ProviderLaunch,
  config: Pick<ProviderSessionConfig, "cwd" | "env">,
): Promise<ProviderCommand[]> {
  const effectiveLaunch: ProviderLaunch = {
    ...launch,
    env: { ...launch.env, ...config.env },
  };
  const output = await probe({
    launch: effectiveLaunch,
    args: ["--add-dir", config.cwd, "--output-format", "json", "--print", "/skills"],
    cwd: config.cwd,
  });
  let parsed: z.infer<typeof skillsPrintSchema>;
  try {
    parsed = skillsPrintSchema.parse(JSON.parse(output));
  } catch {
    throw new AntigravityError("Invalid `agy --print /skills` output", "INVALID_SKILLS");
  }
  const seen = new Set<string>();
  const commands: ProviderCommand[] = [];
  for (const skill of parsed.command.data.skills) {
    const name = skill.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    commands.push({
      name,
      description: normalizeDescription(skill.description),
      argumentHint: "[instructions]",
    });
  }
  for (const builtin of BUILTIN_PROMPT_COMMANDS) {
    if (seen.has(builtin.name)) continue;
    seen.add(builtin.name);
    commands.push(builtin);
  }
  return commands;
}

export function extractLeadingCommandName(text: string): string | null {
  const match = /^\/([A-Za-z0-9_:-]+)(?=\s|$)/.exec(text);
  return match ? match[1] : null;
}
