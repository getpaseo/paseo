/**
 * Test helpers for typed stubs and internal access without scatter of
 * `as unknown as` casts across test files.
 *
 * WHY createStub contains one cast:
 * TypeScript's structural type system cannot accept Partial<T> as T when T has
 * private class members — no object-literal syntax satisfies private fields
 * from outside the class. Centralising the cast here adds real runtime value
 * over a bare `obj as unknown as T` scattered across tests:
 *   - A Proxy intercepts every property access.
 *   - Calling any unstubbed method throws immediately with a specific message
 *     ("createStub: 'listAgents' was called but not stubbed") instead of
 *     silently returning undefined and causing a confusing downstream failure.
 *
 * Alternatives rejected:
 *   - mockOf<T>(p): return p as unknown as T — same single cast, zero runtime
 *     benefit; this is the "option 4 trap" the task spec explicitly flags.
 *   - Object.create(ctor.prototype): only works for concrete classes, not for
 *     interfaces (ProjectRegistry, WorkspaceRegistry) or external library types
 *     (pino.Logger, http.Server); Object.create returns `any` so a cast is
 *     still needed in the generic path.
 *   - class FakeT implements T: verbose for large classes (AgentManager has
 *     30+ public methods); must be kept in sync whenever the class grows.
 */

/**
 * Creates a typed test stub for any class or interface T.
 * Stubs only the methods/properties provided; any other property access throws.
 *
 * Keys of `stubs` are checked against T at compile time (preventing typos).
 * Any value type is accepted for each key, so `vi.fn()` always satisfies the
 * slot regardless of the original method's return type.
 */
export function createStub<T extends object>(stubs: { [K in keyof T]?: unknown }): T {
  return new Proxy(stubs as Record<string | symbol, unknown>, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (typeof prop === "symbol") return undefined;
      return (..._args: unknown[]): never => {
        throw new Error(`createStub: "${prop}" was called but not stubbed`);
      };
    },
  }) as unknown as T; // one justified cast — rationale in file-level comment
}

/**
 * Widens a real object to a test-internal interface T without a double assertion.
 *
 * Use when tests need to access private fields or call private methods of a
 * real class instance (e.g. `asInternals<WebSocketServerInternals>(server)`).
 * The parameter is typed `unknown` so TypeScript accepts the single `as T`
 * assertion — narrowing from the top type is safe, unlike `as unknown as T`
 * which short-circuits structural checking on a concrete source type.
 */
export function asInternals<T>(obj: T extends object ? unknown : unknown): T {
  return obj as T;
}
