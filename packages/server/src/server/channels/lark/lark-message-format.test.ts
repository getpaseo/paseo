import { describe, expect, test } from "vitest";
import { getLarkEventDedupeKey, normalizeLarkMessageEvent } from "./lark-message-format.js";

describe("lark-message-format", () => {
  test("normalizes message id, thread id, and topic name", () => {
    const event = normalizeLarkMessageEvent({
      event_id: "evt_1",
      sender: {
        sender_name: "Alice",
        sender_id: {
          open_id: "ou_1",
          union_id: "on_1",
        },
      },
      message: {
        message_id: "om_1",
        chat_id: "oc_1",
        thread_id: "omt_1",
        root_id: "om_root",
        topic_name: "Launch checklist",
        message_type: "text",
        content: JSON.stringify({ text: "Please review the release." }),
      },
    });

    expect(event).toMatchObject({
      eventId: "evt_1",
      messageId: "om_1",
      chatId: "oc_1",
      threadId: "omt_1",
      rootMessageId: "om_root",
      topicName: "Launch checklist",
      text: "Please review the release.",
    });
    expect(event ? getLarkEventDedupeKey(event) : null).toBe("evt_1:omt_1:om_1");
  });

  test("derives a topic name from the first sentence when Lark does not provide one", () => {
    const event = normalizeLarkMessageEvent({
      event_id: "evt_2",
      sender: { sender_name: "Alice", sender_id: {} },
      message: {
        message_id: "om_2",
        chat_id: "oc_1",
        message_type: "text",
        content: JSON.stringify({ text: "Short question. Please ignore the rest." }),
      },
    });

    expect(event?.topicName).toBe("Short question");
  });

  test("ignores an empty Lark topic name and falls back to the first sentence", () => {
    const event = normalizeLarkMessageEvent({
      event_id: "evt_3",
      sender: { sender_name: "Alice", sender_id: {} },
      message: {
        message_id: "om_3",
        chat_id: "oc_1",
        topic_name: "   ",
        message_type: "text",
        content: JSON.stringify({ text: "请帮我总结这个需求。第二句不应该进入标题。" }),
      },
    });

    expect(event?.topicName).toBe("请帮我总结这个需求");
  });
});
