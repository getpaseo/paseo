import { createServerFn } from "@tanstack/react-start";
import { getBlockingColdCache } from "./github-cache";

interface GitHubRepo {
  stargazers_count: number;
}

function formatStars(count: number): string {
  if (count < 1000) return String(count);
  const k = count / 1000;
  return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
}

const GITHUB_REPO_URL = "https://api.github.com/repos/getpaseo/paseo";
const STARS_CACHE_KEY = "github-stars:v1";

async function fetchStarCount(): Promise<string> {
  const res = await fetch(GITHUB_REPO_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "paseo-website",
    },
    cf: {
      cacheEverything: true,
      cacheTtl: 60,
      cacheKey: "github-repo-stars",
    },
  } as RequestInit);
  if (!res.ok) throw new Error(`github repo ${res.status}`);

  const repo = (await res.json()) as GitHubRepo;
  return formatStars(repo.stargazers_count);
}

function isStars(value: unknown): value is string {
  return typeof value === "string" && /^(\d+|\d+\.\d+k|\d+k)$/.test(value);
}

export const getStarCount = createServerFn({ method: "GET" }).handler(async () => {
  const stars = await getBlockingColdCache({
    key: STARS_CACHE_KEY,
    isValue: isStars,
    fetchFresh: fetchStarCount,
  });
  return { stars };
});
