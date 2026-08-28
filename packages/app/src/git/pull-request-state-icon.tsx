import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { PrHint } from "@/git/pr-hint";

const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedGitMerge = withUnistyles(GitMerge);
const ThemedGitPullRequestClosed = withUnistyles(GitPullRequestClosed);

const successMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const mergedMapping = (theme: Theme) => ({ color: theme.colors.statusMerged });
const dangerMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

const PRESENTATION = {
  open: { Icon: ThemedGitPullRequest, color: successMapping },
  merged: { Icon: ThemedGitMerge, color: mergedMapping },
  closed: { Icon: ThemedGitPullRequestClosed, color: dangerMapping },
} as const;

/** The canonical state glyph and color shared by every pull-request badge. */
export function PullRequestStateIcon({
  state,
  size,
  strokeWidth,
}: {
  state: PrHint["state"];
  size: number;
  strokeWidth?: number;
}) {
  const { Icon, color } = PRESENTATION[state];
  return <Icon size={size} strokeWidth={strokeWidth} uniProps={color} />;
}
