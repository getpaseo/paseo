# Proposal: plugin customization of built-in UI

Status: draft for maintainer feedback. None of the APIs proposed here exist yet.

## User workflow

A user wants to change the shape, icon, label, and presentation of the Send button,
model and thinking selectors, usage summaries, and sidebar without maintaining a
fork of the app. They should be able to install a plugin, select its presentation,
and keep receiving official Paseo updates.

Today, plugin themes change colours. Composer items and header buttons add controls;
they do not replace built-in controls. Sidebar views already replace the sidebar's
content. This proposal extends those contracts rather than introducing CSS injection
or access to private app components.

## Existing extension points

| Surface                                 | Existing API                                                | Proposed addition                                                                  |
| --------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Buttons and fields                      | `addTheme`, `addHeaderButton`, `addComposerPill`            | Validated geometry tokens and built-in control content renderers                   |
| Model, mode, thinking, provider options | `addComposerItem`, `useComposer`                            | Replace built-in trigger content and optionally the selector's option presentation |
| Send and Stop                           | Host-owned composer actions                                 | Replace their visual content while preserving host actions and state               |
| Usage                                   | Server usage sources                                        | Read-only usage presentation data and a summary renderer                           |
| Sidebar                                 | `addSidebarView`, header/footer items, workspace row badges | Reuse these APIs; expose row geometry through themes                               |

The current author contract remains in [the plugin reference](../public-docs/plugins/reference.md).

## Theme geometry

Extend `addTheme` with an optional `geometry` object containing semantic tokens:

| Token                  | Proposed range, in logical pixels | Applies to                      |
| ---------------------- | --------------------------------- | ------------------------------- |
| `buttonRadius`         | 0–24                              | Standard buttons                |
| `selectorRadius`       | 0–24                              | Picker triggers                 |
| `composerActionRadius` | 0–24                              | Send and Stop visuals           |
| `sidebarRowRadius`     | 0–24                              | Built-in sidebar row highlights |
| `usageRadius`          | 0–24                              | Usage summary controls          |

Missing tokens keep the built-in values. Validate finite numbers at registration,
reject unknown tokens, and keep the defaults unchanged. Themes change visual shape,
not minimum touch targets, focus outlines, disabled behavior, or overflow rules.
Existing Appearance typography settings continue to own font sizes.

A theme is already an explicit user choice. Geometry follows that same selection,
including restoration of defaults when its plugin is removed. Do not add a second
global style registry or support arbitrary React Native style objects in themes.

## Built-in content renderers

Proposed client registration: `addControlRenderer({ id, title, target, Component })`.
It returns the same idempotent cleanup function as other client contributions.
The initial target set is closed:

- `composer-send`
- `composer-stop`
- `composer-model`
- `composer-mode`
- `composer-thinking`
- `composer-provider-option`
- `usage-summary`

Each component receives the existing `PluginHostProps`, default content as `children`,
and a discriminated `control` snapshot. It can preserve, wrap, or replace that content.
The host retains the outer pressable, accessible name and role, keyboard shortcut,
focus handling, tooltip, disabled state, and action dispatch. Renderers must contain
presentation only, with no nested pressables or focusable descendants. The host wraps
the rendered subtree with pointer events and accessibility descendants disabled.

| Control kind | Read-only snapshot                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Send         | Action label, enabled/disabled, pending, send/steer/queue behavior                                                                          |
| Stop         | Action label, enabled/disabled, pending cancellation                                                                                        |
| Selector     | Stable control ID, label, selected value and label, open, disabled, loading                                                                 |
| Usage        | Source/window IDs, display labels, units, used/remaining meaning, displayed percentage, reset time when supplied, loading/error/stale state |

Never send prompt text, account credentials, or an entire internal store through
these snapshots. Usage values retain their source's units and meaning; money,
tokens, and percentages must remain distinguishable. Missing values remain absent,
not zero. Copy and freeze snapshots at the boundary, following existing plugin
state conventions.

