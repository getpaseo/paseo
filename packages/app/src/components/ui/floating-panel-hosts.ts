export interface FloatingPanelHostRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MeasurableFloatingPanelHost {
  measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
}

export interface FloatingPanelHosts<T extends MeasurableFloatingPanelHost> {
  register(name: string, host: T): () => void;
  measure(name: string): Promise<FloatingPanelHostRect | null>;
}

function measureHost(host: MeasurableFloatingPanelHost): Promise<FloatingPanelHostRect> {
  return new Promise((resolve) => {
    host.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });
}

/**
 * Hosts are addressed by name, and one name can have several live hosts: a workspace
 * screen mounts its own host while retained copies of that screen stay mounted. Track
 * every host so unmounting one leaves the others measurable.
 */
export function createFloatingPanelHosts<
  T extends MeasurableFloatingPanelHost,
>(): FloatingPanelHosts<T> {
  const hostsByName = new Map<string, T[]>();

  function register(name: string, host: T): () => void {
    const hosts = hostsByName.get(name) ?? [];
    hostsByName.set(name, hosts);
    hosts.push(host);

    return () => {
      const index = hosts.indexOf(host);
      if (index === -1) return;
      hosts.splice(index, 1);
      if (hosts.length === 0 && hostsByName.get(name) === hosts) {
        hostsByName.delete(name);
      }
    };
  }

  async function measure(name: string): Promise<FloatingPanelHostRect | null> {
    const hosts = hostsByName.get(name);
    if (!hosts || hosts.length === 0) return null;

    const rects = await Promise.all(hosts.toReversed().map(measureHost));
    return rects.find((rect) => rect.width > 0 && rect.height > 0) ?? rects[0];
  }

  return { register, measure };
}
