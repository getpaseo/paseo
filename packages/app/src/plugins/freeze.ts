// Plugins and the host never share an object: each direction crosses through a deep copy.

function deepCopy<T>(value: T, finish: <V extends object>(copied: V) => V): T {
  if (Array.isArray(value)) {
    return finish(value.map((entry) => deepCopy(entry, finish))) as T;
  }
  if (value !== null && typeof value === "object") {
    return finish(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, deepCopy(entry, finish)]),
      ),
    ) as T;
  }
  return value;
}

/** A deep copy no plugin can change. Plugins read data through it, never the host's own objects. */
export function cloneAndFreeze<T>(value: T): T {
  return deepCopy(value, Object.freeze);
}

/** A deep copy the host owns. Plugin commands hand data in through it, never the plugin's own objects. */
export function ownCopy<T>(value: T): T {
  return deepCopy(value, (copied) => copied);
}
