import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./claude-agent.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const sdkMocks = vi.hoisted(() => ({
  query: vi.fn(),
  firstQuery: null as QueryMock | null,
  secondQuery: null as QueryMock | null,
  releaseOldAssistant: null as (() => void) | null,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: sdkMocks.query,
}));

type QueryMock = {
  next: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  return: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  supportedModels: ReturnType<typeof vi.fn>;
  supportedCommands: ReturnType<typeof vi.fn>;
  rewindFiles: ReturnType<typeof vi.fn>;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildUsage() {
  return {
    input_tokens: 1,
    cache_read_input_tokens: 0,
    output_tokens: 1,
  };
}

function createPromptUuidReader(prompt: AsyncIterable<unknown>) {
  const iterator = prompt[Symbol.asyncIterator]();
  let cached: Promise<string | null> | null = null;
  return async () => {
    if (!cached) {
      cached = iterator.next().then((next) => {
        if (next.done) {
          return null;
        }
        const value = next.value as { uuid?: unknown } | undefined;
        return typeof value?.uuid === "string" ? value.uuid : null;
      });
    }
    return cached;
  };
}

function buildFirstQueryMock(
  allowOldAssistant: Promise<void>
): QueryMock {
  let step = 0;
  return {
    next: vi.fn(async () => {
      if (step === 0) {
        step += 1;
        return {
          done: false,
          value: {
            type: "system",
            subtype: "init",
            session_id: "interrupt-regression-session",
            permissionMode: "default",
            model: "opus",
          },
        };
      }
      if (step === 1) {
        await allowOldAssistant;
        step += 1;
        return {
          done: false,
          value: {
            type: "assistant",
            message: {
              content: "OLD_TURN_RESPONSE",
            },
          },
        };
      }
      if (step === 2) {
        step += 1;
        return {
          done: false,
          value: {
            type: "result",
            subtype: "success",
            usage: buildUsage(),
            total_cost_usd: 0,
          },
        };
      }
      return { done: true, value: undefined };
    }),
    interrupt: vi.fn(async () => {
      throw new Error("simulated interrupt failure");
    }),
    return: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
  };
}

function buildSecondQueryMock(prompt: AsyncIterable<unknown>): QueryMock {
  const readPromptUuid = createPromptUuidReader(prompt);
  let step = 0;
  return {
    next: vi.fn(async () => {
      if (step === 0) {
        step += 1;
        return {
          done: false,
          value: {
            type: "system",
            subtype: "init",
            session_id: "interrupt-regression-session",
            permissionMode: "default",
            model: "opus",
          },
        };
      }
      if (step === 1) {
        step += 1;
        const promptUuid = (await readPromptUuid()) ?? "missing-prompt-uuid";
        return {
          done: false,
          value: {
            type: "user",
            message: { role: "user", content: "second prompt" },
            parent_tool_use_id: null,
            uuid: promptUuid,
            session_id: "interrupt-regression-session",
            isReplay: true,
          },
        };
      }
      if (step === 2) {
        step += 1;
        return {
          done: false,
          value: {
            type: "assistant",
            message: {
              content: "NEW_TURN_RESPONSE",
            },
          },
        };
      }
      if (step === 3) {
        step += 1;
        return {
          done: false,
          value: {
            type: "result",
            subtype: "success",
            usage: buildUsage(),
            total_cost_usd: 0,
          },
        };
      }
      return { done: true, value: undefined };
    }),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
  };
}

async function collectUntilTerminal(
  stream: AsyncGenerator<AgentStreamEvent>
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      break;
    }
  }
  return events;
}

