---
applyTo: "**/*.test.{ts,tsx}"
---

# Testing

## Test runner

[Vitest](https://vitest.dev/). Run tests with:

```bash
npm run test              # Full suite
npx vitest run            # Run once (no watch)
npx vitest --watch        # Watch mode
npx vitest path/to/file   # Single file
```

## Philosophy

Tests prove **behavior**, not structure. Every test should answer: *"what user-visible or API-visible behavior does this verify?"*

## TDD workflow — vertical slices

Work one test at a time. Write a test, make it pass, then write the next.

```
RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2

WRONG (horizontal):
  RED:   test1, test2, test3 (all tests first)
  GREEN: impl1, impl2, impl3 (all impl after)
```

Writing all tests before any implementation produces tests for imagined behavior, not actual behavior.

## Determinism requirements

Every test must produce the same result on every run:

- No conditional assertions or branching paths in tests
- No reliance on timing, randomness, or network jitter
- No weak assertions (`toBeTruthy`, `toBeDefined`) — assert the full intended value
- Use `toEqual` with the exact expected shape, not partial matchers when avoidable

```typescript
// Bad: conditional and weak
it("creates a tool call", async () => {
  const result = await createToolCall(input);
  if (result.ok) {
    expect(result.id).toBeDefined();
  }
});

// Good: deterministic and explicit
it("returns timeout error when provider times out", async () => {
  const result = await createToolCall(input);
  expect(result).toEqual({
    ok: false,
    error: { code: "PROVIDER_TIMEOUT", waitedMs: 30000 },
  });
});
```

## Flaky tests are bugs

Never delete a flaky test. Find the variance source (timing, shared state, race conditions, non-deterministic output, environment drift) and fix it.

## Real dependencies over mocks

Mocks are **not** the default — they require an explicit decision.

| Dependency | Preferred approach |
|---|---|
| Database | Real test database |
| External APIs | Real API with test/sandbox credentials |
| File system | Temporary directory, cleaned up after test |

Ask: *"will this assertion still hold with real dependencies at runtime?"* If not, don't mock.

### Use swappable adapters for isolation

When isolation is genuinely needed, design the code to accept injectable dependencies:

```typescript
interface EmailSender {
  send(to: string, body: string): Promise<void>;
}

// Test: in-memory adapter (not a mock library)
function createTestEmailSender() {
  const sent: Array<{ to: string; body: string }> = [];
  return {
    send: async (to: string, body: string) => { sent.push({ to, body }); },
    sent,
  };
}
```

## End-to-end tests

When a test is labeled end-to-end, it calls the real service. No environment variable gates, no conditional skipping, no mocking the external dependency.

## Agent authentication in tests

**Never** add auth checks, environment variable gates, or conditional skips for agent authentication. Agent providers handle their own auth. If auth fails in a test, report the failure — don't hide it.

## Test organization

- Collocate tests with implementation: `thing.ts` + `thing.test.ts`
- Extract complex setup into named helper functions
- Test bodies read like plain English (no cryptic abbreviations)
- Build a vocabulary of test helpers to make complex flows simple

## Debugging with tests

1. Add temporary logging to the code under test
2. Run the test and observe actual values in output
3. Trace the flow end-to-end through test output
4. Confirm each assumption with actual output
5. Remove all temporary logging when done

The **test output** is the source of truth, not your mental model of the code.

## Design for testability

If code is hard to test, refactor it. Signs you need to:

- You reach for a mock library
- You cannot inject a dependency
- You need to test private internals
- Setup requires too much global state

Aim for **deep modules**: small public interface, deep implementation. Fewer methods = fewer tests, simpler parameters = simpler setup.
