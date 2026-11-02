// No desktop power-inhibition lease is acquired by this backend yet.
export const isAvailableAsync = async () => false;
export async function activateKeepAwakeAsync() {
  throw new Error("Power inhibition is not available in the GPUI build.");
}
export async function deactivateKeepAwake() {}
