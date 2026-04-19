import { randomUUID } from "node:crypto";

export const newChannelId = () => `chan_${randomUUID()}`;
export const newMessageId = () => `msg_${randomUUID()}`;
export const newAttachmentId = () => `att_${randomUUID()}`;

/**
 * Channel name slug: lowercase, ASCII word chars + hyphens, trimmed.
 * Slack-ish. Returns null if the input can't produce anything meaningful
 * (caller should reject with 400).
 */
export function slugifyChannelName(raw: string): string | null {
  const s = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return s.length === 0 ? null : s;
}
