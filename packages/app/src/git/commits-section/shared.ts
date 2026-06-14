import { StyleSheet } from "react-native-unistyles";
import type { CheckoutCommit } from "@getpaseo/protocol/messages";

export type CheckoutCommitFile = CheckoutCommit["files"][number];

export type FilePressHandler = (commit: CheckoutCommit, file: CheckoutCommitFile) => void;

export const DOT_SIZE = 8;

/**
 * Shared local/remote commit dot styles used by both the commit rows and the
 * section legend so the two never drift.
 *
 * Semantics: a local-only commit is a hollow ring; a commit that has reached
 * the remote is a filled green dot.
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
    flexShrink: 0,
  },
  // Legend variant of the remote dot: same fill, with leading spacing so it
  // separates from the preceding "local" label in the section header legend.
  legendDotRemote: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusSuccess,
    flexShrink: 0,
    marginLeft: theme.spacing[1],
  },
}));
