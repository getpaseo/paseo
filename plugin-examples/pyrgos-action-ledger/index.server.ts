import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listActionItems } from "./server/list-items";
import { readCapabilities, readPlayback, readSettings, writeSettings } from "./server/voice-files";
import { listActionItemsRpc } from "./shared/list-rpc";
import { getPlaybackRpc, getVoiceSettingsRpc, setVoiceSettingsRpc } from "./shared/voice-rpc";

export default function contribute(server: PluginServerContext) {
  server.handle(listActionItemsRpc, listActionItems);
  server.handle(getVoiceSettingsRpc, async () => ({
    settings: await readSettings(),
    capabilities: await readCapabilities(),
  }));
  server.handle(setVoiceSettingsRpc, (patch) => writeSettings(patch));
  server.handle(getPlaybackRpc, () => readPlayback());
  return () => {};
}
