export interface BrowserFindOptions {
  findNext: boolean;
  forward: boolean;
}

export interface BrowserFindResult {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

export interface BrowserFindPort {
  findInPage: (query: string, options: BrowserFindOptions) => Promise<number | null>;
  stopFindInPage: (action: "clearSelection") => Promise<void> | void;
}

export interface BrowserFindSequencerHandlers {
  onUnavailable: () => void;
  onResult: (result: BrowserFindResult) => void;
}

/**
 * Serializes Electron find-in-page requests and accepts results only for the
 * latest request. The component owns display state; this module owns the
 * asynchronous request identity boundary.
 */
export function createBrowserFindSequencer(
  port: BrowserFindPort,
  handlers: BrowserFindSequencerHandlers,
) {
  let requestSequence = 0;
  let activeRequestId: number | null = null;

  function invalidate() {
    requestSequence += 1;
    activeRequestId = null;
  }

  function request(query: string, options: BrowserFindOptions) {
    const sequence = requestSequence + 1;
    requestSequence = sequence;
    activeRequestId = null;

    void port.findInPage(query, options).then(
      (requestId) => {
        if (requestSequence !== sequence) {
          return null;
        }
        if (requestId === null) {
          handlers.onUnavailable();
          return null;
        }
        activeRequestId = requestId;
        return null;
      },
      () => {
        if (requestSequence === sequence) {
          handlers.onUnavailable();
        }
        return null;
      },
    );
  }

  function receive(result: BrowserFindResult) {
    if (result.requestId !== activeRequestId) {
      return;
    }
    handlers.onResult(result);
  }

  function clear() {
    invalidate();
    void port.stopFindInPage("clearSelection");
  }

  return { request, receive, invalidate, clear };
}
