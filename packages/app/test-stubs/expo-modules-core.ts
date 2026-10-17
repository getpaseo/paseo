// Test stub for expo-modules-core. Its native-module registry imports TurboModuleRegistry from
// react-native, which react-native-web does not export, so any expo package that reaches this
// module breaks the browser bundle. Tests never touch a native module.
export function requireNativeModule(): never {
  throw new Error("Native modules are not available in browser tests");
}

export function requireOptionalNativeModule(): null {
  return null;
}

export function requireOptionalNativeModuleView(): null {
  return null;
}

export const NativeModulesProxy: Record<string, unknown> = {};

export class NativeModule {
  readonly __testStub = true;
}

export class UnavailabilityError extends Error {
  code = "E_UNAVAILABLE";

  constructor(moduleName: string, propertyName: string) {
    super(`The method or property ${moduleName}.${propertyName} is not available`);
  }
}

export class CodedError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface EventSubscription {
  remove: () => void;
}

export function uuid(): string {
  return "test-uuid";
}

export const NativeModulesConstants = {};
