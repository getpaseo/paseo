import WebSocket from "ws";
import {
  DaemonClient as SharedDaemonClient,
  type DaemonClientConfig as SharedDaemonClientConfig,
  type CreateAgentRequestOptions,
  type DaemonEvent,
  type DaemonEventHandler,
  type SendMessageOptions,
  type WebSocketLike,
} from "../../client/daemon-client.js";

export type DaemonClientConfig = Omit<
  SharedDaemonClientConfig,
  "webSocketFactory" | "transportFactory" | "clientId"
>;
export type CreateAgentOptions = CreateAgentRequestOptions;
export { type SendMessageOptions, type DaemonEvent, type DaemonEventHandler };

let testClientCounter = 0;

function nextTestClientId(): string {
  testClientCounter += 1;
  return `clid_test_client_${testClientCounter}`;
}

export class DaemonClient extends SharedDaemonClient {
  constructor(config: DaemonClientConfig) {
    const clientId = nextTestClientId();
    super({
      ...config,
      clientId,
      webSocketFactory: (url, options) =>
        new WebSocket(url, { headers: options?.headers }) as unknown as WebSocketLike,
    });
  }
}
