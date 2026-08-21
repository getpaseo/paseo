/**
 * Validate that a string is a valid git branch name slug.
 * Must be lowercase alphanumeric with hyphens and forward slashes only.
 */
export function validateBranchSlug(slug: string): {
  valid: boolean;
  error?: string;
} {
  if (!slug || slug.length === 0) {
    return { valid: false, error: "Branch name cannot be empty" };
  }

  if (slug.length > 100) {
    return { valid: false, error: "Branch name too long (max 100 characters)" };
  }

  const validPattern = /^[a-z0-9-/]+$/;
  if (!validPattern.test(slug)) {
    return {
      valid: false,
      error:
        "Branch name must contain only lowercase letters, numbers, hyphens, and forward slashes",
    };
  }

  if (slug.startsWith("-") || slug.endsWith("-")) {
    return {
      valid: false,
      error: "Branch name cannot start or end with a hyphen",
    };
  }

  if (slug.includes("--")) {
    return { valid: false, error: "Branch name cannot have consecutive hyphens" };
  }

  return { valid: true };
}

export const MAX_SLUG_LENGTH = 50;

/**
 * Convert a string to kebab-case for branch names.
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length <= MAX_SLUG_LENGTH) {
    return slug;
  }

  const truncated = slug.slice(0, MAX_SLUG_LENGTH);
  const lastHyphen = truncated.lastIndexOf("-");
  if (lastHyphen > MAX_SLUG_LENGTH / 2) {
    return truncated.slice(0, lastHyphen);
  }
  return truncated.replace(/-+$/, "");
}

/**
 * Normalize a user-supplied branch prefix into a safe path segment: lowercase,
 * `[a-z0-9_/-]` only, no leading slash/hyphen, no duplicate/trailing slashes.
 * A trailing hyphen or underscore is preserved: it doubles as the separator
 * in `applyBranchPrefix` (e.g. `foobar-` stays `foobar-`, not `foobar`).
 */
export function normalizeBranchPrefix(prefix: string): string {
  return prefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/^-+/, "");
}

/**
 * Join a normalized branch prefix to a branch name. Prefixes ending in `-` or
 * `_` attach directly (`foobar-` + `tokyo` -> `foobar-tokyo`); everything else
 * gets a `/` separator (`alice` + `tokyo` -> `alice/tokyo`). Returns
 * `branchName` unchanged when the prefix is empty.
 */
export function applyBranchPrefix(branchName: string, prefix: string | undefined): string {
  const normalized = prefix ? normalizeBranchPrefix(prefix) : "";
  if (!normalized) return branchName;
  const separator = /[-_]$/.test(normalized) ? "" : "/";
  return `${normalized}${separator}${branchName}`;
}
