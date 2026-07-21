/** Maximum number of daemon-resolved agent references accepted on one prompt. */
export const MAX_AGENT_CONTEXT_ATTACHMENTS = 5;

/** Maximum curated UTF-8 context contributed by one source agent. */
export const MAX_AGENT_CONTEXT_ATTACHMENT_BYTES = 128 * 1024;

/** Maximum curated UTF-8 context contributed by all agent references on one prompt. */
export const MAX_AGENT_CONTEXT_ATTACHMENTS_TOTAL_BYTES = 384 * 1024;

/** Maximum retained timeline rows inspected for one source agent. */
export const MAX_AGENT_CONTEXT_TIMELINE_SCAN_ROWS = 25_000;
