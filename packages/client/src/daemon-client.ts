export * from "./daemon-client-core.js";
import { DaemonClientCore, type DaemonClientConfig } from "./daemon-client-core.js";
import { strictProtocolCodec } from "./daemon-protocol-codec-strict.js";

export class DaemonClient extends DaemonClientCore {
  constructor(config: DaemonClientConfig) {
    super({
      ...config,
      protocolCodec: config.protocolCodec ?? strictProtocolCodec,
    });
  }
}
