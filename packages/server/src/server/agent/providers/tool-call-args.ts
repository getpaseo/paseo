// Models routinely send `null` for optional tool arguments (e.g. read offset/limit); the
// runtimes treat that as omitted, so the mappers must too or the call degrades to an
// unknown card that carries the raw result.
export function omitNullArgs(rawArgs: unknown): unknown {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return rawArgs;
  }
  return Object.fromEntries(Object.entries(rawArgs).filter(([, value]) => value !== null));
}
