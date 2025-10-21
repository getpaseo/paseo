# Voice Assistant Mobile App - Technical Specification

## Project Overview

React Native mobile app that replicates the existing web-based voice assistant. Same functionality, same server connection, just on mobile with in-call experience for hands-free use.

## Core Architecture

### What We Have (Web Prototype)

```
Browser (React + Vite)
    ↓ WebSocket
Express Server on Laptop
    ├── OpenAI Whisper (STT)
    ├── OpenAI GPT-4 (LLM streaming)
    ├── OpenAI TTS
    └── tmux terminal manager
```

### What We're Building (Mobile App)

```
React Native App (Expo)
    ↓ WebSocket (same protocol)
Express Server on Laptop (unchanged)
    ├── OpenAI Whisper (STT)
    ├── OpenAI GPT-4 (LLM streaming)
    ├── OpenAI TTS
    └── tmux terminal manager
```

**Connection:** Direct WebSocket to laptop server (Tailscale tunnel)

**Server changes:** ZERO. The existing server works as-is.

## Monorepo Structure

```
voice-dev/
├── packages/
│   ├── voice-assistant/        # Existing web app (stays as-is)
│   │   └── src/
│   │       └── server/
│   │           ├── messages.ts  # WebSocket message types (SHARED)
│   │           └── types.ts     # Server types (SHARED)
│   └── voice-mobile/            # NEW - React Native app
│       ├── app/                 # Expo Router screens
│       ├── components/          # RN components (NOT shared with web)
│       ├── hooks/               # WebSocket, audio hooks
│       ├── lib/                 # Audio capture/playback
│       ├── app.json
│       ├── package.json
│       └── tsconfig.json
└── package.json                 # Root workspace config
```

**Code Sharing:**
- ✅ Share Zod schemas and types from `voice-assistant/src/server/` (WebSocket message types)
- ❌ Don't share UI components, hooks, or other code between web and mobile

## Technology Stack

- **React Native** with **Expo SDK 54+**
- **TypeScript** (strict mode)
- **Expo Router** (file-based routing)
- **NativeWind v5** (Tailwind CSS for React Native)
- **expo-audio** for audio capture and playback
- **react-native-incall-manager** for Android in-call experience
- **WebSocket** (native WebSocket API, no socket.io needed)

## What the App Does

**Exactly what the web app does:**
1. Connect to laptop server via WebSocket
2. Record audio from microphone
3. Stream audio chunks to server
4. Display transcription results
5. Show streaming AI responses
6. Play TTS audio responses
7. Display activity logs (tool calls, terminal output)

**Additional mobile features:**
- Android sticky notification (like being in a phone call)
- Background audio (works when screen locked)
- Bluetooth/headphone support
- Earpiece/speaker routing

## User Interface

### Styling: NativeWind v5

All styling uses Tailwind utility classes:

```tsx
<View className="flex-1 bg-black">
  <Text className="text-white text-lg font-semibold">
    Voice Assistant
  </Text>
  <Pressable className="bg-red-500 rounded-full p-4">
    <Text className="text-white">Record</Text>
  </Pressable>
</View>
```

**Color Scheme (Dark Mode Primary):**
```
- bg-black - Main background
- bg-zinc-900 - Surface/cards
- text-white - Primary text
- text-zinc-400 - Secondary text
- bg-red-500 - Recording indicator
- bg-blue-500 - Processing indicator
- bg-green-500 - Speaking indicator
```

### Screens

**1. Main Screen**

The conversation interface (matches web app layout).

```
┌─────────────────────────────┐
│ ● Connected                 │ ← Status bar
├─────────────────────────────┤
│                             │
│  You: Run git status        │ ← User message (right aligned)
│                             │
│  Assistant: Running git...  │ ← AI response (left aligned)
│  [Activity: git status]     │ ← Expandable activity log
│                             │
│  You: What changed?         │
│                             │
│  Assistant: You modified... │
│                             │
│ [Scrollable conversation]   │
│                             │
├─────────────────────────────┤
│        🎤                   │ ← Voice button (large, centered)
└─────────────────────────────┘
```

**Voice Button States:**
- Idle: Gray circle
- Recording: Red pulsing circle
- Transcribing: Blue spinner
- AI Speaking: Green animated waveform

**Conversation Items:**
- User messages (right aligned, dark background)
- AI responses (left aligned, lighter background)
- Activity logs (collapsed by default, tap to expand)
- Timestamps (subtle, relative time)

**2. Settings Screen**

```
┌─────────────────────────────┐
│ Settings                    │
├─────────────────────────────┤
│                             │
│ Server Configuration        │
│ ┌─────────────────────────┐ │
│ │ ws://100.x.x.x:3000     │ │ ← Tailscale URL
│ └─────────────────────────┘ │
│                             │
│ Audio                       │
│ □ Use Speaker               │ ← Toggle earpiece/speaker
│ □ Keep Screen On            │
│                             │
│ Theme                       │
│ ○ Dark  ○ Light  ○ Auto    │
│                             │
└─────────────────────────────┘
```

