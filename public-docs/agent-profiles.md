---
title: Agent profiles
description: Save agent settings for one-click selection and use notes to guide delegation for UI work, planning, and reviews.
nav: Agent profiles
order: 32
category: Orchestration
---

# Agent profiles

Save the settings you use together as a named profile. Choose **UI work**, **Planning**, or **Review** when creating an agent instead of selecting its model, thinking level, and mode each time.

- **For you:** one selection applies the saved provider, model, mode, thinking level, and available feature settings.
- **For an orchestrating agent:** profile notes explain when to choose those settings for delegated work.

## Create a profile

1. Open **Settings → your host → Agents → Agent profiles**.
2. Select **New profile** and give it a name, such as **UI work**.
3. Choose its provider, model, mode, thinking level, and any available features.
4. Fill in **When to use** with the kind of work this profile should handle.
5. Select **Save**.

Profiles are saved on that host. The available settings depend on the provider and model you choose.

## Save general agent settings

At the top of **Settings → your host → Agents**, use **Settings profile** to switch
between named system prompts, Paseo/browser tool settings, agent profile lists and
orchestration skill selections. **New profile** copies
the current settings. Select the new profile, then edit the system prompt and tool
switches below it. Your changes are saved to that profile. Rename or remove a profile
under **Manage profiles**; at least one profile remains.

Each settings profile owns its provider/model profile list. Switching loads that list
and its selected orchestration skills. Skill files live in the providers’ shared
directories; use the existing skill install/update actions to apply a selection to disk.
Switching profiles alone does not install or delete skill files.

When starting a chat, open the model menu and choose a settings profile from the tabs
at the top. Profiles belong to the host running the chat and are available from any
connected device. The selected host's profile is the default.
Each chat keeps the settings captured when it starts,
so you can run a reverse engineering chat alongside a coding or review chat. Editing,
switching or removing a host profile does not change existing chats. The captured
profile name appears inside the chat's model menu.

Imported provider sessions also capture the host's selected settings profile.
Subagents created through a chat's Paseo tools inherit that chat's captured profile,
even if the host default has since changed.

Saving settings or model presets targets the profile you were editing. If another
client changed the profiles while you were managing them, Paseo asks you to reload
before applying an outdated change.

## Apply settings in one click

When creating an agent, open the model picker and select a saved profile under **Profiles**. Paseo applies its settings together; you can still adjust them before sending your prompt.

Changing a saved profile affects future selections. It does not update agents you already launched.

## Guide delegation with notes

The **When to use** field is the profile's notes. Paseo exposes these notes through its tools so an orchestrating agent can read them before choosing how to launch a worker.

Give each profile a clear specialty:

| Profile  | Example notes                                                                                |
| -------- | -------------------------------------------------------------------------------------------- |
| UI work  | Use for components, layout, styling, and visual polish.                                      |
| Planning | Use for architecture, investigating root causes, and comparing implementation approaches.    |
| Review   | Use for independent review of diffs, correctness, missing tests, and unnecessary complexity. |

Each profile can use a different provider and model, or different settings for the same model.

After [enabling Paseo tools](/docs/orchestration#get-started), ask:

> Check my Paseo profiles and their notes. Choose one for the settings-page UI change, then use a review profile for an independent review of the diff.

The orchestrator reads the profiles, selects settings for each task, and launches the workers. Notes guide that choice; put the worker's actual assignment in its task prompt.

The bundled [Paseo skill](/docs/skills#paseo-paseo-reference) instructs agents to check profiles and read their notes before delegating. If none fit, it directs the agent to discover configured providers and models and tell you about the fallback.

See [Common workflows](/docs/orchestration-workflows) for delegation examples or the [MCP reference](/docs/mcp#agent-profiles) for the tool interface.
