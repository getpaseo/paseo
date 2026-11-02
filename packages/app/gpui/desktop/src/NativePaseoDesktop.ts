import { TurboModuleRegistry, type TurboModule } from "react-native";
export interface Spec extends TurboModule {
  sqlite(sql: string, params: string): string;
  locale(): string;
  timezone(): string;
  sha256(text: string): string;
  randomBytes(length: number): Array<number>;
}
export default TurboModuleRegistry.getEnforcing<Spec>("PaseoDesktop");
