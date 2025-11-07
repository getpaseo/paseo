# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Voice-controlled terminal assistant using OpenAI's Realtime API (via Whisper STT, GPT-4, and TTS). Backend server with Expo app for all platforms (iOS, Android, and Web).

## Monorepo Structure

This is an npm workspace monorepo:

- **Root**: Workspace configuration and shared TypeScript config
- **packages/server**: Backend server (Express + WebSocket API)
- **packages/app**: Cross-platform app (Expo - iOS, Android, Web)

## Running and checking logs

We run the mobile app and server in the tmux session `voice-dev`:

`tmux capture-pane -t voice-dev:mobile -p`
`tmux capture-pane -t voice-dev:server -p`

Don't run them anywhere else. Check logs there.

## Android

Take screenshots like this: `adb exec-out screencap -p > screenshot.png`

## Expo troubleshooting

Run `npx expo-doctor` to diagnose version mismatches and native module issues.

## Asking Codex for a second opinion

You can ask Codex for a second opinion on a problem you're working on.

Set a high timeout, like 2 minutes.

Try not to bias it, state the problem clearly and let it work it out.

`codex exec "prompt"`

**CRITICAL: ALWAYS RUN TYPECHECK AFTER EVERY CHANGE.**
