import path from "node:path";

export interface LanguageRegistryEntry {
  id: string;
  aliases: readonly string[];
  extensions: readonly string[];
  filenames?: readonly string[];
  grammarPackage?: string;
  grammarExport?: string;
  grammarName?: string;
  highlightsQueryPath?: string;
  priority?: number;
}

const REGISTRY_PRIORITY_DEFAULT = 0;

const LANGUAGE_REGISTRY: readonly LanguageRegistryEntry[] = [
  {
    id: "javascript",
    aliases: ["js"],
    extensions: [".js", ".mjs", ".cjs", ".jsx"],
    grammarPackage: "tree-sitter-javascript",
  },
  {
    id: "typescript",
    aliases: ["ts"],
    extensions: [".ts", ".mts", ".cts"],
    grammarPackage: "tree-sitter-typescript",
    grammarExport: "typescript",
    grammarName: "typescript",
  },
  {
    id: "tsx",
    aliases: ["tsx"],
    extensions: [".tsx"],
    grammarPackage: "tree-sitter-typescript",
    grammarExport: "tsx",
    grammarName: "tsx",
  },
  {
    id: "python",
    aliases: ["py"],
    extensions: [".py", ".pyi"],
    grammarPackage: "tree-sitter-python",
  },
  {
    id: "json",
    aliases: ["json"],
    extensions: [".json", ".jsonc"],
    grammarPackage: "tree-sitter-json",
  },
  {
    id: "yaml",
    aliases: ["yml", "yaml"],
    extensions: [".yaml", ".yml"],
    grammarPackage: "tree-sitter-yaml",
  },
  {
    id: "toml",
    aliases: ["toml"],
    extensions: [".toml"],
    grammarPackage: "tree-sitter-toml",
  },
  {
    id: "markdown",
    aliases: ["md"],
    extensions: [".md", ".mdx", ".markdown"],
    grammarPackage: "tree-sitter-markdown",
  },
  {
    id: "html",
    aliases: ["html"],
    extensions: [".html", ".htm"],
    grammarPackage: "tree-sitter-html",
  },
  {
    id: "xml",
    aliases: ["xml"],
    extensions: [".xml", ".xsd", ".xsl", ".xslt"],
  },
  {
    id: "css",
    aliases: ["css"],
    extensions: [".css"],
    grammarPackage: "tree-sitter-css",
  },
  {
    id: "scss",
    aliases: ["scss"],
    extensions: [".scss"],
    grammarPackage: "tree-sitter-scss",
  },
  {
    id: "sql",
    aliases: ["sql"],
    extensions: [".sql"],
    grammarPackage: "tree-sitter-sql",
  },
  {
    id: "bash",
    aliases: ["shell", "sh", "bash", "zsh"],
    extensions: [".sh", ".bash", ".zsh", ".ksh", ".fish"],
    filenames: [
      ".bashrc",
      ".bash_profile",
      ".zshrc",
      ".zprofile",
      ".profile",
    ],
    grammarPackage: "tree-sitter-bash",
  },
  {
    id: "dockerfile",
    aliases: ["dockerfile"],
    extensions: [".dockerfile", ".containerfile"],
    filenames: ["dockerfile", "containerfile"],
  },
  {
    id: "go",
    aliases: ["go"],
    extensions: [".go"],
    grammarPackage: "tree-sitter-go",
  },
  {
    id: "rust",
    aliases: ["rust", "rs"],
    extensions: [".rs"],
    grammarPackage: "tree-sitter-rust",
  },
  {
    id: "c",
    aliases: ["c"],
    extensions: [".c", ".h"],
    grammarPackage: "tree-sitter-c",
    priority: 10,
  },
  {
    id: "cpp",
    aliases: ["cpp", "c++"],
    extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".h"],
    grammarPackage: "tree-sitter-cpp",
    priority: 20,
  },
  {
    id: "objective-c",
    aliases: ["objc", "objective-c"],
    extensions: [".m", ".mm"],
    grammarPackage: "tree-sitter-objc",
    priority: 30,
  },
  {
    id: "csharp",
    aliases: ["csharp", "c#"],
    extensions: [".cs"],
    grammarPackage: "tree-sitter-c-sharp",
  },
  {
    id: "java",
    aliases: ["java"],
    extensions: [".java"],
    grammarPackage: "tree-sitter-java",
  },
  {
    id: "kotlin",
    aliases: ["kotlin"],
    extensions: [".kt", ".kts"],
    grammarPackage: "tree-sitter-kotlin",
  },
  {
    id: "swift",
    aliases: ["swift"],
    extensions: [".swift"],
  },
  {
    id: "php",
    aliases: ["php"],
    extensions: [".php", ".phtml", ".php5", ".php7", ".php8"],
    grammarPackage: "tree-sitter-php",
    grammarExport: "php",
    grammarName: "php",
  },
  {
    id: "ruby",
    aliases: ["ruby", "rb"],
    extensions: [".rb", ".rake", ".gemspec"],
    filenames: ["gemfile", "rakefile"],
    grammarPackage: "tree-sitter-ruby",
  },
  {
    id: "lua",
    aliases: ["lua"],
    extensions: [".lua"],
    grammarPackage: "tree-sitter-lua",
  },
  {
    id: "elixir",
    aliases: ["elixir", "ex"],
    extensions: [".ex", ".exs", ".heex"],
    grammarPackage: "tree-sitter-elixir",
  },
  {
    id: "haskell",
    aliases: ["haskell", "hs"],
    extensions: [".hs"],
    grammarPackage: "tree-sitter-haskell",
  },
  {
    id: "ocaml",
    aliases: ["ocaml", "ml"],
    extensions: [".ml", ".mli"],
    grammarPackage: "tree-sitter-ocaml",
    grammarExport: "ocaml",
  },
  {
    id: "scala",
    aliases: ["scala"],
    extensions: [".scala", ".sc"],
    grammarPackage: "tree-sitter-scala",
  },
  {
    id: "dart",
    aliases: ["dart"],
    extensions: [".dart"],
    grammarPackage: "tree-sitter-dart",
  },
  {
    id: "r",
    aliases: ["r"],
    extensions: [".r", ".rmd"],
    grammarPackage: "@eagleoutice/tree-sitter-r",
  },
  {
    id: "perl",
    aliases: ["perl", "pl"],
    extensions: [".pl", ".pm", ".t"],
    grammarPackage: "@ganezdragon/tree-sitter-perl",
  },
  {
    id: "zig",
    aliases: ["zig"],
    extensions: [".zig"],
    grammarPackage: "tree-sitter-zig",
  },
  {
    id: "graphql",
    aliases: ["graphql", "gql"],
    extensions: [".graphql", ".gql"],
  },
  {
    id: "plaintext",
    aliases: ["txt", "text", "plain"],
    extensions: [".txt", ".text", ".log", ".conf", ".config", ".ini"],
    filenames: [
      ".env",
      ".env.local",
      ".env.development",
      ".env.production",
      ".gitignore",
      ".gitattributes",
      ".editorconfig",
      ".npmrc",
      ".yarnrc",
      ".prettierrc",
      ".eslintrc",
      "license",
      "readme",
    ],
  },
];

