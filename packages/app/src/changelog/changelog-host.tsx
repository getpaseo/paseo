import { useChangelogStore } from "./internal/changelog-store";
import { ChangelogSheet } from "./internal/changelog-sheet";

/** Mounted once by the app shell so any surface can call `openChangelog()`. */
export function ChangelogHost() {
  const visible = useChangelogStore((state) => state.visible);
  const close = useChangelogStore((state) => state.close);

  return <ChangelogSheet visible={visible} onClose={close} />;
}
