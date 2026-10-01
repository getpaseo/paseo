import { browserTunnel } from "../../../modules/paseo-browser-tunnel";
export const tunnelHost = {
  ...browserTunnel,
  start: (id: string) => browserTunnel.start(id),
  stop: (id: string) => browserTunnel.stop(id),
  write: (id: string, data: string) => browserTunnel.write(id, data),
  close: (id: string) => browserTunnel.close(id),
  resume: (id: string) => browserTunnel.resume(id),
  onSocket: async (listener: Parameters<typeof browserTunnel.addListener>[1]) => {
    const subscription = browserTunnel.addListener("onTunnelSocket", listener);
    return () => subscription.remove();
  },
};
