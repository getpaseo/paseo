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
      ...(previousResult ? [] : input.cachedResults.flatMap((result) => result.paths)),
    ],
    serverPaths: previousResult?.paths ?? [],
    query,
  });
  return {
    paths: [...new Set([...(previousResult?.paths ?? []), ...paths])].slice(0, 30),
    queryToFetch: query || null,
  };
}
