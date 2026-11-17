import { useCallback, useEffect, useState } from "react";
import { parseChangelog } from "./parse-changelog";
import { groupReleases, type ChangelogReleaseGroup } from "./release-groups";

const CHANGELOG_URL = "https://raw.githubusercontent.com/getpaseo/paseo/main/CHANGELOG.md";

export type ChangelogState =
  | { status: "loading" }
  | { status: "ready"; groups: ChangelogReleaseGroup[] }
  | { status: "error" };

// Survives close/reopen so the second look paints without a spinner. The raw
// text is kept alongside the groups so an unchanged revalidation can be
// dropped: handing back an equal-but-new array would re-render every group.
let cached: { markdown: string; groups: ChangelogReleaseGroup[] } | null = null;

export interface Changelog {
  state: ChangelogState;
  reload: () => void;
}

/**
 * Reads the changelog from the repository the app was built from.
 *
 * The daemon is not involved: the changelog describes the app, a phone reaching
 * a relay already has internet, and going through a host would make the notes
 * depend on which host happens to be connected.
 *
 * Every open refetches, because the whole point of opening it is a release that
 * shipped after this app started. A previous result stays on screen while that
 * happens, and survives a failed revalidation.
 */
export function useChangelog(enabled: boolean): Changelog {
  const [state, setState] = useState<ChangelogState>(readCache);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    setState(readCache());

    void (async () => {
      try {
        const response = await fetch(CHANGELOG_URL, { signal: controller.signal });
        if (!response.ok) throw new Error(`Changelog request failed: ${response.status}`);
        const markdown = await response.text();
        if (cached?.markdown === markdown) return;
        const releases = parseChangelog(markdown);
        if (releases.length === 0) throw new Error("Changelog has no releases");
        const groups = groupReleases(releases);
        cached = { markdown, groups };
        setState({ status: "ready", groups });
      } catch {
        if (controller.signal.aborted) return;
        if (cached) return;
        setState({ status: "error" });
      }
    })();

    return () => controller.abort();
  }, [enabled, attempt]);

  const reload = useCallback(() => {
    cached = null;
    setAttempt((value) => value + 1);
  }, []);

  return { state, reload };
}

function readCache(): ChangelogState {
  return cached ? { status: "ready", groups: cached.groups } : { status: "loading" };
}
