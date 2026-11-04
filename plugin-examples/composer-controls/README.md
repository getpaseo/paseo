# Composer controls

Install this directory as a plugin and open the agent, draft, or New workspace composer. Four
controls appear beside the model and thinking controls.

| Control              | Component | What it does                                                                             |
| -------------------- | --------- | ---------------------------------------------------------------------------------------- |
| **Context length**   | `Select`  | Saves `composer-controls.contextLength` in the agent's metadata.                         |
| **Needs review**     | `Toggle`  | Sets or clears `composer-controls.needsReview` in the agent's metadata.                  |
| **Plan first**       | `Toggle`  | Sets the provider option `plan_mode` with `composer.setOptions`; enabled for Codex only. |
| **Insert checklist** | `Action`  | Inserts a task list at the cursor through `composer.insertText`.                         |

Each component calls `useComposer()` and uses the same commands in every composer. Paseo draws the
controls inline when the composer has room and as rows in the composer's overflow sheet when it
does not, including on a phone.

## Reaching a composer from outside it

Two more contributions use a composer without sitting in one. Both name the agent instead of
reading the composer they are mounted in, and neither needs the agent's tab to be open.

| Contribution                         | What it does                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Composer tools** (Explorer panel)  | `useComposers({ focused: true })` inserts the checklist into the focused agent's prompt.                 |
| **Mark for review** (Command Center) | `composers({ agentId })` sets the same `needsReview` metadata as the toggle, for the agent you selected. |

[client/controls.tsx](client/controls.tsx) holds the four composer components,
[client/panel.tsx](client/panel.tsx) the panel, and [index.client.tsx](index.client.tsx) registers
everything.
