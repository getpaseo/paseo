import type { SessionInboundMessage, SessionOutboundMessage } from "./messages.js";
import type { DeviceCredentials } from "./device-credentials.js";

export interface DeviceAccess {
  issue(source: object, label: string): ReturnType<DeviceCredentials["issue"]>;
  list(source: object): ReturnType<DeviceCredentials["list"]>;
  revoke(source: object, id: string): Promise<boolean>;
  disconnectRevoked(): void;
  mintToken(source: object): string | undefined;
}
export type DeviceAccessRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "access.device_credentials.issue.request"
      | "access.device_credentials.list.request"
      | "access.device_credentials.revoke.request";
  }
>;
export async function executeDeviceAccess(
  access: DeviceAccess,
  source: object,
  msg: DeviceAccessRequest,
): Promise<SessionOutboundMessage> {
  switch (msg.type) {
    case "access.device_credentials.issue.request":
      return {
        type: "access.device_credentials.issue.response",
        payload: { requestId: msg.requestId, ...(await access.issue(source, msg.label)) },
      };
    case "access.device_credentials.list.request":
      return {
        type: "access.device_credentials.list.response",
        payload: { requestId: msg.requestId, credentials: access.list(source) },
      };
    case "access.device_credentials.revoke.request":
      return {
        type: "access.device_credentials.revoke.response",
        payload: { requestId: msg.requestId, revoked: await access.revoke(source, msg.id) },
      };
  }
}
