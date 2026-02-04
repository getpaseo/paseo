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
  "webSocketFactory" | "transportFactory"
>;
export type CreateAgentOptions = CreateAgentRequestOptions;
export { type SendMessageOptions, type DaemonEvent, type DaemonEventHandler };

export class DaemonClient extends SharedDaemonClient {
  constructor(config: DaemonClientConfig) {
    super({
      ...config,
      webSocketFactory: (url, options) =>
        new WebSocket(url, { headers: options?.headers }) as unknown as WebSocketLike,
    });
  }
}
