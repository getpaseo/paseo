import type { PluginSubscriptionContract } from "@getpaseo/plugin";
import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { assertPluginWireValue } from "@getpaseo/protocol/binary-frames/index";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";

export type PluginSubscriptionHandler = (
  input: unknown,
  context: PluginSubscriptionContext,
) => unknown;

interface ActiveSubscription {
  controller: AbortController;
}

interface SubscriptionChannel {
  send(message: PluginProcessMessage): void;
  sendAndWait(message: PluginProcessMessage): Promise<void>;
}

type SubscribeRequest = Extract<PluginProcessRequest, { type: "subscribe" }>;

/**
 * The plugin subprocess side of subscriptions: one handler call per subscriber, an abort signal
 * that fires on release, and `push` that validates each event and resolves when it left the
 * process.
 */
export class PluginSubscriptionHandlers {
  private readonly registered = new Map<
    string,
    { contract: PluginSubscriptionContract; handler: PluginSubscriptionHandler }
  >();
  private readonly active = new Map<string, ActiveSubscription>();
  private readonly channel: SubscriptionChannel;

  constructor(channel: SubscriptionChannel) {
    this.channel = channel;
  }

  has(name: string): boolean {
    return this.registered.has(name);
  }

  register(contract: PluginSubscriptionContract, handler: PluginSubscriptionHandler): void {
    this.registered.set(contract.name, { contract, handler });
  }

  catalog(): string[] {
    return [...this.registered.keys()].sort();
  }

  start(message: SubscribeRequest, paseo: PaseoApi): void {
    const { requestId, subscriptionId } = message;
    const registered = this.registered.get(message.method);
    if (!registered) {
      this.channel.send({
        type: "error",
        requestId,
        error: `Unknown subscription: ${message.method}`,
      });
      return;
    }
    const parsed = registered.contract.input.safeParse(message.input);
    if (!parsed.success) {
      this.channel.send({
        type: "error",
        requestId,
        error: `Invalid input for ${message.method}: ${parsed.error.message}`,
      });
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    let acknowledge = () => {};
    const acknowledged = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const push = async (event: unknown): Promise<void> => {
      if (signal.aborted) return;
      // The receiver parses into the schema's output; sending that output would parse it twice.
      registered.contract.event.parse(event);
      assertPluginWireValue(event, "event");
      // Events pushed while the handler runs follow the acknowledgement.
      await acknowledged;
      if (signal.aborted) return;
      await this.channel.sendAndWait({ type: "subscription.event", subscriptionId, event });
    };
    this.active.set(subscriptionId, { controller });
    let result: unknown;
    try {
      result = registered.handler(parsed.data, { paseo, push, signal });
    } catch (error) {
      this.active.delete(subscriptionId);
      controller.abort();
      this.channel.send({ type: "error", requestId, error: describeError(error) });
      return;
    }
    this.channel.send({ type: "result", requestId, output: null });
    acknowledge();
    if (result instanceof Promise)
      result.then(
        () => this.close(subscriptionId),
        (error: unknown) => this.close(subscriptionId, describeError(error)),
      );
  }

  /** The daemon released the subscription; it needs no closed message back. */
  release(subscriptionId: string): void {
    const active = this.active.get(subscriptionId);
    if (!active) return;
    this.active.delete(subscriptionId);
    active.controller.abort();
  }

  releaseAll(): void {
    for (const subscriptionId of this.active.keys()) this.release(subscriptionId);
  }

  private close(subscriptionId: string, error?: string): void {
    if (!this.active.has(subscriptionId)) return;
    this.release(subscriptionId);
    this.channel.send({
      type: "subscription.closed",
      subscriptionId,
      ...(error === undefined ? {} : { error }),
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
