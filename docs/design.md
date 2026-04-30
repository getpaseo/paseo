# Designing Features

How to think through a feature before writing code.

## Start from the user

Even for backend work, start from the user's perspective:

- What problem does this solve?
- What triggers it? User action, schedule, event?
- What does success look like from the user's perspective?
- What data does it need? Where does that data come from?

## Map existing code

Before designing anything new, understand what exists:

- Where does similar functionality live?
- What patterns does the codebase already use?
- What layers exist? (See [architecture.md](./architecture.md))
- What types and data shapes are already defined?

New features rarely mean only new code. Usually they require modifying existing interfaces, extending existing types, or refactoring to accommodate the new functionality. Identify what needs to change, not just what needs to be added.

## Define verification before implementation

Before designing the solution, define how you'll know it works:

- What tests will prove this feature is correct?
- At what layer? Unit, integration, E2E?
- What's the simplest way to verify the core behavior?

If you can't define verification, you don't understand the feature well enough yet.

## Design the shape

### Data

- What types are needed?
- Use discriminated unions — make impossible states impossible
- One canonical type per concept (see [coding-standards.md](./coding-standards.md))

### Layers

- What belongs in each layer?
- Where are the boundaries?
- What does each layer expose to the layer above?

### Interactions

- How does data flow through the system?
- What triggers what?
- Where do side effects happen?

### Refactoring

- What existing code needs to change?
- Is existing code testable enough? If not, that's part of the plan.

## Create a concrete plan

Once the design is clear:

1. **Acceptance criteria** — specific, verifiable outcomes (not "should work well" but "returns X when given Y")
2. **Ordered steps** — what to build first (usually: types, then lowest layer, then up)
3. **What to refactor** before adding new code
4. **How to verify** each step

## Principles

- **Fit, don't force** — new code should fit existing patterns, or refactor first
- **Simple** — the best design is the simplest one that works
- **Verify early** — define how to test before designing the implementation
