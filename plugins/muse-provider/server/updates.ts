import type { ProviderUpdateCheck } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

/** What a Muse update channel publishes; the launcher installs `version` when it differs. */
export interface MuseChannelRelease {
  version: string;
  notificationText?: string;
}

export type ReadMuseChannelRelease = (input: {
  channel: string;
  signal: AbortSignal;
}) => Promise<MuseChannelRelease>;

const DEFAULT_CHANNEL = "muse-stable";

const channelManifestSchema = z.object({
  version: z.string().min(1),
  notification_text: z.string().optional(),
});

/** Reads the channel manifest the `muse` launcher updates from. */
export const readMuseChannelRelease: ReadMuseChannelRelease = async ({ channel, signal }) => {
  const url = `https://api.meta.ai/muse-code/channels/${encodeURIComponent(channel)}`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Muse update channel returned ${response.status}`);
  const manifest = channelManifestSchema.parse(await response.json());
  return { version: manifest.version, notificationText: manifest.notification_text };
};

/**
 * Compares the installed build with the build the launcher's channel publishes. The launcher
 * replaces any build that differs from the channel's, so a different build is an update.
 */
export async function checkMuseForUpdates(input: {
  /** The build `muse --version` prints in parentheses, such as `1.4.18-R8587.1`. */
  installedBuild: string | null;
  env: Record<string, string> | undefined;
  readChannelRelease: ReadMuseChannelRelease;
  signal: AbortSignal;
}): Promise<ProviderUpdateCheck> {
  if (!input.installedBuild)
    return { status: "unknown", message: "This Muse Code does not report its build" };
  const channel = input.env?.MUSE_CHANNEL || DEFAULT_CHANNEL;
  const release = await input.readChannelRelease({ channel, signal: input.signal });
  if (release.version === input.installedBuild) return { status: "current" };
  return {
    status: "available",
    versions: [release.version],
    ...(release.notificationText ? { message: release.notificationText } : {}),
  };
}
