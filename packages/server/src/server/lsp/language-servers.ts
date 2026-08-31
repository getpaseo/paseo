import { extname } from "node:path";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";

/**
 * A language server Paseo knows how to talk to. Binaries are never bundled: the user
 * installs them, and an absent one is a normal state the UI reports rather than an error.
 *
 * There is no published registry package for this mapping, so it is maintained here as
 * data. Keep it to servers that speak stdio and need no per-project configuration.
 */
export interface LanguageServerDescriptor {
  /** Stable id used in the session pool key and in configuration. */
  id: string;
  command: string;
  args: string[];
  /** Lowercase, dot-prefixed extensions this server claims. */
  extensions: readonly string[];
  /** LSP `languageId` per extension; anything unlisted falls back to `defaultLanguageId`. */
  languageIds: Readonly<Record<string, string>>;
  defaultLanguageId: string;
}

export const LANGUAGE_SERVERS: readonly LanguageServerDescriptor[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    languageIds: {
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".jsx": "javascriptreact",
    },
    defaultLanguageId: "typescript",
  },
  {
    id: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
    languageIds: {},
    defaultLanguageId: "python",
  },
  {
    id: "go",
    command: "gopls",
    args: [],
    extensions: [".go"],
    languageIds: {},
    defaultLanguageId: "go",
  },
  {
    id: "rust",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    languageIds: {},
    defaultLanguageId: "rust",
  },
];

export function descriptorForFile(filePath: string): LanguageServerDescriptor | null {
  const ext = extname(filePath).toLowerCase();
  if (!ext) {
    return null;
  }
  return LANGUAGE_SERVERS.find((server) => server.extensions.includes(ext)) ?? null;
}

export function languageIdForFile(descriptor: LanguageServerDescriptor, filePath: string): string {
  return descriptor.languageIds[extname(filePath).toLowerCase()] ?? descriptor.defaultLanguageId;
}

export interface ResolvedLanguageServer {
  descriptor: LanguageServerDescriptor;
  executablePath: string;
}

/**
 * Resolve the descriptor's command on PATH. `configuredCommand` lets a user point at a
 * binary Paseo would not find on its own; it replaces the command, never the arguments.
 */
export async function resolveLanguageServer(
  descriptor: LanguageServerDescriptor,
  configuredCommand?: string,
  resolve: typeof findExecutable = findExecutable,
): Promise<ResolvedLanguageServer | null> {
  const command = configuredCommand?.trim() || descriptor.command;
  const executablePath = await resolve(command);
  return executablePath ? { descriptor, executablePath } : null;
}
