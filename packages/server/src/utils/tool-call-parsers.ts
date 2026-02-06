import { z } from "zod";

// ---- Principal Parameter Extraction ----

// Schema for file entries in arrays (e.g., apply_patch files)
const FileEntrySchema = z.object({ path: z.string() });

// Schema for TodoWrite todos array
const TodoEntrySchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().optional(),
});

const PrincipalParamSchema = z.union([
  // Direct path keys
  z.object({ file_path: z.string() }).transform((d) => ({ type: "path" as const, value: d.file_path })),
  z.object({ filePath: z.string() }).transform((d) => ({ type: "path" as const, value: d.filePath })),
  z.object({ path: z.string() }).transform((d) => ({ type: "path" as const, value: d.path })),
  // Command as string
  z.object({ command: z.string() }).transform((d) => ({ type: "command" as const, value: d.command })),
  // Command as array (Codex sends this)
  z.object({ command: z.array(z.string()).nonempty() }).transform((d) => ({ type: "command" as const, value: d.command.join(" ") })),
  // Other text params
  z.object({ title: z.string() }).transform((d) => ({ type: "text" as const, value: d.title })),
  z.object({ name: z.string() }).transform((d) => ({ type: "text" as const, value: d.name })),
  z.object({ branch: z.string() }).transform((d) => ({ type: "text" as const, value: d.branch })),
  z.object({ pattern: z.string() }).transform((d) => ({ type: "text" as const, value: d.pattern })),
  z.object({ query: z.string() }).transform((d) => ({ type: "text" as const, value: d.query })),
  z.object({ url: z.string() }).transform((d) => ({ type: "text" as const, value: d.url })),
  z.object({ text: z.string() }).transform((d) => ({ type: "text" as const, value: d.text })),
  // Files array (Codex apply_patch)
  z.object({ files: z.array(FileEntrySchema).nonempty() }).transform((d) => ({ type: "path" as const, value: d.files[0].path })),
  // TodoWrite - show in_progress item or count
  z.object({ todos: z.array(TodoEntrySchema).nonempty() }).transform((d) => {
    const inProgress = d.todos.find((t) => t.status === "in_progress");
    if (inProgress) {
      return { type: "text" as const, value: inProgress.activeForm ?? inProgress.content };
    }
    return { type: "text" as const, value: `${d.todos.length} tasks` };
  }),
]);

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

// Strips shell wrapper prefixes like:
// - `/bin/zsh -lc cd /path && <cmd>`
// - `/bin/zsh -lc "cd /path && <cmd>"`
// This is used for display purposes to show the actual command being run.
const SHELL_WRAPPER_PREFIX_PATTERN = /^\/bin\/(?:zsh|bash|sh)\s+(?:-[a-zA-Z]+\s+)?/;
const CD_AND_PATTERN = /^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s+&&\s+/;

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

  const stripped = rest.replace(CD_AND_PATTERN, "");
  if (stripped !== rest) {
    return stripped;
  }

  return command;
}

export function extractPrincipalParam(args: unknown, cwd?: string): string | undefined {
  const parsed = PrincipalParamSchema.safeParse(args);
  if (!parsed.success) {
    return undefined;
  }

  const { type, value } = parsed.data;
  if (type === "path") {
    return stripCwdPrefix(value, cwd);
  }
  if (type === "command") {
    return stripShellWrapperPrefix(value);
  }
  return value;
}

// ---- TodoWrite Extraction ----

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export function extractTodos(value: unknown): TodoItem[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.todos)) {
    return [];
  }
  return obj.todos.filter(
    (t): t is TodoItem =>
      typeof t === "object" &&
      t !== null &&
      typeof (t as Record<string, unknown>).content === "string" &&
      typeof (t as Record<string, unknown>).status === "string"
  );
}
