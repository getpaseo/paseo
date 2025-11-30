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

We run the mobile app and server in the tmux session `voice-dev`:

`tmux capture-pane -t voice-dev:mobile -p`
`tmux capture-pane -t voice-dev:server -p`

Don't run them anywhere else. Check logs there.

## Android

Take screenshots like this: `adb exec-out screencap -p > screenshot.png`

## Testing with Playwright MCP

Use the Playwright MCP to test the app in Metro web. Navigate to `http://localhost:8081` to interact with the app UI.

**Important:** Do NOT use browser history (back/forward). Always navigate by clicking UI elements or using `browser_navigate` with the full URL. The app uses client-side routing and browser history navigation breaks the state.

## Expo troubleshooting

Run `npx expo-doctor` to diagnose version mismatches and native module issues.

## Asking Codex for a second opinion

You can ask Codex for a second opinion on a problem you're working on.

Set a high timeout, like 2 minutes.

Try not to bias it, state the problem clearly and let it work it out.

`codex exec "prompt"`

**CRITICAL: ALWAYS RUN TYPECHECK AFTER EVERY CHANGE.**
