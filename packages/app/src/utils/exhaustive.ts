export function assertUnreachable(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}