function collectAssistantText(events: AgentStreamEvent[]): string {
  return events
    .filter(
      (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
        event.type === "timeline" && event.item.type === "assistant_message"
    )
    .map((event) => event.item.text)
    .join("");
}

function createTimedIteratorReader<T>(params: { iterator: AsyncIterator<T> }) {
  const { iterator } = params;
  let pendingNext: Promise<IteratorResult<T>> | null = null;

  return {
    async nextWithTimeout(timeoutMs: number): Promise<IteratorResult<T>> {
      if (!pendingNext) {
        pendingNext = iterator.next();
      }
      const timeout = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeoutMs);
      });
      const outcome = await Promise.race([
        pendingNext.then((result) => ({ kind: "result" as const, result })),
        timeout.then(() => ({ kind: "timeout" as const })),
      ]);
      if (outcome.kind === "timeout") {
        throw new Error("Timed out waiting for live event");
      }
      pendingNext = null;
      return outcome.result;
    },
  };
}

describe("ClaudeAgentSession interrupt restart regression", () => {
  beforeEach(() => {
    const allowOldAssistant = deferred<void>();
    let queryCreateCount = 0;

    sdkMocks.query.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        queryCreateCount += 1;
        if (queryCreateCount === 1) {
          const mock = buildFirstQueryMock(allowOldAssistant.promise);
          sdkMocks.firstQuery = mock;
          return mock;
        }
        const mock = buildSecondQueryMock(prompt);
        if (queryCreateCount === 2) {
          sdkMocks.secondQuery = mock;
        }
        return mock;
      }
    );
    sdkMocks.releaseOldAssistant = () => allowOldAssistant.resolve();
  });

  afterEach(() => {
    sdkMocks.query.mockReset();
    sdkMocks.firstQuery = null;
    sdkMocks.secondQuery = null;
    sdkMocks.releaseOldAssistant = null;
  });

  test("starts a fresh query after interrupt failure to avoid stale old-turn response", async () => {
    const logger = createTestLogger();
    const client = new ClaudeAgentClient({ logger });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    const firstTurn = session.stream("first prompt");
    await firstTurn.next();

    const secondTurnPromise = collectUntilTerminal(session.stream("second prompt"));
    await Promise.resolve();
    sdkMocks.releaseOldAssistant?.();

    const secondTurnEvents = await secondTurnPromise;
    const secondAssistantText = collectAssistantText(secondTurnEvents);

    expect(sdkMocks.firstQuery).toBeTruthy();
    expect(sdkMocks.secondQuery).toBeTruthy();
    expect(sdkMocks.firstQuery).not.toBe(sdkMocks.secondQuery);
    expect(sdkMocks.firstQuery?.interrupt).toHaveBeenCalledTimes(2);
    expect(sdkMocks.secondQuery?.next).toHaveBeenCalled();
    expect(secondAssistantText).toContain("NEW_TURN_RESPONSE");
    expect(secondAssistantText).not.toContain("OLD_TURN_RESPONSE");

    await firstTurn.return?.();
    await session.close();
  });

  test("ignores stale task-notification assistant/result events queued before the current prompt", async () => {
    const logger = createTestLogger();

    sdkMocks.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const readPromptUuid = createPromptUuidReader(prompt);
      let step = 0;
      return {
        next: vi.fn(async () => {
          if (step === 0) {
            step += 1;
            return {
              done: false,
              value: {
                type: "system",
                subtype: "init",
                session_id: "task-notification-session",
                permissionMode: "default",
                model: "opus",
              },
            };
          }
          if (step === 1) {
            step += 1;
            return {
              done: false,
              value: {
                type: "system",
                subtype: "task_notification",
                task_id: "task-123",
                status: "completed",
                output_file: "/tmp/task-123.txt",
                summary: "Codex agent is done",
                session_id: "task-notification-session",
                uuid: "task-note-1",
              },
            };
          }
          if (step === 2) {
            step += 1;
            return {
              done: false,
              value: {
                type: "assistant",
                message: {
                  content: "STALE_TASK_NOTIFICATION_RESPONSE",
                },
              },
            };
          }
          if (step === 3) {
            step += 1;
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                usage: buildUsage(),
                total_cost_usd: 0,
              },
            };
          }
          if (step === 4) {
            step += 1;
            const promptUuid = (await readPromptUuid()) ?? "missing-prompt-uuid";
            return {
              done: false,
              value: {
                type: "user",
                message: { role: "user", content: "current prompt" },
                parent_tool_use_id: null,
                uuid: promptUuid,
                session_id: "task-notification-session",
                isReplay: true,
              },
            };
          }
          if (step === 5) {
            step += 1;
            return {
              done: false,
              value: {
                type: "assistant",
                message: {
                  content: "CURRENT_PROMPT_RESPONSE",
                },
              },
            };
          }
          if (step === 6) {
            step += 1;
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                usage: buildUsage(),
                total_cost_usd: 0,
              },
            };
          }
          return { done: true, value: undefined };
        }),
        interrupt: vi.fn(async () => undefined),
        return: vi.fn(async () => undefined),
        setPermissionMode: vi.fn(async () => undefined),
        setModel: vi.fn(async () => undefined),
        supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
        supportedCommands: vi.fn(async () => []),
        rewindFiles: vi.fn(async () => ({ canRewind: true })),
      } satisfies QueryMock;
    });

    const client = new ClaudeAgentClient({ logger });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    const events = await collectUntilTerminal(session.stream("current prompt"));
    const assistantText = collectAssistantText(events);

    expect(assistantText).toContain("CURRENT_PROMPT_RESPONSE");
    expect(assistantText).not.toContain("STALE_TASK_NOTIFICATION_RESPONSE");

    await session.close();
  });

  test("ignores stale task-notification message_start bursts before prompt replay", async () => {
    const logger = createTestLogger();

    sdkMocks.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const readPromptUuid = createPromptUuidReader(prompt);
      let step = 0;
      return {
        next: vi.fn(async () => {
          if (step === 0) {
            step += 1;
            return {
              done: false,
              value: {
                type: "system",
                subtype: "init",
                session_id: "task-notification-message-start-session",
                permissionMode: "default",
                model: "opus",
              },
            };
          }
          if (step === 1) {
            step += 1;
            return {
              done: false,
              value: {
                type: "system",
                subtype: "task_notification",
                task_id: "task-msg-start-1",
                status: "completed",
                output_file: "/tmp/task-msg-start-1.txt",
                summary: "Background task finished",
                session_id: "task-notification-message-start-session",
                uuid: "task-msg-start-note-1",
              },
            };
          }
          if (step === 2) {
            step += 1;
            return {
              done: false,
              value: {
                type: "stream_event",
                parent_tool_use_id: null,
                event: {
                  type: "message_start",
                  message: {
                    id: "stale-msg-start-1",
                    role: "assistant",
                    model: "opus",
                    usage: { input_tokens: 1, output_tokens: 0 },
                  },
                },
              },
            };
          }
          if (step === 3) {
            step += 1;
            return {
              done: false,
              value: {
                type: "assistant",
                message: {
                  content: "STALE_MESSAGE_START_RESPONSE",
                },
              },
            };
          }
          if (step === 4) {
            step += 1;
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                usage: buildUsage(),
                total_cost_usd: 0,
              },
            };
          }
          if (step === 5) {
            step += 1;
            const promptUuid = (await readPromptUuid()) ?? "missing-prompt-uuid";
            return {
              done: false,
              value: {
                type: "user",
                message: { role: "user", content: "current prompt" },
                parent_tool_use_id: null,
                uuid: promptUuid,
                session_id: "task-notification-message-start-session",
                isReplay: true,
              },
            };
          }
          if (step === 6) {
            step += 1;
            return {
              done: false,
              value: {
                type: "assistant",
                message: {
                  content: "CURRENT_AFTER_MESSAGE_START",
                },
              },
            };
          }
          if (step === 7) {
            step += 1;
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                usage: buildUsage(),
                total_cost_usd: 0,
              },
            };
          }
          return { done: true, value: undefined };
        }),
        interrupt: vi.fn(async () => undefined),
        return: vi.fn(async () => undefined),
        setPermissionMode: vi.fn(async () => undefined),
        setModel: vi.fn(async () => undefined),
        supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
        supportedCommands: vi.fn(async () => []),
        rewindFiles: vi.fn(async () => ({ canRewind: true })),
      } satisfies QueryMock;
    });

    const client = new ClaudeAgentClient({ logger });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    const events = await collectUntilTerminal(session.stream("current prompt"));
    const assistantText = collectAssistantText(events);

    expect(assistantText).toContain("CURRENT_AFTER_MESSAGE_START");
    expect(assistantText).not.toContain("STALE_MESSAGE_START_RESPONSE");

    await session.close();
  });

  test("ignores stale user-shaped task-notification message_start bursts before prompt replay", async () => {
    const logger = createTestLogger();

    sdkMocks.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const readPromptUuid = createPromptUuidReader(prompt);
      let step = 0;
      return {
        next: vi.fn(async () => {
          if (step === 0) {
            step += 1;
            return {
              done: false,
              value: {
                type: "system",
                subtype: "init",
                session_id: "task-notification-user-message-start-session",
                permissionMode: "default",
                model: "opus",
              },
            };
          }
          if (step === 1) {
            step += 1;
            return {
              done: false,
              value: {
                type: "user",
                message: {
                  role: "user",
                  content:
                    "<task-notification>\n<task-id>task-msg-start-user-1</task-id>\n</task-notification>",
                },
                parent_tool_use_id: null,
                uuid: "task-msg-start-user-1",
                session_id: "task-notification-user-message-start-session",
              },
            };
          }
          if (step === 2) {
            step += 1;
            return {
              done: false,
              value: {
                type: "stream_event",
                parent_tool_use_id: null,
                event: {
                  type: "message_start",
                  message: {
                    id: "stale-user-msg-start-1",
                    role: "assistant",
                    model: "opus",
                    usage: { input_tokens: 1, output_tokens: 0 },
                  },
                },
              },
            };
          }
          if (step === 3) {
            step += 1;
            return {
              done: false,
              value: {
                type: "assistant",
                message: {
                  content: "STALE_USER_TASK_NOTIFICATION_RESPONSE",
                },
              },
            };
          }
          if (step === 4) {
            step += 1;
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                usage: buildUsage(),
                total_cost_usd: 0,
              },
            };
          }
          if (step === 5) {
            step += 1;
            const promptUuid = (await readPromptUuid()) ?? "missing-prompt-uuid";
            return {
              done: false,
              value: {
                type: "user",
                message: { role: "user", content: "current prompt" },
                parent_tool_use_id: null,
                uuid: promptUuid,
                session_id: "task-notification-user-message-start-session",
                isReplay: true,
              },
            };
          }
          if (step === 6) {
            step += 1;
            return {
              done: false,
              value: {
                type: "assistant",
                message: {
                  content: "CURRENT_AFTER_USER_MESSAGE_START",
                },
              },
            };
          }
          if (step === 7) {
            step += 1;
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                usage: buildUsage(),
                total_cost_usd: 0,
              },
            };
          }
          return { done: true, value: undefined };
        }),
        interrupt: vi.fn(async () => undefined),
        return: vi.fn(async () => undefined),
        setPermissionMode: vi.fn(async () => undefined),
        setModel: vi.fn(async () => undefined),
        supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
        supportedCommands: vi.fn(async () => []),
        rewindFiles: vi.fn(async () => ({ canRewind: true })),
      } satisfies QueryMock;
    });

    const client = new ClaudeAgentClient({ logger });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    const events = await collectUntilTerminal(session.stream("current prompt"));
    const assistantText = collectAssistantText(events);

    expect(assistantText).toContain("CURRENT_AFTER_USER_MESSAGE_START");
    expect(assistantText).not.toContain("STALE_USER_TASK_NOTIFICATION_RESPONSE");

    await session.close();
  });

  test("does not terminate the current prompt on a stale pre-prompt result event", async () => {
    const logger = createTestLogger();

    sdkMocks.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const readPromptUuid = createPromptUuidReader(prompt);
      let step = 0;
      return {
        next: vi.fn(async () => {
          if (step === 0) {
            step += 1;
            return {
              done: false,
              value: {
                type: "system",
                subtype: "init",
                session_id: "stale-result-session",
                permissionMode: "default",
                model: "opus",
              },
            };
          }
          if (step === 1) {
            step += 1;
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                usage: buildUsage(),
                total_cost_usd: 0,
              },
            };
          }
          if (step === 2) {
            step += 1;
            const promptUuid = (await readPromptUuid()) ?? "missing-prompt-uuid";
            return {
              done: false,
              value: {
                type: "user",
                message: { role: "user", content: "current prompt" },
                parent_tool_use_id: null,
                uuid: promptUuid,
                session_id: "stale-result-session",
                isReplay: true,
              },
            };
          }
          if (step === 3) {
            step += 1;
            return {
              done: false,
              value: {
                type: "assistant",
                message: {
                  content: "FRESH_AFTER_STALE_RESULT",
                },
              },
            };
          }
          if (step === 4) {
            step += 1;
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                usage: buildUsage(),
                total_cost_usd: 0,
              },
            };
          }
          return { done: true, value: undefined };
        }),
        interrupt: vi.fn(async () => undefined),
        return: vi.fn(async () => undefined),
        setPermissionMode: vi.fn(async () => undefined),
        setModel: vi.fn(async () => undefined),
        supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
        supportedCommands: vi.fn(async () => []),
        rewindFiles: vi.fn(async () => ({ canRewind: true })),
      } satisfies QueryMock;
    });

    const client = new ClaudeAgentClient({ logger });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    const events = await collectUntilTerminal(session.stream("current prompt"));
    const assistantText = collectAssistantText(events);

    expect(assistantText).toContain("FRESH_AFTER_STALE_RESULT");

    await session.close();
  });

  test("emits autonomous live events from SDK stream when Claude wakes itself", async () => {
    const logger = createTestLogger();
    let queryCreateCount = 0;
    let localPromptUuid: string | null = null;

    sdkMocks.query.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        queryCreateCount += 1;
        if (queryCreateCount === 1) {
          const readPromptUuid = createPromptUuidReader(prompt);
          let step = 0;
          return {
            next: vi.fn(async () => {
              if (step === 0) {
                step += 1;
                return {
                  done: false,
                  value: {
                    type: "system",
                    subtype: "init",
                    session_id: "live-autonomous-session",
                    permissionMode: "default",
                    model: "opus",
                  },
                };
              }
              if (step === 1) {
                step += 1;
                localPromptUuid = (await readPromptUuid()) ?? "missing-prompt-uuid";
                return {
                  done: false,
                  value: {
                    type: "user",
                    message: { role: "user", content: "seed prompt" },
                    parent_tool_use_id: null,
                    uuid: localPromptUuid,
                    session_id: "live-autonomous-session",
                    isReplay: true,
                  },
                };
              }
              if (step === 2) {
                step += 1;
                return {
                  done: false,
                  value: {
                    type: "assistant",
                    message: { content: "SEED_DONE" },
                  },
                };
              }
              if (step === 3) {
                step += 1;
                return {
                  done: false,
                  value: {
                    type: "result",
                    subtype: "success",
                    usage: buildUsage(),
                    total_cost_usd: 0,
                  },
                };
              }
              return { done: true, value: undefined };
            }),
            interrupt: vi.fn(async () => undefined),
            return: vi.fn(async () => undefined),
            setPermissionMode: vi.fn(async () => undefined),
            setModel: vi.fn(async () => undefined),
            supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
            supportedCommands: vi.fn(async () => []),
            rewindFiles: vi.fn(async () => ({ canRewind: true })),
          } satisfies QueryMock;
        }

        let step = 0;
        return {
          next: vi.fn(async () => {
            if (step === 0) {
              step += 1;
              return {
                done: false,
                value: {
                  type: "user",
                  message: {
                    role: "user",
                    content:
                      "<task-notification>\n<task-id>bg-1</task-id>\n<status>completed</status>\n</task-notification>",
                  },
                  parent_tool_use_id: null,
                  uuid: "task-note-user-1",
                  session_id: "live-autonomous-session",
                },
              };
            }
            if (step === 1) {
              step += 1;
              return {
                done: false,
                value: {
                  type: "assistant",
                  message: { content: "AUTONOMOUS_WAKE_RESPONSE" },
                },
              };
            }
            if (step === 2) {
              step += 1;
              return {
                done: false,
                value: {
                  type: "result",
                  subtype: "success",
                  usage: buildUsage(),
                  total_cost_usd: 0,
                },
              };
            }
            return { done: true, value: undefined };
          }),
          interrupt: vi.fn(async () => undefined),
          return: vi.fn(async () => undefined),
          setPermissionMode: vi.fn(async () => undefined),
          setModel: vi.fn(async () => undefined),
          supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
          supportedCommands: vi.fn(async () => []),
          rewindFiles: vi.fn(async () => ({ canRewind: true })),
        } satisfies QueryMock;
      }
    );

    const client = new ClaudeAgentClient({ logger });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    await collectUntilTerminal(session.stream("seed prompt"));
    expect(localPromptUuid).toBeTruthy();
    expect(session.describePersistence()?.sessionId).toBe("live-autonomous-session");
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const activeTurnPromise = (
        session as unknown as { activeTurnPromise?: Promise<void> | null }
      ).activeTurnPromise;
      if (!activeTurnPromise) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      (session as unknown as { activeTurnPromise?: Promise<void> | null })
        .activeTurnPromise ?? null
    ).toBeNull();

    const liveIterator = (
      session as unknown as {
        streamLiveEvents: () => AsyncGenerator<AgentStreamEvent>;
      }
    ).streamLiveEvents();
    const timedReader = createTimedIteratorReader({ iterator: liveIterator });
    const liveEvents: AgentStreamEvent[] = [];

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const next = await timedReader.nextWithTimeout(5_000);
      if (next.done) {
        break;
      }
      liveEvents.push(next.value);
      if (next.value.type === "turn_completed") {
        break;
      }
    }

    expect(liveEvents.some((event) => event.type === "turn_started")).toBe(true);
    expect(
      liveEvents.some(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("AUTONOMOUS_WAKE_RESPONSE")
      )
    ).toBe(true);
    expect(liveEvents.some((event) => event.type === "turn_completed")).toBe(true);

    await liveIterator.return?.();
    await session.close();
  });

  test("releases local-turn suppression when task notifications arrive as user payloads", async () => {
    const logger = createTestLogger();
    let queryCreateCount = 0;
    let localPromptUuid: string | null = null;

    sdkMocks.query.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        queryCreateCount += 1;
        if (queryCreateCount === 1) {
          const readPromptUuid = createPromptUuidReader(prompt);
          let step = 0;
          return {
            next: vi.fn(async () => {
              if (step === 0) {
                step += 1;
                return {
                  done: false,
                  value: {
                    type: "system",
                    subtype: "init",
                    session_id: "live-task-user-session",
                    permissionMode: "default",
                    model: "opus",
                  },
                };
              }
              if (step === 1) {
                step += 1;
                localPromptUuid = (await readPromptUuid()) ?? "missing-prompt-uuid";
                return {
                  done: false,
                  value: {
                    type: "user",
                    message: { role: "user", content: "seed prompt" },
                    parent_tool_use_id: null,
                    uuid: localPromptUuid,
                    session_id: "live-task-user-session",
                    isReplay: true,
                  },
                };
              }
              if (step === 2) {
                step += 1;
                return {
                  done: false,
                  value: {
                    type: "assistant",
                    message: { content: "SEED_DONE" },
                  },
                };
              }
              if (step === 3) {
                step += 1;
                return {
                  done: false,
                  value: {
                    type: "result",
                    subtype: "success",
                    usage: buildUsage(),
                    total_cost_usd: 0,
                  },
                };
              }
              return { done: true, value: undefined };
            }),
            interrupt: vi.fn(async () => undefined),
            return: vi.fn(async () => undefined),
            setPermissionMode: vi.fn(async () => undefined),
            setModel: vi.fn(async () => undefined),
            supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
            supportedCommands: vi.fn(async () => []),
            rewindFiles: vi.fn(async () => ({ canRewind: true })),
          } satisfies QueryMock;
        }

        let step = 0;
        return {
          next: vi.fn(async () => {
            if (step === 0) {
              step += 1;
              return {
                done: false,
                value: {
                  type: "user",
                  message: { role: "user", content: "seed prompt" },
                  parent_tool_use_id: null,
                  uuid: localPromptUuid ?? "missing-prompt-uuid",
                  session_id: "live-task-user-session",
                  isReplay: true,
                },
              };
            }
            if (step === 1) {
              step += 1;
              return {
                done: false,
                value: {
                  type: "assistant",
                  message: { content: "SHOULD_STAY_SUPPRESSED" },
                },
              };
            }
            if (step === 2) {
              step += 1;
              return {
                done: false,
                value: {
                  type: "user",
                  message: {
                    role: "user",
                    content:
                      "<task-notification>\n<task-id>bg-1</task-id>\n<status>completed</status>\n</task-notification>",
                  },
                  parent_tool_use_id: null,
                  uuid: "task-note-user-1",
                  session_id: "live-task-user-session",
                },
              };
            }
            if (step === 3) {
              step += 1;
              return {
                done: false,
                value: {
                  type: "assistant",
                  message: { content: "AUTONOMOUS_AFTER_TASK_NOTIFICATION" },
                },
              };
            }
            if (step === 4) {
              step += 1;
              return {
                done: false,
                value: {
                  type: "result",
                  subtype: "success",
                  usage: buildUsage(),
                  total_cost_usd: 0,
                },
              };
            }
            return { done: true, value: undefined };
          }),
          interrupt: vi.fn(async () => undefined),
          return: vi.fn(async () => undefined),
          setPermissionMode: vi.fn(async () => undefined),
          setModel: vi.fn(async () => undefined),
          supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
          supportedCommands: vi.fn(async () => []),
          rewindFiles: vi.fn(async () => ({ canRewind: true })),
        } satisfies QueryMock;
      }
    );

    const client = new ClaudeAgentClient({ logger });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    await collectUntilTerminal(session.stream("seed prompt"));
    expect(localPromptUuid).toBeTruthy();
    expect(session.describePersistence()?.sessionId).toBe("live-task-user-session");
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const activeTurnPromise = (
        session as unknown as { activeTurnPromise?: Promise<void> | null }
      ).activeTurnPromise;
      if (!activeTurnPromise) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      (session as unknown as { activeTurnPromise?: Promise<void> | null })
        .activeTurnPromise ?? null
    ).toBeNull();

    const liveIterator = (
      session as unknown as {
        streamLiveEvents: () => AsyncGenerator<AgentStreamEvent>;
      }
    ).streamLiveEvents();
    const timedReader = createTimedIteratorReader({ iterator: liveIterator });
    const liveEvents: AgentStreamEvent[] = [];

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const next = await timedReader.nextWithTimeout(5_000);
      if (next.done) {
        break;
      }
      liveEvents.push(next.value);
      if (next.value.type === "turn_completed") {
        break;
      }
    }

    expect(
      liveEvents.some(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("SHOULD_STAY_SUPPRESSED")
      )
    ).toBe(false);
    expect(liveEvents.some((event) => event.type === "turn_started")).toBe(true);
    expect(
      liveEvents.some(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("AUTONOMOUS_AFTER_TASK_NOTIFICATION")
      )
    ).toBe(true);

    await liveIterator.return?.();
    await session.close();
  });
});
