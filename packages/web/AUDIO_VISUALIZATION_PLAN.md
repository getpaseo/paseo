# Audio Visualization Implementation Plan

## Overview
Implement real-time audio feedback visualization using the native Web Audio API to show user voice activity through a volume bar indicator.

## Architecture

### Components Hierarchy
```
Page (app/page.tsx)
└── VoiceClient (client component)
    ├── Audio Controls (mute/unmute button)
    ├── VolumeBar (visualization component)
    └── WebRTC Connection Logic
```

## Implementation Steps

### 1. Create Audio Analysis Hook (`use-audio-level.ts`)

**Purpose:** Extract and calculate audio levels from MediaStream

**Implementation Details:**
- Accept `MediaStream | null` as input
- Return normalized volume level (0-100)
- Use Web Audio API components:
  - `AudioContext` - main audio processing context
  - `AnalyserNode` - provides real-time frequency/time-domain analysis
  - `MediaStreamAudioSourceNode` - connects MediaStream to analyser

**Key Logic:**
```typescript
1. Create AudioContext when stream is available
2. Create AnalyserNode with fftSize = 2048 (provides 1024 frequency bins)
3. Create MediaStreamSource from the input stream
4. Connect: source → analyser (do NOT connect to destination to avoid feedback)
5. Start animation loop using requestAnimationFrame
6. In each frame:
   - Call analyser.getByteTimeDomainData() to get audio samples
   - Calculate RMS (Root Mean Square) for volume level
   - Normalize to 0-100 range
   - Update state
7. Cleanup: disconnect nodes and close context on unmount
```

**Performance Considerations:**
- Use `requestAnimationFrame` for optimal update timing (~60fps)
- Reuse `Uint8Array` buffer instead of creating new ones each frame
- Close AudioContext on cleanup to prevent memory leaks

**Edge Cases:**
- Handle null/undefined stream gracefully
- Manage AudioContext state changes
- Handle browser autoplay policies (may require user gesture)

### 2. Create Volume Bar Component (`volume-bar.tsx`)

**Purpose:** Visual representation of audio level

**Props:**
- `volume: number` (0-100 range)
- `isMuted?: boolean` (optional, for visual state)

**Visual Design:**
```
Container: Fixed height bar (e.g., 200px tall, 40px wide)
└── Fill: Height changes based on volume level
    ├── Color zones:
    │   ├── 0-60%: Green (#10b981)
    │   ├── 60-80%: Yellow (#fbbf24)
    │   └── 80-100%: Red (#ef4444)
    └── Animation: Smooth transitions (transition: all 0.1s ease)
```

**States:**
- Active: Shows current volume with color-coded levels
- Muted: Grayed out or show muted icon overlay
- No stream: Empty/disabled state

**Implementation:**
- Use CSS flexbox for vertical orientation
- Apply `transform: scaleY()` or dynamic height for bar fill
- Add subtle animations for smoothness
- Responsive design considerations

### 3. Integrate into Voice Client Component

**File:** `app/voice-client.tsx` (or similar)

**Integration Flow:**
```
1. Manage MediaStream state
2. Pass stream to useAudioLevel hook
3. Get volume value from hook
4. Pass volume to VolumeBar component
5. Update VolumeBar based on mute state
```

**State Management:**
```typescript
const [stream, setStream] = useState<MediaStream | null>(null);
const [isMuted, setIsMuted] = useState(false);
const volume = useAudioLevel(stream);

// When muting: keep stream active but disable audio track
stream?.getAudioTracks().forEach(track => {
  track.enabled = !isMuted;
});
```

**Mute/Unmute Logic:**
- Don't stop the stream when muting (keeps analysis running)
- Disable audio track: `track.enabled = false`
- Visual feedback: gray out volume bar or add overlay
- Optional: Stop showing volume updates when muted

## Technical Specifications

### Audio Analysis Parameters

**AnalyserNode Configuration:**
- `fftSize: 2048` - Higher values = more frequency detail but slower
- `smoothingTimeConstant: 0.8` (default) - Smooths out rapid changes
- `frequencyBinCount: analyser.fftSize / 2` - Number of data points (1024)

**Volume Calculation:**
```typescript
// Get time-domain data (waveform)
const dataArray = new Uint8Array(analyser.frequencyBinCount);
analyser.getByteTimeDomainData(dataArray);

// Calculate RMS (Root Mean Square)
const rms = Math.sqrt(
  dataArray.reduce((sum, value) => sum + value * value, 0) / dataArray.length
);

// Normalize: Byte values are 0-255, normalize to 0-100
const normalizedVolume = (rms / 255) * 100;

// Optional: Apply scaling for better visual response
const scaledVolume = Math.min(100, normalizedVolume * 1.5);
```

### Alternative: Using Frequency Data
```typescript
// For more responsive visualization
analyser.getByteFrequencyData(dataArray);
const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
const volume = (average / 255) * 100;
```

## File Structure

```
app/
├── page.tsx                          # Main page (server component)
├── voice-client.tsx                  # Client component with WebRTC
├── components/
│   └── volume-bar.tsx               # Volume visualization component
└── hooks/
    └── use-audio-level.ts           # Audio analysis hook
```

## TypeScript Types

```typescript
// hooks/use-audio-level.ts
interface UseAudioLevelOptions {
  enabled?: boolean;
  smoothing?: number;
}

function useAudioLevel(
  stream: MediaStream | null,
  options?: UseAudioLevelOptions
): number;

// components/volume-bar.tsx
interface VolumeBarProps {
  volume: number;        // 0-100
  isMuted?: boolean;
  className?: string;
}
```

## Testing Considerations

1. **Manual Testing:**
   - Test with different microphone input levels
   - Verify mute/unmute visual feedback
   - Check performance (CPU usage should be minimal)
   - Test on different browsers (Chrome, Firefox, Safari)

2. **Edge Cases:**
   - No microphone access granted
   - Microphone disconnected mid-session
   - Multiple rapid mute/unmute toggles
   - Browser tab backgrounded (check if AudioContext suspends)

3. **Visual Verification:**
   - Bar should respond quickly to voice (< 100ms latency feel)
   - Color transitions should be smooth
   - Muted state should be clearly visible

## Browser Compatibility

**Web Audio API Support:**
- Chrome/Edge: Full support
- Firefox: Full support
- Safari: Full support (requires user gesture for AudioContext)

**Important:** Safari requires a user interaction (e.g., button click) to start AudioContext due to autoplay policies.

## Performance Optimization

1. **Throttle/Debounce:** Already handled by `requestAnimationFrame`
2. **Memory:** Reuse typed arrays instead of creating new ones
3. **Cleanup:** Always disconnect nodes and close AudioContext
4. **Conditional Rendering:** Only run analysis when stream is active

## Future Enhancements (Optional)

- Add peak level indicator (shows max volume reached)
- Add threshold indicators for voice activity detection
- Implement waveform visualization as alternative view
- Add accessibility features (ARIA labels, screen reader support)
- Smoothing controls for users to adjust responsiveness
- Save user preferences (mute state, visualization style)

## Implementation Order

1. ✅ Create `use-audio-level.ts` hook (core functionality)
2. ✅ Create `volume-bar.tsx` component (visual display)
3. ✅ Integrate into voice client component
4. ✅ Test with microphone input
5. ✅ Refine visual styling and animations
6. ✅ Handle edge cases and error states
