import { requireOptionalNativeModule } from "expo-modules-core";

export interface WearNode {
  id: string;
  name: string;
}

export interface WearCommandEvent {
  payload: string;
}

interface ExpoWearBridgeNativeModule {
  isAvailable(): Promise<boolean>;
  getConnectedNodes(): Promise<WearNode[]>;
  publishSnapshot(payload: string): Promise<boolean>;
  publishTranscript(agentId: string, payload: string): Promise<boolean>;
  publishProjectIcon(projectKey: string, dataBase64: string, mimeType: string): Promise<boolean>;
  publishLiveVoice(payload: string): Promise<boolean>;
  clearSnapshot(): Promise<boolean>;
  drainPendingCommands(): Promise<string[]>;
  addListener(
    event: "onWearCommand",
    listener: (event: WearCommandEvent) => void,
  ): { remove(): void };
}

/**
 * Optional on purpose: the native module only exists on Android, and only in
 * builds that include Play Services. iOS, web, and F-Droid builds all get null,
 * and every export below degrades to a no-op rather than throwing.
 *
 * Wear OS dropped iOS support, so there is no iOS implementation to write.
 */
const native = requireOptionalNativeModule<ExpoWearBridgeNativeModule>("ExpoWearBridge");

export const isWearBridgeSupported = native != null;

export async function isWearAvailable(): Promise<boolean> {
  if (!native) return false;
  return native.isAvailable();
}

export async function getConnectedWearNodes(): Promise<WearNode[]> {
  if (!native) return [];
  return native.getConnectedNodes();
}

export async function publishWearSnapshot(payload: string): Promise<boolean> {
  if (!native) return false;
  return native.publishSnapshot(payload);
}

/**
 * Publish one agent's transcript. Each agent gets its own DataItem path, so opening
 * a second agent on the watch doesn't overwrite the first.
 */
export async function publishWearTranscript(agentId: string, payload: string): Promise<boolean> {
  if (!native) return false;
  return native.publishTranscript(agentId, payload);
}

/**
 * Publish one project's icon, keyed by projectKey so every workspace of that project
 * shares it. `dataBase64` is the raw file the daemon found in the repo; the watch
 * screens the format itself and falls back to a colored initial for anything it
 * can't decode, so any mime the daemon returns is safe to send.
 */
export async function publishWearProjectIcon(
  projectKey: string,
  dataBase64: string,
  mimeType: string,
): Promise<boolean> {
  if (!native) return false;
  return native.publishProjectIcon(projectKey, dataBase64, mimeType);
}

/**
 * Publish the single Live Voice state item — phase, host, mute, and the tail of
 * the call transcript. One path, not one per call: there is only ever one call.
 */
export async function publishWearLiveVoice(payload: string): Promise<boolean> {
  if (!native) return false;
  return native.publishLiveVoice(payload);
}

/**
 * Removes everything Paseo published — the snapshot, every agent transcript,
 * every project icon, and the Live Voice state.
 */
export async function clearWearSnapshot(): Promise<boolean> {
  if (!native) return false;
  return native.clearSnapshot();
}

/**
 * Commands that arrived while no JS listener was attached — for example while the
 * app process was killed and Play Services started only the listener service.
 */
export async function drainPendingWearCommands(): Promise<string[]> {
  if (!native) return [];
  return native.drainPendingCommands();
}

export function addWearCommandListener(listener: (payload: string) => void): { remove(): void } {
  if (!native) {
    return { remove: () => undefined };
  }
  return native.addListener("onWearCommand", (event) => listener(event.payload));
}