## Audio System

### Android In-Call Experience

**What it looks like:**
- Persistent notification: "Voice Assistant • In Call"
- Notification shows hang-up button
- Phone treats it like an active call
- Audio routes properly (earpiece/speaker/bluetooth)
- Works when screen is locked
- Works when app is backgrounded

**Implementation:**
```typescript
import InCallManager from 'react-native-incall-manager';

// Start voice session
InCallManager.start({ media: 'audio' });
InCallManager.setKeepScreenOn(true);
InCallManager.setSpeakerphoneOn(false); // Use earpiece

// End voice session
InCallManager.stop();
```

### Audio Capture

**Same configuration as web:**
```typescript
{
  sampleRate: 16000,
  numberOfChannels: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}
```

**Streaming:**
- Capture in 100ms chunks (same as web)
- Send via WebSocket as base64
- Same message format as web app uses

### Audio Playback

- Receive MP3 audio from server (base64)
- Decode and play via expo-audio
- Same as web app's audio playback

## WebSocket Protocol

**Uses the existing protocol - no changes.**

The mobile app imports message types directly from the server:

```typescript
import type {
  WSInboundMessage,
  WSOutboundMessage,
  SessionOutboundMessage
} from '../../voice-assistant/src/server/messages';
```

**Client → Server:**
- `audio_chunk` - Audio data
- `user_message` - Text input
- `recording_state` - Started/stopped
- `ping` - Keepalive

**Server → Client:**
- `activity_log` - Tool calls, events
- `assistant_chunk` - Streaming response
- `audio_output` - TTS audio
- `transcription_result` - STT output
- `status` - Connection state
- `pong` - Keepalive response

**Connection:**
```typescript
const ws = new WebSocket('ws://100.x.x.x:3000'); // Tailscale IP

ws.onmessage = (event) => {
  const message: WSOutboundMessage = JSON.parse(event.data);
  // Type-safe message handling with shared types
};
```

## Data Flow

### Voice Input (Same as Web)

```
1. User taps mic button
2. Start recording with expo-audio
3. Capture 100ms chunks
4. Send chunks via WebSocket
5. Server transcribes with Whisper
6. Display transcription in real-time
```

### AI Response (Same as Web)

```
1. Server streams GPT-4 response chunks
2. Display text word-by-word
3. Server generates TTS audio
4. Send audio chunks to mobile
5. Play audio via expo-audio
```

### Activity Logs (Same as Web)

```
1. Claude executes tool (e.g., "create file")
2. Server sends activity_log message
3. Display in conversation with collapse/expand
```

## Android Features

### Required Permissions

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.INTERNET" />
```

### Foreground Service

When voice session is active:
- App runs as foreground service
- Persistent notification visible
- Android won't kill the app
- Audio works in background
- Works when screen is locked

## State Management

**Simple, no libraries:**
- React Context for WebSocket connection
- React Context for conversation state
- Local state for UI (button press, etc.)
- AsyncStorage for settings (Tailscale URL)

```typescript
interface AppState {
  isConnected: boolean;
  isRecording: boolean;
  messages: Message[];
  activityLogs: ActivityLog[];
  serverUrl: string;
}
```

## What We're NOT Building

**Keep it simple. These are out of scope:**
- ❌ Code diff viewer (just show text)
- ❌ Terminal emulator (just show logs)
- ❌ File browser
- ❌ Push notifications
- ❌ Conversation history sync
- ❌ Multi-device support
- ❌ Authentication (Tailscale handles it)
- ❌ Encryption layer (Tailscale handles it)
- ❌ Relay server (direct connection only)

## Success Criteria

**It works if:**
- ✅ Connects to laptop server (same as web app)
- ✅ Audio quality matches web app
- ✅ Shows conversation same as web app
- ✅ Works with phone locked (Android)
- ✅ Shows sticky notification (Android)
- ✅ Routes audio to bluetooth/headphones
- ✅ Latency same as web app (< 3 seconds)
- ✅ Can use hands-free in car

**Visual/UX:**
- ✅ Dark mode looks good
- ✅ Voice button is obvious and large
- ✅ Conversation scrolls smoothly
- ✅ Works one-handed

## Development Approach

**Start simple:**
1. Set up Expo + NativeWind
2. Port WebSocket connection (copy from web)
3. Port audio capture (expo-audio instead of MediaRecorder)
4. Port audio playback (expo-audio instead of Web Audio)
5. Port UI (React Native + Tailwind instead of React + CSS)
6. Add InCallManager for Android experience

**No fancy stuff:**
- No state management libraries
- No complex routing (just 2 screens)
- No animations (except button states)
- No offline support
- No caching
- Keep it simple

## Personal Use Optimizations

**Built for one user (you):**
- Tailscale URL can be hardcoded or stored locally
- No user accounts
- No analytics
- No crash reporting (just use it and fix bugs)
- No app store deployment (sideload APK)
- No iOS initially (Android only)
