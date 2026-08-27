import type { MermaidRenderRequest } from "../render-model";

function isCompletedLineCandidate(source: string): boolean {
  return source.endsWith("\n") && source.trim().includes("\n");
}

export class MermaidRuntimeRequestDriver {
  private readyState = false;
  private renderedOnce = false;
  private inFlight: MermaidRenderRequest | null = null;
  private queued: MermaidRenderRequest[] = [];

  update(request: MermaidRenderRequest | null): MermaidRenderRequest | null {
    if (!request || this.hasRevision(request.revision)) {
      return null;
    }
    if (this.renderedOnce) {
      this.queued = [request];
    } else {
      const lastIndex = this.queued.length - 1;
      const last = this.queued[lastIndex];
      if (last && !isCompletedLineCandidate(last.source)) {
        this.queued[lastIndex] = request;
      } else {
        this.queued.push(request);
      }
    }
    return this.takeNext();
  }

  ready(): MermaidRenderRequest | null {
    this.readyState = true;
    return this.takeNext();
  }

  settled(revision: number, rendered: boolean): MermaidRenderRequest | null {
    if (this.inFlight?.revision !== revision) {
      return null;
    }
    this.inFlight = null;
    if (rendered) {
      this.renderedOnce = true;
      const latest = this.queued.at(-1);
      this.queued = latest ? [latest] : [];
    }
    return this.takeNext();
  }

  private hasRevision(revision: number): boolean {
    return (
      this.inFlight?.revision === revision ||
      this.queued.some((request) => request.revision === revision)
    );
  }

  private takeNext(): MermaidRenderRequest | null {
    if (!this.readyState || this.inFlight || this.queued.length === 0) {
      return null;
    }
    this.inFlight = this.queued.shift() ?? null;
    return this.inFlight;
  }
}
