import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type Mode = 'left' | 'right';

export type Meta = {
  name: string;
  extra?: Object;
  list?: Array<Object>;
};

export type Options = {
  type: string;
  label?: string;
  count: Int32;
  mode: Mode;
  ratio?: number | null;
  nested: { flag: boolean; names: Array<string> };
};

export enum Level {
  Low = 'low',
  High = 'high',
}

export enum Rank {
  Low = 0,
  High = 1,
}

export interface Spec extends TurboModule {
  scalar(text: string, count: number, whole: Int32, flag: boolean): boolean;
  optionalValue(maybe?: string, nullable: string | null): string | null;
  lists(
    items: Array<string>,
    readonlyItems: ReadonlyArray<number>,
  ): Array<Int32>;
  options(value: Options, again: Options): Options;
  meta(value: Meta): Meta;
  level(level: Level): Mode;
  rank(value: Rank): Rank;
  match(text: string): string;
  anything(value: Object): UnsafeObject;
  nothing(): void;
  inline(value: { x: number; y?: string }): void;
  later(text: string): Promise<string>;
  done(): Promise<void>;
  lookup(key: string, callback: (value: string, found: boolean) => void): void;
  lookupLater(
    key: string,
    callback: (value: string, found: boolean) => void,
  ): Promise<string>;
  sum(data: ArrayBuffer): number;
  reversed(data: ArrayBuffer): ArrayBuffer;
  start(steps: number): void;
  readonly onProgress: CodegenTypes.EventEmitter<number>;
  readonly onDone: CodegenTypes.EventEmitter<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeProbe');
