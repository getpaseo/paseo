import { buildWorkingDirectorySuggestions } from "@/utils/working-directory-suggestions";

export interface DirectorySearchResult {
  query: string;
  paths: string[];
}

export function planDirectorySearch(input: {
  query: string;
  recommendedPaths: string[];
  cachedResults: DirectorySearchResult[];
}) {
  const query = input.query.trim();
  const previousResult = input.cachedResults.find((result) => result.query === query);
  const paths = buildWorkingDirectorySuggestions({
    recommendedPaths: [
      ...input.recommendedPaths,
      ...input.cachedResults.flatMap((result) => result.paths),
    ],
    serverPaths: previousResult?.paths ?? [],
    query,
  });
  return {
    paths: paths.slice(0, 30),
    // A cached empty response is an answer too. Retyping it must not start a loop.
    queryToFetch: query && paths.length === 0 && !previousResult ? query : null,
  };
}
