export function findDeepLinkInArgv<TTarget>(
  argv: string[],
  parse: (input: string) => TTarget | null,
): TTarget | null {
  for (const arg of argv) {
    const target = parse(arg);
    if (target) {
      return target;
    }
  }
  return null;
}

/** Holds a deep link for a window until its renderer says it can take one. */
export class DeepLinkInbox<TTarget> {
  private readonly readyWindows = new Set<number>();
  private readonly pendingByWindow = new Map<number, TTarget>();

  windowLoading(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
  }

  windowReady(webContentsId: number): TTarget | null {
    this.readyWindows.add(webContentsId);
    const pending = this.pendingByWindow.get(webContentsId) ?? null;
    this.pendingByWindow.delete(webContentsId);
    return pending;
  }

  deliverOrQueue(webContentsId: number, target: TTarget): TTarget | null {
    if (this.readyWindows.has(webContentsId)) {
      return target;
    }
    this.pendingByWindow.set(webContentsId, target);
    return null;
  }

  removeWindow(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
    this.pendingByWindow.delete(webContentsId);
  }
}
