# Forms

The paved road for building forms in the app. The schedule form is the golden
example; when building or fixing any form, copy its shape, not the shape of
whatever screen you happen to be near.

Golden example files:

- `packages/app/src/schedules/schedule-form-model.ts` (+ `.test.ts`) — the model
- `packages/app/src/schedules/use-schedule-form-model.ts` — model lifetime adapter
- `packages/app/src/schedules/use-schedule-form-provider-snapshot.ts` — async input adapter
- `packages/app/src/components/schedules/schedule-form-sheet.tsx` — render + intent dispatch
- `packages/app/src/schedules/aggregated-schedules.ts` / `hooks/use-schedules.ts` — load-state gating
- `packages/app/e2e/schedules-*.spec.ts` — the behavioral contract

## The form model

Every non-trivial form gets a **plain TypeScript model** — zero React imports:

- `openXxxForm(snapshot)` **constructs** a fresh instance from declared inputs
  (mode, the record being edited, hosts, defaults). Edit mode seeds every value
  AND display from the snapshot — never from a previous instance.
- **Commands** mutate (`setHost`, `setProject(value, display)`, `setModel`, …).
  Derived state (disclosure, canSubmit, displays) is recomputed inside the
  model on every publish.
- `close()` destroys the instance. `subscribe`/`getState` feed one
  `useSyncExternalStore` in the component.

The component renders state and dispatches intent. That is all it does.

### Lifecycle rules (each one killed a real shipped bug)

1. **Fresh mount per open.** The sheet returns `null` when not visible and
   mounts the open form with a `key` derived from mode + record identity.
   A long-lived component instance shared across create/edit is how edit
   contaminated create.
2. **Construct the model ONCE per mount** — `useState(() => openXxxForm(snapshot))`.
   NEVER `useMemo(() => open(...), [snapshot])`: the snapshot's identity depends
   on live data (projects, hosts, preferences), and any background churn — e.g.
   a scheduled run creating a workspace — would reconstruct the model and wipe
   the user's in-progress input.
3. **Late data is an explicit model input, not a reconstruction.**
   `applyProviderSnapshot(serverId, …)`, `applyProjectTargets(…)`,
   `applyHosts(…)`. Adapters pipe identity changes into these with mechanical
   effects. Input plumbing is fine; orchestration effects are not — the sheet
   itself has zero `useEffect`/`useRef`, and that is the target for every form.
4. **Resolution is explicit model state, per host** (`idle | pending |
complete`), keyed off the opened snapshot's serverId. Waiting for data is a
   state you can render, not an effect race.
5. **Displays are owned state.** The selected option's label is captured at
   selection/seed time (`setProject(value, display)`), never re-derived from a
   live options list — list churn must not flicker or blank a selection.
6. **Disclosure is derived in the model** from user intent
   (host → project → model → thinking/mode), so fields cannot pop in from
   cache timing.

## Form kit

- Compose `Field` / `SelectField` / `FormTextInput` / `SegmentedControl` /
  `Switch` from `components/ui/`. Geometry (heights, padding, radii, focus/hover
  states) is owned by `components/ui/control-geometry.ts` — controls never
  declare their own, and screens never nudge global component styles to align
  a row.
- The form declares one size for all fields: `sm` on desktop, `md` compact
  (`useIsCompactFormFactor`).
- Availability hierarchy: a field whose capability doesn't apply is **hidden**
  (isolation on a non-git project — same gating as New Workspace), not rendered
  disabled with an explanation. Disabled-with-a-reason `hint` is only for
  transient states the user can resolve.
- Copy is opt-in and rare. No hint/subtext unless the maintainer approved the
  exact string; validation errors are the exception. State a fact (like the
  timezone) once — never in a preview line AND a helper line.
- `useUnistyles` is banned (see docs/unistyles.md); lint enforces.

## Data gating

Aggregate hooks return a discriminated load state:

```ts
type AggregateLoadState<T> =
  | { status: "connecting" } // an answer may still be pending
  | { status: "loading" }
  | { status: "loaded"; data: T[] };
```

Empty states are only typeable inside `loaded` — a fetch that "succeeded"
before hosts connected is `connecting`, not empty. Query keys carry real fetch
inputs (host set, connection statuses), never synthetic version counters.

## Anti-patterns (reject in review on sight)

- `useEffect` choreography impersonating construct/hydrate/resolve/destroy.
- One mounted form instance serving create and edit.
- `useMemo`-keyed model construction on live-data identity.
- Selected labels derived from live query lists.
- `isLoading`/`isEmpty` boolean bags where a load-state union belongs.
- Conditional mounting of hint/error rows that shifts layout (subtext renders
  only when present, but the pattern for that lives in `Field`, not ad hoc).
