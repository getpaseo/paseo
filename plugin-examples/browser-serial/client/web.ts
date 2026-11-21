import { Platform } from "react-native";
import type { SerialBrowser, SerialPort } from "./session";

// Browser globals stay in this web-gated adapter; do not add DOM lib to the plugin.
declare const navigator: { serial?: { requestPort(): Promise<SerialPort> }; userAgent: string };
declare const isSecureContext: boolean;
declare function btoa(value: string): string;
declare function atob(value: string): string;
declare function addEventListener(name: "pagehide", handler: () => void): void;
declare function removeEventListener(name: "pagehide", handler: () => void): void;

function unavailableReason(): string | null {
  if (Platform.OS !== "web") return "Open Paseo in a desktop browser with Web Serial support.";
  if (/Electron\//.test(navigator.userAgent))
    return "Open Paseo in an external browser. This experiment does not configure Electron device permissions.";
  if (!isSecureContext) return "Use HTTPS or localhost to access browser devices.";
  if (!navigator.serial)
    return "Web Serial is unavailable. Use a supporting desktop browser; Brave may require its Web Serial flag.";
  return null;
}

export function getSerialBrowser(): SerialBrowser {
  const unavailable = unavailableReason();
  return {
    unavailable,
    requestPort() {
      if (Platform.OS !== "web" || unavailable)
        return Promise.reject(new Error(unavailable ?? "Web Serial unavailable."));
      return navigator.serial!.requestPort();
    },
    encode(data) {
      if (Platform.OS !== "web") throw new Error("Web Serial unavailable.");
      return btoa(String.fromCharCode(...data));
    },
    decode(data) {
      if (Platform.OS !== "web") throw new Error("Web Serial unavailable.");
      return Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    },
    onLeave(callback) {
      if (Platform.OS !== "web") return () => {};
      addEventListener("pagehide", callback);
      return () => removeEventListener("pagehide", callback);
    },
  };
}