type RegistryIndex = {
  byExtension: Map<string, LanguageRegistryEntry>;
  byFilename: Map<string, LanguageRegistryEntry>;
};

const registryIndex = buildRegistryIndex(LANGUAGE_REGISTRY);

function buildRegistryIndex(entries: readonly LanguageRegistryEntry[]): RegistryIndex {
  const byExtension = new Map<string, LanguageRegistryEntry>();
  const byFilename = new Map<string, LanguageRegistryEntry>();

  for (const entry of entries) {
    for (const extension of entry.extensions) {
      const normalized = normalizeExtension(extension);
      if (!normalized) {
        continue;
      }
      const existing = byExtension.get(normalized);
      if (shouldReplaceEntry(existing, entry)) {
        byExtension.set(normalized, entry);
      }
    }

    for (const filename of entry.filenames ?? []) {
      const normalized = filename.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      const existing = byFilename.get(normalized);
      if (shouldReplaceEntry(existing, entry)) {
        byFilename.set(normalized, entry);
      }
    }
  }

  return { byExtension, byFilename };
}

function shouldReplaceEntry(
  existing: LanguageRegistryEntry | undefined,
  incoming: LanguageRegistryEntry
): boolean {
  if (!existing) {
    return true;
  }
  const existingPriority = existing.priority ?? REGISTRY_PRIORITY_DEFAULT;
  const incomingPriority = incoming.priority ?? REGISTRY_PRIORITY_DEFAULT;
  return incomingPriority > existingPriority;
}

function normalizeExtension(extension: string): string | null {
  const normalized = extension.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

export function resolveLanguageEntry(
  filename: string
): LanguageRegistryEntry | null {
  const basename = path.basename(filename).toLowerCase();
  const fromFilename = registryIndex.byFilename.get(basename);
  if (fromFilename) {
    return fromFilename;
  }

  const extension = path.extname(basename).toLowerCase();
  if (!extension) {
    return null;
  }

  return registryIndex.byExtension.get(extension) ?? null;
}

export function getKnownTextExtensions(): string[] {
  return Array.from(registryIndex.byExtension.keys()).sort();
}

export function getSupportedLanguageExtensions(): string[] {
  const supported = new Set<string>();
  for (const [extension, entry] of registryIndex.byExtension) {
    if (entry.grammarPackage) {
      supported.add(extension);
    }
  }
  return Array.from(supported).sort();
}

export function isKnownTextFilename(filename: string): boolean {
  return resolveLanguageEntry(filename) !== null;
}

export function isGrammarBackedLanguage(filename: string): boolean {
  const entry = resolveLanguageEntry(filename);
  return Boolean(entry?.grammarPackage);
}

export function getLanguageRegistry(): readonly LanguageRegistryEntry[] {
  return LANGUAGE_REGISTRY;
}
