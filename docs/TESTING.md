# Testing

## Philosophy

Tests prove behavior, not structure. Every test should answer: "what user-visible or API-visible behavior does this verify?"

## Test-driven development

Work in vertical slices: one test, one implementation, repeat. Each test responds to what you learned from the previous cycle.

```
RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3

WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5
```

Writing all tests first then all implementation produces bad tests — you end up testing imagined behavior instead of actual behavior.

## Determinism first

Tests must produce the same result every run:

- No conditional assertions or branching paths
- No reliance on timing, randomness, or network jitter
- No weak assertions (`toBeTruthy`, `toBeDefined`)
- Assert the full intended behavior, not fragments

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

## Flaky tests are a bug

Never remove a test because it's flaky. Find the variance source (time, randomness, race condition, shared state, non-deterministic output, environment drift) and fix it.

## Real dependencies over mocks

Mocks are not the default. They require an explicit decision.

- **Database**: real test database, not a mock
- **APIs**: real APIs with test/sandbox credentials, not request mocks
- **File system**: temporary directory that gets cleaned up, not fs mocks

Ask: "will this still hold with real dependencies at runtime?" If no, don't mock.

### Use swappable adapters instead

When you need test isolation, design code so dependencies are injectable:

```typescript
interface EmailSender {
  send(to: string, body: string): Promise<void>;
}

// Production
const realSender: EmailSender = { send: sendgrid.send };

// Test: in-memory adapter
function createTestEmailSender() {
  const sent: Array<{ to: string; body: string }> = [];
  return {
    send: async (to: string, body: string) => { sent.push({ to, body }); },
    sent,
  };
}
```

## End-to-end means end-to-end

When a test is labeled end-to-end, it calls the real service. No environment variable gates, no conditional skipping, no mocking the external dependency.

## Test organization

- Collocate tests with implementation: `thing.ts` + `thing.test.ts`
- Extract complex setup into reusable helpers
- Test bodies should read like plain English
- Build a vocabulary of test helpers that make complex flows simple

## Agent authentication in tests

Agent providers handle their own auth. Do not add auth checks, environment variable gates, or conditional skips to tests. If auth fails, report it.

## Debugging with tests

Use the test as your debugging ground:

1. Add temporary logging to the code under test
2. Run the test, observe actual values
3. Trace the flow end-to-end through test output
4. Confirm each assumption with actual output
5. Remove logging when done

The test output is the source of truth, not your reading of the code.

## Design for testability

If code isn't testable, refactor it. Signs:
- You want to reach for a mock
- You can't inject a dependency
- You need to test private internals
- Setup requires too much global state

Aim for deep modules: small interface, deep implementation. Fewer methods = fewer tests needed, simpler params = simpler setup.
