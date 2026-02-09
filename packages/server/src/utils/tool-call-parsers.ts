import { z } from "zod";
import { stripCwdPrefix } from "../shared/path-utils.js";

const SHELL_WRAPPER_PREFIX_PATTERN =
  /^\/bin\/(?:zsh|bash|sh)\s+(?:-[a-zA-Z]+\s+)?/;
const CD_AND_PATTERN = /^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s+&&\s+/;
export { stripCwdPrefix };

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
