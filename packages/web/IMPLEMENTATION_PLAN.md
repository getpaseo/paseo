# Real-Time Voice App Implementation Plan

## Overview
Build a Next.js application that connects directly to OpenAI's Realtime API using WebRTC for voice interaction with mute/unmute controls and audio visualization.

## Tech Stack
- Next.js 14+ (App Router)
- TypeScript
- OpenAI Realtime API (WebRTC)
- Web Audio API (for visualization)
- Native browser WebRTC APIs

## Project Structure

```
app/
├── page.tsx                          # Main page (server component)
├── voice-client.tsx                  # Main client component
├── components/
│   ├── volume-bar.tsx               # Audio level visualization
│   └── mute-button.tsx              # Mute/unmute control
├── hooks/
│   ├── use-audio-level.ts           # Audio analysis
│   └── use-webrtc-voice.ts          # WebRTC connection logic
└── api/
    └── session/
        └── route.ts                  # Generate ephemeral tokens
```

## Environment Setup

### Required Environment Variables
```
OPENAI_API_KEY=sk-...
```

### Dependencies (package.json additions)
```json
{
  "dependencies": {
    "next": "^14.0.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "typescript": "^5.0.0"
  }
}
```

**No additional dependencies needed** - using native browser APIs only.

## Implementation Steps

### Phase 1: Backend - Ephemeral Token Generation

#### File: `app/api/session/route.ts`

**Purpose:** Securely generate ephemeral tokens for WebRTC connection

**Implementation:**
```typescript
import { NextResponse } from 'next/server';

export async function POST() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: 'OpenAI API key not configured' },
      { status: 500 }
    );
  }

  try {
    const response = await fetch(
      'https://api.openai.com/v1/realtime/sessions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-realtime-preview-2024-12-17',
          voice: 'alloy',
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Session creation error:', error);
    return NextResponse.json(
      { error: 'Failed to create session' },
      { status: 500 }
    );
  }
}
```

**Key Details:**
- POST endpoint only
- Returns: `{ client_secret: { value: string, expires_at: number } }`
- Ephemeral token valid for 60 seconds
- Keep API key secure on server

---

### Phase 2: WebRTC Connection Hook

#### File: `app/hooks/use-webrtc-voice.ts`

**Purpose:** Manage WebRTC connection to OpenAI Realtime API

**State Management:**
```typescript
interface UseWebRTCVoiceReturn {
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  stream: MediaStream | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}
```

**Implementation Flow:**
```
1. Request microphone access
2. Fetch ephemeral token from /api/session
3. Create RTCPeerConnection
4. Add microphone audio track to peer connection
5. Create data channel for events
6. Create and set local SDP offer
7. Send offer to OpenAI and get answer
8. Set remote SDP answer
9. Connection established
```

**Key Code Patterns:**
```typescript
// 1. Get microphone
const stream = await navigator.mediaDevices.getUserMedia({
  audio: true
});

// 2. Get ephemeral token
const response = await fetch('/api/session', { method: 'POST' });
const { client_secret } = await response.json();

// 3. Create peer connection
const pc = new RTCPeerConnection();

// 4. Add audio track
stream.getTracks().forEach(track => pc.addTrack(track, stream));

// 5. Create data channel
const dc = pc.createDataChannel('oai-events');

// 6. Handle incoming audio
pc.ontrack = (event) => {
  const audioElement = new Audio();
  audioElement.srcObject = event.streams[0];
  audioElement.play();
};

// 7. Create offer
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

// 8. Send to OpenAI
const sdpResponse = await fetch(
  `https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${client_secret.value}`,
      'Content-Type': 'application/sdp',
    },
    body: offer.sdp,
  }
);

// 9. Set answer
const answer = {
  type: 'answer' as RTCSdpType,
  sdp: await sdpResponse.text(),
};
await pc.setRemoteDescription(answer);
```

**Cleanup:**
```typescript
function disconnect() {
  dataChannel?.close();
  peerConnection?.close();
  stream?.getTracks().forEach(track => track.stop());
  if (audioElement) {
    audioElement.pause();
    audioElement.srcObject = null;
  }
}
```

**Error Handling:**
- Microphone permission denied
- Network errors during token fetch
- WebRTC connection failures
- Token expiration

---

### Phase 3: Audio Level Hook

#### File: `app/hooks/use-audio-level.ts`

**Purpose:** Calculate real-time audio levels from microphone stream

