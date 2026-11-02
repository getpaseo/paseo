/** A persistent label resolved in the presenting app's language. */
declare const pluginMessage: unique symbol;
export interface PluginMessage {
  readonly [pluginMessage]: true;
}
export type PluginText = string | PluginMessage;
export interface TranslationResource {
  readonly [key: string]: string | TranslationResource;
}
export interface TranslationOptions {
  readonly count?: number;
  readonly [name: string]: unknown;
}
export type TranslationKey<Resource> = {
  [Key in keyof Resource & string]: Resource[Key] extends string
    ?
        | Key
        | (Key extends `${infer Base}_${"zero" | "one" | "two" | "few" | "many" | "other"}`
            ? Base
            : never)
    : Resource[Key] extends TranslationResource
      ? `${Key}.${TranslationKey<Resource[Key]>}`
      : never;
}[keyof Resource & string];
export interface PluginTranslations<Resource extends TranslationResource = TranslationResource> {
  readonly resources: Readonly<Record<string, TranslationResource>> & { readonly en: Resource };
  message<Key extends TranslationKey<Resource>>(
    key: Key,
    ...args: TranslationArguments<Resource, Key>
  ): PluginMessage;
}

type Lookup<Resource, Key extends string> = Key extends `${infer Head}.${infer Tail}`
  ? Head extends keyof Resource
    ? Lookup<Resource[Head], Tail>
    : never
  : Key extends keyof Resource
    ? Resource[Key]
    : never;
type Trim<Value extends string> = Value extends ` ${infer Rest}` | `${infer Rest} `
  ? Trim<Rest>
  : Value;
type InterpolationName<Value extends string> =
  Trim<Value> extends `-${infer Rest}`
    ? InterpolationName<Rest>
    : Trim<Value> extends `${infer Name},${string}`
      ? Trim<Name>
      : Trim<Value>;
type InterpolationNames<Value> = Value extends string
  ? string extends Value
    ? never
    : Value extends `${string}{{${infer Name}}}${infer Rest}`
      ? InterpolationName<Name> | InterpolationNames<Rest>
      : never
  : never;
type MessageOptions<Resource, Key extends string> = TranslationOptions &
  ([Lookup<Resource, `${Key}_other`>] extends [never] ? {} : { count: number }) & {
    [Name in InterpolationNames<Lookup<Resource, Key> | Lookup<Resource, `${Key}_other`>>]:
      | string
      | number
      | boolean
      | Date;
  };
export type TranslationArguments<Resource, Key extends string> =
  {} extends MessageOptions<Resource, Key>
    ? [options?: MessageOptions<Resource, Key>]
    : [options: MessageOptions<Resource, Key>];
