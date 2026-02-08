import { z } from "zod";

const SHELL_WRAPPER_PREFIX_PATTERN =
  /^\/bin\/(?:zsh|bash|sh)\s+(?:-[a-zA-Z]+\s+)?/;
const CD_AND_PATTERN = /^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s+&&\s+/;

export function stripCwdPrefix(filePath: string, cwd?: string): string {
  if (!cwd || !filePath) return filePath;

  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = filePath.replace(/\\/g, "/");

  const prefix = `${normalizedCwd}/`;
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length);
  }
  if (normalizedPath === normalizedCwd) {
    return ".";
  }
  return filePath;
}

export function stripShellWrapperPrefix(command: string): string {
  const prefixMatch = command.match(SHELL_WRAPPER_PREFIX_PATTERN);
  if (!prefixMatch) {
    return command;
  }

  let rest = command.slice(prefixMatch[0].length).trim();
  if (rest.length >= 2) {
    const first = rest[0];
    const last = rest[rest.length - 1];
    if ((first === `"` || first === `'`) && last === first) {
      rest = rest.slice(1, -1);
    }
  }

  return rest.replace(CD_AND_PATTERN, "");
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

const TodosSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
      activeForm: z.string().optional(),
    })
  ),
});

export function extractTodos(value: unknown): TodoItem[] {
  const parsed = TodosSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.todos;
}
