# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Voice-controlled terminal assistant using OpenAI's Realtime API (via Whisper STT, GPT-4, and TTS). Backend server with Expo app for all platforms (iOS, Android, and Web).

## Monorepo Structure

This is an npm workspace monorepo:

- **Root**: Workspace configuration and shared TypeScript config
- **packages/server**: Backend server (Express + WebSocket API)
- **packages/app**: Cross-platform app (Expo - iOS, Android, Web)

## Environment overrides

- `PASEO_HOME` – path for runtime state such as `agents.json`. Defaults to `~/.paseo`; set this to a unique directory (e.g., `~/.paseo-blue`) when running a secondary server instance.
- `PASEO_PORT` – preferred voice server + MCP port. Overrides `PORT` and defaults to `6767`. Use distinct ports (e.g., `7777`) for blue/green testing.

Example blue/green launch:

```
PASEO_HOME=~/.paseo-blue PASEO_PORT=7777 npm run dev
```

## Running and checking logs

Both the server and Expo app are running in a Tmux session. See CLAUDE.local.md for system-specific session details.

## Android

Take screenshots like this: `adb exec-out screencap -p > screenshot.png`

## Testing with Playwright MCP

**CRITICAL:** When asked to test the app, you MUST use the Playwright MCP connecting to Metro at `http://localhost:8081`.

Use the Playwright MCP to test the app in Metro web. Navigate to `http://localhost:8081` to interact with the app UI.

**Important:** Do NOT use browser history (back/forward). Always navigate by clicking UI elements or using `browser_navigate` with the full URL. The app uses client-side routing and browser history navigation breaks the state.

## Expo troubleshooting

Run `npx expo-doctor` to diagnose version mismatches and native module issues.

## Orchestrator Mode

When asked to go into orchestrator mode, you must **only accomplish tasks by managing other agents**. Do NOT perform the work yourself.

### Agent Control Best Practices

- **When agent control tool calls fail**, make sure you list agents before trying to launch another one. It could just be a wait timeout.
- **Always prefix agent titles** so we can tell which ones are running under you (e.g., "🎭 Feature Implementation", "🎭 Design Discussion").
- **Launch agents in the most permissive mode**: Use full access or bypass permissions mode.
- **Set cwd to the repository root** - The agent's working directory should usually be the repo root (`/home/moboudra/dev/voice-dev`).

### Agent Use Cases

You can run agents to:
- **Implement a task** - Spawn an agent to write code and implement features
- **Have a design discussion** - Discuss architecture and design decisions
- **Have a pairing session** - Collaborate on problem-solving
- **Test some feature** - Run tests and verify functionality
- **Do investigation** - Research and explore the codebase

### Clarifying Ambiguous Requests

**CRITICAL:** When user requests are ambiguous or unclear:

1. **Research first** - Spawn an investigation agent to understand the current state
2. **Ask clarifying questions** - After research, ask the user specific questions about what they want
3. **Present options** - Offer multiple approaches with trade-offs
4. **Get explicit confirmation** - Never assume what the user wants

### Investigation vs Implementation

**CRITICAL:** When asked to investigate:

- **Investigation agents MUST NOT fix issues** - They should only identify, document, and report problems
- **Always ask for confirmation** - After investigation, present findings and ask: "Should I proceed with implementing fixes?"
- **Only implement if explicitly requested** - Don't auto-fix without user approval

### Strategic Planning and Task Breakdown

**CRITICAL:** For large or complex tasks, you MUST plan strategically before spawning agents:

1. **Break down the work** into small, focused tasks
2. **Design the agent workflow**: What agents will you need? In what order?
3. **Plan checkpoints**: Where do you need review agents? Test agents? Integration points?
4. **Ensure each agent commits their work** before moving to the next phase
5. **Plan for validation**: How will you verify each piece works before proceeding?

Example workflow for a large feature:
- Investigation agent → Design discussion agent → Multiple implementation agents (one per component) → Test agent → Review agent → Integration agent

### Rigorous Agent Interrogation

**CRITICAL:** Agents start with ZERO context about your task. You must always provide complete context in your initial prompt.

When working with agents, you must dig deep and challenge them rigorously:

#### For Implementation Agents

- **Don't accept surface-level completion**: Ask them to show you the code they implemented
- **Trace the implementation**: Ask them to walk through the code flow step by step
- **Uncover gaps**: Dig hard to find possible gaps in their understanding
  - "Show me exactly where you handle error case X"
  - "What happens if the user does Y before Z?"
  - "Walk me through the data flow from input to output"
- **Ask for alternatives**: "Provide 3 different solutions to this problem and explain the trade-offs of each"
- **Rank and compare**: "Rank these approaches by performance, maintainability, and complexity"
- **Challenge their decisions**: Play devil's advocate on their architectural choices
  - "Why not use approach X instead?"
  - "What are the downsides of your solution?"
  - "How will this scale?"

#### For Investigation/Debugging Agents

- **Don't stop at the first answer**: Keep digging deeper
- **Explore different angles**: "What are 3 other possible causes?"
- **Request proof**: "Show me the specific code that proves this hypothesis"
- **Challenge assumptions**: "How do you know that's the root cause? What else could it be?"
- **Ask for comprehensive analysis**: "What are all the places in the codebase that could be affected?"

#### For Review Agents

- **Security review**: "What are the security implications? Any OWASP vulnerabilities?"
- **Edge cases**: "What edge cases are not handled?"
- **Performance**: "Where are the performance bottlenecks?"
- **Maintainability**: "How maintainable is this code? What would make it better?"

### Debugging with Logging and Playwright

**CRITICAL:** When debugging frontend or server issues:

- **Frontend debugging**: Use Playwright MCP to interact with the app at `http://localhost:8081`
  - Take screenshots to verify UI state
  - Click through flows to reproduce issues
  - Use browser console to check for errors
  - Verify network requests and responses
- **Server debugging**: Add strategic logging to trace execution
  - Log request/response payloads
  - Log state transitions
  - Log error conditions
  - Use server logs to correlate with frontend behavior
- **Full-stack debugging**: Combine both approaches
  - Use Playwright to trigger frontend actions
  - Check server logs to see backend behavior
  - Verify data flow from client → server → client

### Agent Management Principles

- **Keep agents focused** - Each agent should have a clear, specific responsibility
- **You can talk to them** - Send prompts and guidance as they work
- **Monitor progress** - Check status and provide feedback
- **Always provide context** - Remember: agents start with zero knowledge of your task
- **Verify work rigorously** - Don't trust, verify. Ask agents to prove their work
- **Commit frequently** - Ensure each agent commits their changes before moving on
- **Plan for quality gates** - Use test and review agents as checkpoints

**CRITICAL: ALWAYS RUN TYPECHECK AFTER EVERY CHANGE.**
