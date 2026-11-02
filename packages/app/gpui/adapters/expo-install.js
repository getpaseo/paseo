import {
  EventEmitter,
  NativeModule,
  SharedObject,
  SharedRef,
} from "expo-modules-core/src/polyfill/CoreModule";
export function ensureNativeModulesAreInstalled() {
  if (globalThis.expo) return;
  globalThis.expo = { EventEmitter, NativeModule, SharedObject, SharedRef, modules: {} };
}
ensureNativeModulesAreInstalled();