A Send renderer cannot submit directly, enable a locked composer, or turn Stop into
Send. Selection, creation, permission handling, and cancellation still run through
the host's existing commands. Plugins that need extra actions use composer items.

## Selector option presentation

Trigger customization alone does not cover a different layout of model or thinking
options. A separate proposed `addSelectorRenderer` registration can replace a
selector's option content while Paseo retains its anchored popover or compact sheet.

Pass a typed, read-only catalog with stable option IDs, labels, descriptions,
selection, availability, and loading/error state. Expose `select(id)` through the
same host command used by the built-in picker. Resolve against the current catalog
at invocation, enforce locks and disabled options there, and surface pending and
rejected changes through the existing error path. A stale renderer cannot select an
option removed after it rendered.

Model catalogs retain provider identity and provider availability. Preserve the
built-in retry, search, profile, and navigation capabilities when the target offers
them; do not flatten a model browser into a list that silently loses these actions.
The exact catalog and command types need agreement before implementing this API.

## Selection and conflicts

Appearance gains a Built-in controls section listing each target and its selected
renderer. Default is always available. Installing a plugin never silently replaces
controls. Two plugins targeting the same control are offered as choices; load order
does not decide which wins.

Persist the qualified plugin/contribution ID per target on the client. Bind a
selected renderer to the control's owning host. Do not execute another host's copy
when that host disconnects. With no owning host or no compatible installation,
render the built-in control. Sidebar view selection stays with its existing setting.

The same plugin may register distinct renderers for different targets. Explicit
selection is per target; there is no implicit renderer priority or override chain.

## Lifecycle and recovery

Registrations use the existing installation lifetime, translation runtime, RPC
context, and query cache. Hot reload removes the old registration before mounting
the replacement. Cleanup, disable, removal, and disconnect restore default content
without losing the draft, selected model, current usage data, or keyboard focus.

Each renderer has an error boundary that restores the built-in content when it
throws. Reset the boundary on installation or renderer changes. Keep the failure
visible in plugin diagnostics so fallback does not hide a broken installation.
Keep a Settings route and a Default choice outside plugin-rendered surfaces.

The app owns placement, measurement, compact overflow, minimum touch targets, and
retained-panel activity. Renderers receive `layout.compact` and theme tokens;
they do not use DOM selectors, injected stylesheets, app internals, or web-only
components. Follow the existing [SDK runtime boundaries](plugins.md#sdk-import-boundaries).

Declare the introducing client and daemon version in `requirements.paseo` once a
release is assigned. Do not invent a version in examples. No new wire protocol is
needed for local content registration; any added usage or catalog data crossing the
wire follows [protocol compatibility](protocol-compatibility.md).

## Implementation and acceptance

Land geometry and content rendering first, then the selector catalog contract after
its navigation and command semantics are agreed. Reuse the existing sidebar APIs
throughout. This draft changes documentation only.

Before an implementation is ready for review:

- Test registration validation, cleanup, hot reload, conflicting registrations,
  explicit selection, missing plugins, host isolation, and error recovery.
- Verify unchanged built-in rendering when no customization is selected.
- Exercise enabled, disabled, loading, open, failed, and stale states with a real
  plugin through the existing browser test suites.
- Prove Send/Stop, steer/queue, keyboard shortcuts, accessible names, focus return,
  and selector rejection still use host behavior with custom content selected.
- Check full model browsing, profiles, provider retry, and option changes while a
  custom selector is open.
- Verify usage loading, errors, missing/reset data, multiple sources, and the
  used/remaining preference without changing the reported values.
- Capture desktop and compact screenshots, native iOS/Android interaction evidence,
  and theme changes. Check retained tabs and renderer removal with a draft present.
- Provide a small example plugin exercising Send, a selector, usage, and an existing
  sidebar view. Include its typecheck and the minimum version in the public docs.

## Maintainer decisions

Does the content-only boundary plus geometry cover the desired customization? Should
selector option rendering ship separately? Should renderer selection live beside
themes or in each plugin's settings? These are open design questions, not approved
product direction.
