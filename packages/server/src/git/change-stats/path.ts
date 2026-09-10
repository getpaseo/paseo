import { basename } from "node:path";
import type { ChangeCategory } from "@getpaseo/protocol/diff-stat";
function isGenerated(path: string, name: string, content: string): boolean {
  return (
    /(^|\/)(node_modules|vendor|dist|build|coverage|__generated__|generated)(\/|$)/.test(path) ||
    /(?:\.generated\.|\.gen\.|\.min\.|\.map$)/.test(name) ||
    /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|cargo\.lock|poetry\.lock|uv\.lock)$/.test(
      name,
    ) ||
    /^\s*(?:\/\/|\/\*|\*|#|<!--).*?(?:@generated|auto[- ]generated|automatically generated|do not edit)/im.test(
      content.slice(0, 2048),
    )
  );
}

export function classifyPath(path: string, content = ""): ChangeCategory {
  const name = basename(path).toLowerCase();
  const lower = path.toLowerCase();
  if (isGenerated(lower, name, content)) return "generated";
  if (
    /(^|\/)(__tests__|__mocks__|__snapshots__|__fixtures__|test-utils|test-helpers|testing|tests?|fixtures?|e2e|specs?)(\/|$)/.test(
      lower,
    ) ||
    /\.(test|spec)\.[^.]+$|\.snap$/.test(name)
  )
    return "tests";
  if (
    /(^|\/)(docs?|public-docs)(\/|$)/.test(lower) ||
    /\.(md|mdx|rst|adoc)$/.test(name) ||
    /^(readme|license|licence|changelog|contributing|authors|notice)(\.|$)/.test(name)
  )
    return "docs";
  if (
    /(^|\/)(\.github\/workflows|\.circleci)(\/|$)/.test(lower) ||
    /^(\.gitlab-ci\.yml|jenkinsfile|azure-pipelines\.ya?ml)$/.test(name)
  )
    return "ci";
  if (/(^|\/)(scripts|bin|tools)(\/|$)/.test(lower)) return "tooling";
  if (
    /\.(config|conf)\.|^\.?[a-z-]*rc(\.|$)|^tsconfig.*\.json$|^dockerfile|^makefile|^\.env(\.|$)/.test(
      name,
    ) ||
    /\.(json|jsonc|ya?ml|toml|ini|properties)$/.test(name) ||
    name === ".gitignore" ||
    name === ".gitattributes"
  )
    return "config";
  if (/\.[jt]sx$/.test(name)) return "components";
  if (/\.[cm]?[jt]s$/.test(name)) return "code";
  if (/\.(css|scss|sass|less)$/.test(name)) return "styles";
  if (
    /\.(py|rb|go|rs|java|kt|kts|swift|c|h|cpp|hpp|cc|cs|fs|php|sh|bash|zsh|fish|ps1|sql|vue|svelte|astro|html|htm|xml|ex|exs|erl|hrl|clj|cljs|dart|lua|r|pl|pm|scala|groovy|m|mm|zig|wasm|graphql|gql)$/.test(
      name,
    )
  )
    return "otherCode";
  return "other";
}
