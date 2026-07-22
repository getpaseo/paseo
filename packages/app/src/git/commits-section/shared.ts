import { StyleSheet } from "react-native-unistyles";
import type { CheckoutCommit } from "@getpaseo/protocol/messages";

export type CheckoutCommitFile = CheckoutCommit["files"][number];

export type FilePressHandler = (commit: CheckoutCommit, file: CheckoutCommitFile) => void;

export const DOT_SIZE = 8;

// The "on remote" dot is intentionally understated: the local-only ring is the
// state worth noticing (you still have work to push), so the remote fill is
// dimmed toward the background rather than rendered at full-strength green.
const REMOTE_DOT_OPACITY = 0.55;

/**
 * A local-only commit is a hollow ring; a commit that has reached the remote
 * is a subtle (dimmed) filled green dot.
 */
export const dotStyles = StyleSheet.create((theme) => ({
  dotLocal: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: "transparent",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  dotRemote: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusSuccess,
    opacity: REMOTE_DOT_OPACITY,
    flexShrink: 0,
  },
}));