**Implementation:**
```typescript
function useAudioLevel(stream: MediaStream | null): number {
  const [volume, setVolume] = useState(0);

  useEffect(() => {
    if (!stream) {
      setVolume(0);
      return;
    }

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let animationId: number;

    function updateVolume() {
      analyser.getByteTimeDomainData(dataArray);

      const rms = Math.sqrt(
        dataArray.reduce((sum, val) => sum + val * val, 0) / dataArray.length
      );

      const normalized = (rms / 255) * 100;
      setVolume(Math.min(100, normalized * 1.5));

      animationId = requestAnimationFrame(updateVolume);
    }

    updateVolume();

    return () => {
      cancelAnimationFrame(animationId);
      source.disconnect();
      audioContext.close();
    };
  }, [stream]);

  return volume;
}
```

**Returns:** Volume level 0-100

---

### Phase 4: Volume Bar Component

#### File: `app/components/volume-bar.tsx`

**Purpose:** Visual representation of audio level

**Props:**
```typescript
interface VolumeBarProps {
  volume: number;      // 0-100
  isMuted?: boolean;
}
```

**Visual Design:**
```typescript
function VolumeBar({ volume, isMuted }: VolumeBarProps) {
  const getColor = () => {
    if (isMuted) return 'bg-gray-300';
    if (volume > 80) return 'bg-red-500';
    if (volume > 60) return 'bg-yellow-400';
    return 'bg-green-500';
  };

  return (
    <div className="w-10 h-48 bg-gray-200 rounded-lg overflow-hidden flex flex-col-reverse">
      <div
        className={`${getColor()} transition-all duration-100 ease-out`}
        style={{ height: `${isMuted ? 0 : volume}%` }}
      />
    </div>
  );
}
```

**Styling:**
- Vertical bar, 40px wide, 192px tall
- Color zones: green → yellow → red
- Smooth transitions (100ms)
- Gray when muted

---

### Phase 5: Mute Button Component

#### File: `app/components/mute-button.tsx`

**Purpose:** Toggle microphone mute state

**Props:**
```typescript
interface MuteButtonProps {
  isMuted: boolean;
  onToggle: () => void;
  disabled?: boolean;
}
```

**Implementation:**
```typescript
function MuteButton({ isMuted, onToggle, disabled }: MuteButtonProps) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={`
        px-6 py-3 rounded-lg font-medium transition-colors
        ${isMuted
          ? 'bg-red-500 hover:bg-red-600 text-white'
          : 'bg-blue-500 hover:bg-blue-600 text-white'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
    >
      {isMuted ? 'Unmute' : 'Mute'}
    </button>
  );
}
```

**States:**
- Active (not muted): Blue background
- Muted: Red background
- Disabled: Grayed out when not connected

---

### Phase 6: Main Voice Client Component

#### File: `app/voice-client.tsx`

**Purpose:** Main client component orchestrating all functionality

**Implementation:**
```typescript
'use client';

import { useState } from 'react';
import { useWebRTCVoice } from './hooks/use-webrtc-voice';
import { useAudioLevel } from './hooks/use-audio-level';
import VolumeBar from './components/volume-bar';
import MuteButton from './components/mute-button';

export default function VoiceClient() {
  const [isMuted, setIsMuted] = useState(false);
  const {
    isConnected,
    isConnecting,
    error,
    stream,
    connect,
    disconnect
  } = useWebRTCVoice();

  const volume = useAudioLevel(stream);

  function handleMuteToggle() {
    if (!stream) return;

    stream.getAudioTracks().forEach(track => {
      track.enabled = !isMuted;
    });

    setIsMuted(!isMuted);
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-8 p-8">
      <h1 className="text-4xl font-bold">Real-Time Voice</h1>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <div className="flex items-end gap-8">
        <VolumeBar volume={volume} isMuted={isMuted} />

        <div className="flex flex-col gap-4">
          {!isConnected ? (
            <button
              onClick={connect}
              disabled={isConnecting}
              className="px-8 py-4 bg-green-500 hover:bg-green-600 text-white rounded-lg font-medium disabled:opacity-50"
            >
              {isConnecting ? 'Connecting...' : 'Start Voice Chat'}
            </button>
          ) : (
            <>
              <MuteButton
                isMuted={isMuted}
                onToggle={handleMuteToggle}
                disabled={!isConnected}
              />
              <button
                onClick={disconnect}
                className="px-8 py-4 bg-gray-500 hover:bg-gray-600 text-white rounded-lg font-medium"
              >
                Disconnect
              </button>
            </>
          )}
        </div>
      </div>

      {isConnected && (
        <p className="text-green-600 font-medium">
          Connected - Speak to interact with AI
        </p>
      )}
    </div>
  );
}
```

**State Management:**
- `isMuted` - local mute state
- `isConnected` - from WebRTC hook
- `volume` - from audio level hook
- `stream` - MediaStream from WebRTC hook

**User Flow:**
1. Click "Start Voice Chat" → requests mic permission → connects
2. Volume bar shows audio level
3. Click "Mute" → disables audio track, grays out volume bar
4. Click "Unmute" → re-enables audio track
5. Click "Disconnect" → closes connection, stops mic

---

### Phase 7: Main Page

#### File: `app/page.tsx`

**Purpose:** Entry point, server component wrapper

**Implementation:**
```typescript
import VoiceClient from './voice-client';

