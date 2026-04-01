---
applyTo: "**/*.{ts,tsx,js,jsx}"
---

# Coding Standards

## Formatter (Biome)

- **Indent:** 2 spaces
- **Line width:** 100 characters
- **Quotes:** double (`"`)
- **Trailing commas:** always
- **Semicolons:** always

Run `npm run format` to auto-fix, `npm run format:check` to verify.

## Core principles

- **Zero complexity budget** — justify every abstraction with specific benefits
- **Fully typed TypeScript** — no `any`, no untyped boundaries
- **YAGNI** — build only what is needed now
- **Functional and declarative** over object-oriented
- **`interface`** over `type` when possible
- **`function` declarations** over arrow function assignments at module scope
- **Single-purpose functions** — one function, one job
- **No index.ts barrel files** that only re-export — they create unnecessary indirection
- **No "while I'm at it" improvements** — stay focused on the task

## Type hygiene

### Infer types from Zod schemas — never duplicate

```typescript
// Bad: hand-written type that can drift from schema
const schema = z.object({ procedure: z.string(), args: z.record(z.unknown()) });
type RPCArgs = { procedure: string; args: Record<string, unknown> };

// Good: infer once
type RPCArgs = z.infer<typeof schema>;
```

### Named types for public function signatures

```typescript
// Bad
function enqueueJob(input: { userId: string; priority: "low" | "normal" | "high" }) {}

// Good
interface EnqueueJobInput { userId: string; priority: "low" | "normal" | "high" }
function enqueueJob(input: EnqueueJobInput) {}
```

### Object parameters when a function takes more than one argument

```typescript
// Bad
function createToolCall(provider: string, toolName: string, payload: unknown) {}

// Good
interface CreateToolCallInput { provider: string; toolName: string; payload: unknown }
function createToolCall(input: CreateToolCallInput) {}
```

### One canonical type per concept

Don't redefine the same data in layer-specific shapes (`RpcX`, `DbX`, `UiX`). Keep one canonical type and compose wrappers around it.

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

## Validate at boundaries, trust internally

Parse external data once at the entry point with a Zod schema. Use typed values everywhere else — no defensive `?.` chains on already-validated data.

## Error handling

- **Fail explicitly** — throw rather than silently returning a fallback
- **Typed domain errors** — extend `Error` with structured metadata
- **Preserve semantics** — don't collapse typed errors into generic `Error`

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

Avoid nested ternaries and packed inline expressions. Extract named intermediate variables.

## Centralize policy

When the same discriminator (`plan`, `provider`, `kind`, `status`) is checked in multiple files, consolidate it into a single policy model.

## React patterns

- Components render state and dispatch events — they don't compute transitions
- More than two interacting `useState` calls → extract a reducer or state machine
- `useRef` for coordination flags is a smell — model states explicitly
- Never mirror a source of truth into local component state; derive from it
- Test state logic as pure functions without rendering

## File organization

- Organize by domain first: `providers/claude/`, not `tool-parsers/`
- File name = main export: `create-toolcall.ts`
- `index.ts` is an entrypoint, not a re-export dumping ground
- Collocate tests with implementation: `thing.ts` + `thing.test.ts`

## Refactoring contract

- Preserve behavior by default, especially user-facing behavior
- Do not remove features to simplify code without explicit approval
- Fully migrate all callers and remove old paths in the same refactor
- No fallback behavior by default — prefer explicit error over silent degradation
