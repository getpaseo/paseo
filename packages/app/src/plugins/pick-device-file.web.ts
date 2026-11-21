import { isWeb } from "@/constants/platform";
import type { DeviceFileSelection } from "./pick-device-file.types";

export function pickDeviceFile(): Promise<DeviceFileSelection | null> {
  if (!isWeb) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0];
        input.remove();
        resolve(
          file
            ? {
                name: file.name,
                size: file.size,
                read: async () => new Uint8Array(await file.slice(0, file.size + 1).arrayBuffer()),
              }
            : null,
        );
      },
      { once: true },
    );
    input.addEventListener(
      "cancel",
      () => {
        input.remove();
        resolve(null);
      },
      { once: true },
    );
    document.body.appendChild(input);
    try {
      input.click();
    } catch (error) {
      input.remove();
      reject(error);
    }
  });
}
