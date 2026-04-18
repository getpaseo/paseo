# Plan Approval Normalization

## Goal

Normalize plan approval across providers so the UI renders one consistent plan approval card and action row, while each provider keeps its own execution quirks behind the session permission interface.

## Compatibility Constraints

- Older clients must remain compatible with newer daemons.
- All new wire fields must be optional.
- Existing plan permissions without action metadata must still render and work.
- Existing question permissions must keep their current behavior.

## Design

### Shared abstraction

Add optional permission action definitions to the shared permission request/response types.

- Permission requests may include `actions`.
- Permission responses may include `selectedActionId`.
- `kind: "plan"` remains the normalized concept for plan approval.
- The UI renders actions from the permission request instead of hardcoding provider-specific buttons.

### Claude

Keep Claude's plan permission flow, but enrich it with explicit action definitions.

- Always expose `Reject`.
- Always expose `Implement`.
- If the agent entered plan mode from a more permissive mode like `bypassPermissions`, also expose `Implement with <previous mode>`.
- Resolve the selected action entirely inside `respondToPermission()`.

### Codex

Synthesize a normalized `kind: "plan"` permission after a Codex plan-mode turn completes with a plan result.

- Emit a plan permission with `Reject` and `Implement` actions.
- On `Implement`, disable `plan_mode`, disable `fast_mode`, and automatically start a follow-up implementation turn.
- On `Reject`, resolve without starting a follow-up turn.
- Keep the implementation prompt and state transitions inside the Codex provider.

### Manager and state sync

After permission resolution, refresh provider-derived state so the UI sees internal mode/feature changes without knowing provider quirks.

- Refresh current mode
- Refresh pending permissions
- Refresh runtime info
- Refresh features
- Persist refreshed state

### UI

Render plan permissions through the existing plan card, but generate buttons from normalized permission actions.

- If `actions` are absent, fall back to legacy buttons.
- Plan cards should use `Implement` as the default primary label.
- Do not add provider-specific rendering branches.

## Verification

1. Shared schema/type tests for optional `actions` and `selectedActionId`
2. App tests for generic plan-action rendering
3. Claude tests for third action when resuming from a more permissive mode
4. Codex tests for synthetic plan approval and automatic implementation follow-up
5. Manager tests for post-permission state refresh
6. `npm run typecheck`
