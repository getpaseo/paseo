import type { OmpHistoryMapperHooks } from "./message-history.js";
import { mapOmpSystemNoticeToToolCall } from "./system-notice.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";
import { resolveOmpEmittedToolCallId } from "./tool-call-id.js";

export const OMP_HISTORY_MAPPER_HOOKS: OmpHistoryMapperHooks = {
  mapToolDetail: mapOmpToolDetail,
  mapCustomMessage: (text, provider) => {
    const noticeItem = mapOmpSystemNoticeToToolCall(text);
    return noticeItem ? { type: "timeline", provider, item: noticeItem } : null;
  },
  resolveToolCallId: resolveOmpEmittedToolCallId,
};
