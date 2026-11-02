# Composer controls

Install this directory as a plugin and open the agent, draft, or New workspace composer. Three
controls appear beside the model and thinking controls.

| Control              | Component | What it does                                                            |
| -------------------- | --------- | ----------------------------------------------------------------------- |
| **Context length**   | `Select`  | Saves `composer-controls.contextLength` in the agent's metadata.        |
| **Needs review**     | `Toggle`  | Sets or clears `composer-controls.needsReview` in the agent's metadata. |
| **Insert checklist** | `Action`  | Inserts a task list at the cursor through `composer.insertText`.        |

Each component calls `useComposer()` and uses the same commands in every composer. Paseo draws the
controls inline when the composer has room and as rows in the composer's overflow sheet when it
does not, including on a phone.

[client/controls.tsx](client/controls.tsx) holds the three components; [index.client.tsx](index.client.tsx)
registers them with `addComposerItem`.
