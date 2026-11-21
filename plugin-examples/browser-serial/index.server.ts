import type { PluginServerContext } from "@getpaseo/plugin/server";
import { SerialBridge } from "./server/bridge";
import {
  closeBridge,
  createBridge,
  pollBridge,
  renewBridge,
  writeBridge,
  releaseBridge,
} from "./shared/bridge";

export default function contribute(server: PluginServerContext) {
  const bridge = new SerialBridge();
  server.handle(createBridge, () => bridge.create());
  server.handle(pollBridge, (input) => bridge.poll(input.token));
  server.handle(renewBridge, (input) => bridge.renew(input.token));
  server.handle(writeBridge, (input) => bridge.write(input.token, input.data));
  server.handle(closeBridge, (input) => bridge.close(input.token));
  server.handle(releaseBridge, (input) => bridge.release(input.token));
  return () => {
    bridge.dispose();
  };
}