export default function Home() {
  return <VoiceClient />;
}
```

**Simple wrapper** - all logic in client component

---

## Configuration Files

### TypeScript Config (`tsconfig.json`)
Ensure these compiler options:
```json
{
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "esnext"],
    "target": "ES2017",
    "strict": true
  }
}
```

### Tailwind Config
Standard Next.js Tailwind setup - no special configuration needed

---

## Testing Checklist

### Functionality
- [ ] Microphone permission request works
- [ ] Connection establishes successfully
- [ ] Can hear AI responses through speakers
- [ ] AI can hear user input
- [ ] Mute button disables microphone
- [ ] Unmute button re-enables microphone
- [ ] Volume bar reflects audio level
- [ ] Volume bar grays out when muted
- [ ] Disconnect stops all streams
- [ ] Error messages display correctly

### Browser Testing
- [ ] Chrome/Edge (primary target)
- [ ] Firefox
- [ ] Safari (note: may need user gesture for AudioContext)

### Edge Cases
- [ ] Microphone permission denied
- [ ] No microphone available
- [ ] Network errors during connection
- [ ] Token expiration (60 second timeout)
- [ ] Rapid mute/unmute toggles
- [ ] Disconnect and reconnect
- [ ] Browser tab backgrounded

---

## Implementation Order

### Step 1: Setup (5 min)
1. Verify Next.js project initialized
2. Verify OPENAI_API_KEY in .env.local
3. Ensure TypeScript configured

### Step 2: Backend (10 min)
1. Create `app/api/session/route.ts`
2. Test endpoint with curl or Postman
3. Verify token generation

### Step 3: Components (15 min)
1. Create `app/components/volume-bar.tsx`
2. Create `app/components/mute-button.tsx`
3. Test with mock data

### Step 4: Hooks (30 min)
1. Create `app/hooks/use-audio-level.ts`
2. Test with microphone input
3. Create `app/hooks/use-webrtc-voice.ts`
4. Test WebRTC connection

### Step 5: Integration (15 min)
1. Create `app/voice-client.tsx`
2. Update `app/page.tsx`
3. Wire all components together

### Step 6: Testing (20 min)
1. Test complete user flow
2. Test error cases
3. Verify audio quality
4. Check performance

### Step 7: Polish (10 min)
1. Refine styling
2. Improve error messages
3. Add loading states

**Total Estimated Time: ~2 hours**

---

## Common Issues & Solutions

### Issue: AudioContext suspended
**Solution:** Safari requires user gesture. Ensure AudioContext created after user clicks connect.

### Issue: No audio output
**Solution:** Check if Audio element is created and `play()` called. Verify speakers/volume.

### Issue: Microphone not working
**Solution:** Check browser permissions. Ensure HTTPS (required for getUserMedia).

### Issue: Connection fails
**Solution:** Verify token not expired (60s limit). Check network console for errors.

### Issue: High latency
**Solution:** WebRTC should be low-latency by default. Check network connection quality.

---

## Future Enhancements (Not in Initial Scope)

- Session configuration (change voice, temperature)
- Text transcript display
- Function calling support
- Audio recording/playback
- Multiple conversation modes
- Voice activity detection threshold
- Connection quality indicator
- Reconnection logic on disconnect

---

## Success Criteria

✅ User can click connect and start talking to AI
✅ AI responses are audible and clear
✅ Mute/unmute works correctly
✅ Volume bar shows real-time audio levels
✅ Error states handled gracefully
✅ Connection can be cleanly disconnected
✅ Code is clean, typed, and maintainable
