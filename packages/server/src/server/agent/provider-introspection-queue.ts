import type { AgentProvider } from "./agent-sdk-types.js";

export class ProviderIntrospectionQueue {
  private readonly tails = new Map<AgentProvider, Promise<void>>();

  run<T>(provider: AgentProvider, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(provider) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(provider, tail);
    void tail.then(() => {
      if (this.tails.get(provider) === tail) {
        this.tails.delete(provider);
      }
      return undefined;
    });
    return result;
  }
}
