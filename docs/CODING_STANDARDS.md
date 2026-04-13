# Coding Standards

These standards apply to all code changes: features, bug fixes, refactors, and performance work.

## Core principles

- **Zero complexity budget** — justify every abstraction with specific benefits
- **Fully typed TypeScript** — no `any`, no untyped boundaries
- **YAGNI** — build features and abstractions only when needed
- **Functional and declarative** over object-oriented
- **`interface`** over `type` when possible
- **`function` declarations** over arrow function assignments
- **Single-purpose functions** — one function, one job
- **Design for edge cases through types** rather than explicit handling
- **Don't catch errors** unless there's a strong reason to
- **No index.ts barrel files** that only re-export — they create unnecessary indirection
- **No "while I'm at it" improvements** — stay focused on the task

## Type hygiene

### Infer from schemas

Never hand-write a TypeScript type that can be inferred from a Zod schema.

```typescript
// Bad: duplicate type that can drift
const schema = z.object({ procedure: z.string(), args: z.record(z.unknown()) });
type RPCArgs = { procedure: string; args: Record<string, unknown> };

// Good: infer from schema
type RPCArgs = z.infer<typeof schema>;
```

### Named types over inline

No complex inline types in public function signatures.

```typescript
// Bad
function enqueueJob(input: { userId: string; priority: "low" | "normal" | "high" }) {}

// Good
interface EnqueueJobInput { userId: string; priority: "low" | "normal" | "high" }
function enqueueJob(input: EnqueueJobInput) {}
```

### Object parameters

If a function needs more than one argument, use a single object parameter.

```typescript
// Bad: positional args
function createToolCall(provider: string, toolName: string, payload: unknown) {}

// Good: object param
interface CreateToolCallInput { provider: string; toolName: string; payload: unknown }
function createToolCall(input: CreateToolCallInput) {}
```

### One canonical type per concept

Don't redefine the same concept in different layer-specific shapes (`RpcX`, `DbX`, `UiX`). Keep one canonical type and add explicit layer wrappers that reference it.

```typescript
// Bad: duplicated fields across layers
type RpcToolCall = { toolName: string; args: Record<string, unknown>; requestId: string };
type DbToolCall = { toolName: string; args: Record<string, unknown>; id: string; createdAt: Date };

// Good: canonical type + wrappers
type ToolCall = { toolName: string; args: Record<string, unknown> };
type ToolCallRequest = { requestId: string; toolCall: ToolCall };
type ToolCallRecord = { id: string; createdAt: Date; toolCall: ToolCall };
```

## Make impossible states impossible

Use discriminated unions instead of bags of booleans and optionals.

```typescript
// Bad
interface FetchState { isLoading: boolean; error?: Error; data?: Data }

// Good
type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "success"; data: Data };
```

## Optionality is a design decision

Don't mark fields optional to avoid migrations. Decide deliberately:

1. Is optionality actually needed?
2. If there are distinct valid states → discriminated union
3. If value can be intentionally empty → explicit `null`
4. Keep optionality at real boundaries (external input), then resolve it

## Validate at boundaries, trust internally

Parse external data once at the boundary with schema validation. Then use typed values everywhere else.

```typescript
// Bad: optional chaining because shape is unclear
const value = response?.data?.items?.[0]?.name;

// Good: validate at boundary, trust the types
const parsed = responseSchema.parse(rawResponse);
const value = parsed.data.items[0].name;
```

## Error handling

- **Fail explicitly** — if caller requests X and X is unavailable, throw rather than silently returning Y
- **Use typed domain errors** — not plain `Error`. Carry structured metadata for handling, logging, and user messaging
- **Preserve error semantics** — don't collapse meaningful typed errors into generic `Error`

```typescript
class TimeoutError extends Error {
  constructor(
    public readonly operation: string,
    public readonly waitedMs: number,
  ) {
    super(`${operation} timed out after ${waitedMs}ms`);
    this.name = "TimeoutError";
  }
}
```

## Keep logic density low

Avoid packing branching, lookup, and transformation into single dense expressions.

```typescript
// Bad: nested ternaries + inline lookups
const billing = shouldUseLegacy(account)
  ? getLegacy(account)
  : buildBilling(account, rates.find((r) => r.region === account.region));

// Good: named steps, then assemble
const rate = rates.find((r) => r.region === account.region);
if (!rate) throw new MissingRateError(account.region);
const billing = shouldUseLegacy(account) ? getLegacy(account) : buildBilling(account, rate);
```

## Centralize policy

When the same discriminator (`plan`, `provider`, `kind`, `status`) is checked across multiple files, centralize it into a policy model. A new case should require editing one place, not many.

## React: keep components dumb

- Components render state and dispatch events — they don't compute transitions
- If a component has more than two interacting `useState` calls, extract a state machine or reducer
- `useRef` for mutable coordination state (flags, timers) is a smell — model states explicitly
- Never mirror a source of truth into local state; derive from it
- Test state logic as pure functions without rendering

## File organization

- Organize by domain first (`providers/claude/`), not by technical type (`tool-parsers/`)
- Name files after the main export (`create-toolcall.ts`)
- Use `index.ts` as an entrypoint, not a dumping ground
- Collocate tests with implementation (`thing.ts` + `thing.test.ts`)

## Refactoring contract

Refactoring is structure work, not feature work.

- Preserve behavior by default, especially user-facing behavior
- Do not remove features to simplify code without explicit approval
- Have a verification strategy before you start
- Fully migrate callers and remove old paths in the same refactor
- No fallback behavior by default — prefer explicit error over silent degradation
