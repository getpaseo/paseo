import { useChangelogStore } from "./internal/changelog-store";

/** Opens the What's new sheet from anywhere, including outside React. */
export function openChangelog(): void {
  useChangelogStore.getState().open();
}
