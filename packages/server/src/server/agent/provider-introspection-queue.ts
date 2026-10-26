import type { AgentProvider } from "./agent-sdk-types.js";

export class ProviderIntrospectionQueue {
  private readonly tails = new Map<AgentProvider, Promise<void>>();
  private readonly shared = new Map<
    AgentProvider,
    { start: Promise<void>; finish: () => void; active: number }
  >();

  run<T>(
    provider: AgentProvider,
    operation: () => Promise<T>,
    mode: "exclusive" | "shared" = "exclusive",
  ): Promise<T> {
    if (mode === "shared") {
      let group = this.shared.get(provider);
      if (!group) {
        let finish!: () => void;
        const tail = new Promise<void>((resolve) => {
          finish = resolve;
        });
        group = {
          start: this.tails.get(provider) ?? Promise.resolve(),
          finish,
          active: 0,
        };
        this.shared.set(provider, group);
        this.setTail(provider, tail);
      }
      group.active++;
      const current = group;
      const result = current.start.then(operation);
      void result.then(
        () => this.finishShared(provider, current),
        () => this.finishShared(provider, current),
      );
      return result;
    }

    this.shared.delete(provider);
    const previous = this.tails.get(provider) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.setTail(provider, tail);
    return result;
  }

  private finishShared(
    provider: AgentProvider,
    group: { finish: () => void; active: number },
  ): void {
    group.active--;
    if (group.active > 0) return;
    if (this.shared.get(provider) === group) this.shared.delete(provider);
    group.finish();
  }

  private setTail(provider: AgentProvider, tail: Promise<void>): void {
    this.tails.set(provider, tail);
    void tail.then(() => {
      if (this.tails.get(provider) === tail) {
        this.tails.delete(provider);
      }
      return undefined;
    });
  }
}
