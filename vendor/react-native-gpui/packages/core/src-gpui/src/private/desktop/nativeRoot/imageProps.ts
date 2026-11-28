/**
 * Image props of a component in a native tree. React Native turns what an image
 * prop is given (`require('./x.png')`, `{ uri }`, an array of sources) into a
 * resolved source before a Fabric node sees it; the view config the spec
 * generated says which props that applies to. A native tree instance gets
 * the same: the prop reaches the runtime as one object with `uri`, `scale`,
 * `width` and `height`.
 *
 * @format
 */

declare const require: (name: string) => any;

type Attribute = { process?: unknown } | boolean | null | undefined;

function assetResolver(): any {
  try {
    const loaded = require('react-native/Libraries/Image/resolveAssetSource');
    return loaded?.default ?? loaded;
  } catch {
    return null;
  }
}

function viewConfigRegistry(): any {
  try {
    return require('react-native/Libraries/Renderer/shims/ReactNativeViewConfigRegistry');
  } catch {
    return null;
  }
}

const imagePropsByType = new Map<string, string[]>();

/** The names of the props of `type` that hold an image source. */
function imagePropNames(type: string): string[] {
  const known = imagePropsByType.get(type);
  if (known != null) {
    return known;
  }
  let names: string[] = [];
  const resolver = assetResolver();
  const registry = viewConfigRegistry();
  if (resolver != null && registry != null) {
    try {
      const attributes = registry.get(type)?.validAttributes as
        Record<string, Attribute> | undefined;
      names = Object.keys(attributes ?? {}).filter(name => {
        const attribute = attributes?.[name];
        return (
          typeof attribute === 'object' &&
          attribute != null &&
          (attribute.process === resolver ||
            (attribute.process as any)?.default === resolver)
        );
      });
    } catch {
      return [];
    }
  }
  imagePropsByType.set(type, names);
  return names;
}

function resolveOne(value: unknown): unknown {
  const resolver = assetResolver();
  if (typeof value === 'string') {
    return resolver({ uri: value });
  }
  return resolver(value);
}

/** What an image prop is as the runtime reads it. */
export function resolveImageSource(value: unknown): unknown {
  if (value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    const sources = value
      .map(resolveOne)
      .filter((source): source is { uri?: string } => source != null);
    return sources[0] ?? null;
  }
  return resolveOne(value) ?? null;
}

/** `props` with the image props of `type` resolved. */
export function resolveImageProps<T extends Record<string, unknown>>(
  type: string,
  props: T,
): T {
  const names = imagePropNames(type);
  let resolved: Record<string, unknown> | null = null;
  for (const name of names) {
    if (props[name] === undefined) {
      continue;
    }
    resolved ??= { ...props };
    resolved[name] = resolveImageSource(props[name]);
  }
  return (resolved as T | null) ?? props;
}
