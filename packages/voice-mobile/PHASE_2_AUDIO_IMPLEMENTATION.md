# Phase 2: Audio Capture & Playback Implementation

## Overview

This document describes the implementation of audio recording and playback functionality for the voice-mobile React Native app using expo-audio.

## Dependencies Installed

### expo-audio (~1.0.13)
- Cross-platform audio recording and playback library
- Provides hooks: `useAudioRecorder` and `useAudioPlayer`
- Supports iOS, Android, and Web platforms
- Auto-configured via config plugin in app.json

### expo-file-system (~19.0.17)
- File system operations for reading/writing audio files
- New API using `File` and `Paths` classes
- Required for converting between audio URIs and Blobs

## Permissions Configuration

### app.json Updates

**iOS**:
```json
{
  "ios": {
    "infoPlist": {
      "NSMicrophoneUsageDescription": "This app needs access to the microphone for voice commands."
    }
  }
}
```

**Android**:
```json
{
  "android": {
    "permissions": [
      "RECORD_AUDIO"
    ]
  }
}
```

**Plugins**:
```json
{
  "plugins": [
    "expo-audio"
  ]
}
```

## File Structure

```
packages/voice-mobile/
├── hooks/
│   ├── use-audio-recorder.ts    # Audio recording hook (NEW)
│   └── use-audio-player.ts      # Audio playback hook (NEW)
├── lib/
│   ├── audio-capture.ts         # Legacy/factory version (NOT USED)
│   └── audio-playback.ts        # Legacy/factory version (NOT USED)
├── app/
│   ├── index.tsx                # Updated with link to audio test
│   └── audio-test.tsx           # Audio test screen (NEW)
└── app.json                     # Updated with permissions
```

## Implementation Details

### Audio Recording (`use-audio-recorder.ts`)

**Key Features**:
- Matches web app audio constraints:
  - Sample rate: 16000 Hz (optimal for Whisper STT)
  - Channels: 1 (mono)
  - Format: M4A/AAC on native, WebM/Opus on web
  - Audio source: `voice_communication` (enables echo cancellation, noise suppression, auto gain control on Android)

**Platform-Specific Configuration**:

Android:
```typescript
android: {
  extension: '.m4a',
  outputFormat: 'mpeg4',
  audioEncoder: 'aac',
  sampleRate: 16000,
  audioSource: 'voice_communication', // Key for voice optimization
}
```

iOS:
```typescript
ios: {
  extension: '.m4a',
  audioQuality: 127, // High quality
  sampleRate: 16000,
  linearPCMBitDepth: 16,
  linearPCMIsBigEndian: false,
  linearPCMIsFloat: false,
}
```

Web:
```typescript
web: {
  mimeType: 'audio/webm;codecs=opus',
  bitsPerSecond: 128000,
}
```

**Usage**:
```typescript
const audioRecorder = useAudioRecorder({
  sampleRate: 16000,
  numberOfChannels: 1,
});

// Start recording
await audioRecorder.start();

// Stop and get Blob for WebSocket transmission
const audioBlob = await audioRecorder.stop();
```

**File Handling**:
1. Recording creates temporary file (managed by expo-audio)
2. On stop, reads file URI from `audioRecorder.uri`
3. Converts to Blob using expo-file-system's `File` class
4. Cleans up temporary file after conversion

### Audio Playback (`use-audio-player.ts`)

**Key Features**:
- Queue system matching web version
- Supports playing Blobs from server (base64-encoded MP3)
- Automatic cleanup of temporary files
- Play/pause/resume/stop controls

**Queue System**:
```typescript
interface QueuedAudio {
  audioData: Blob;
  resolve: (duration: number) => void;
  reject: (error: Error) => void;
}
```

**Usage**:
```typescript
const audioPlayer = useAudioPlayer();

// Play audio (queued automatically)
const duration = await audioPlayer.play(audioBlob);

// Controls
audioPlayer.pause();
audioPlayer.resume();
audioPlayer.stop();
audioPlayer.clearQueue();
```

**File Handling**:
1. Converts Blob to ArrayBuffer
2. Creates temporary file in cache directory
3. Writes ArrayBuffer to file
4. Plays from file URI
5. Cleans up after playback

### Audio Test Screen (`audio-test.tsx`)

**Features**:
- Permission request/check on mount
- Visual permission status indicator
- Recording controls (Start/Stop)
- Recording status display
- Last recording size/type display
- Playback controls (Play Last Recording, Stop)
- Audio configuration info display
- Styled with NativeWind (Tailwind CSS)

**Navigation**:
- Added link button on main screen (index.tsx)
- Route: `/audio-test`

## Key Differences from Web Implementation

### 1. API Differences

**Web (MediaRecorder)**:
- `new MediaRecorder(stream, options)`
- Events: `ondataavailable`, `onstop`
- Returns Blob directly

**React Native (expo-audio)**:
- Hook-based: `useAudioRecorder(options)`
- Returns Promise from `stop()`
- URI property for file location
- Requires manual Blob conversion

### 2. File System

**Web**:
- Direct Blob creation from chunks
- No file system access needed

**React Native**:
- Must use file system (expo-file-system)
- Temporary files in cache directory
- Manual cleanup required

### 3. Permissions

**Web**:
- Runtime prompt via `getUserMedia()`
- Browser-managed

**React Native**:
- Platform-specific: Info.plist (iOS), AndroidManifest.xml (Android)
- Requires explicit `requestRecordingPermissionsAsync()`
- Must be configured in app.json

### 4. Audio Processing

**Web**:
- WebRTC constraints: `echoCancellation`, `noiseSuppression`, `autoGainControl`

**React Native**:
- Android: `audioSource: 'voice_communication'` enables similar features
- iOS: Built-in audio quality settings
- Platform-specific implementations

## Platform-Specific Considerations

### iOS
- M4A/AAC format (better compatibility)
- Microphone permission required (Info.plist)
- Audio session management handled by expo-audio
- No manual echo cancellation needed (handled by system)

### Android
- M4A/AAC format
- RECORD_AUDIO permission required
- `voice_communication` audio source crucial for voice quality
- Enables: echo cancellation, noise suppression, auto gain control
- Works well with VoIP and voice commands

### Web
- WebM/Opus format (better compression)
- MediaRecorder API used under the hood
- Permissions via browser prompt
- WebRTC audio processing

## Testing

### Manual Testing Steps

1. **Start Expo Development Server**:
   ```bash
   cd packages/voice-mobile
   npm start
   ```

2. **Test on Web**:
   - Press 'w' in terminal or visit http://localhost:8081
   - Click "Test Audio Capture & Playback" button
   - Grant microphone permission
   - Test recording and playback

3. **Test on iOS Simulator**:
   - Press 'i' in terminal
   - Note: iOS Simulator doesn't have microphone access
   - Test on physical device for full functionality

4. **Test on Android Emulator/Device**:
   - Press 'a' in terminal
   - Grant microphone permission
   - Test recording and playback

### Expected Behavior

**Recording**:
- Status shows "Recording..." with red indicator
- Stop button becomes enabled
- After stop, shows recording size and type

**Playback**:
- "Play Last Recording" enabled after recording
- Plays back the recorded audio
- Shows duration after playback completes

**Permissions**:
- Green indicator when granted
- Red indicator when denied
- Automatic request on mount

## Integration with WebSocket

The audio hooks are designed to work seamlessly with the WebSocket client:

```typescript
// In your component with WebSocket
const audioRecorder = useAudioRecorder();
const { send } = useWebSocket(WS_URL);

// Record and send to server
async function handleRecord() {
  await audioRecorder.start();
  // ... wait for user to stop
  const audioBlob = await audioRecorder.stop();

  // Convert to base64 for WebSocket
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    send({
      type: 'audio_chunk',
      payload: {
        audio: base64,
        format: 'audio/m4a',
        isLast: true,
      },
    });
  };
  reader.readAsDataURL(audioBlob);
}

// Play audio from server
const audioPlayer = useAudioPlayer();

// When receiving audio from server
function handleAudioOutput(message) {
  const audioBlob = base64ToBlob(message.payload.audio, 'audio/mp3');
  audioPlayer.play(audioBlob);
}
```

## Future Enhancements

1. **Streaming Audio**:
   - Implement chunk-based recording for real-time streaming
   - Send audio chunks as they're recorded (not just on stop)
   - Requires updating expo-audio usage

2. **Audio Visualization**:
   - Add waveform display during recording
   - Use expo-audio's metering feature
   - Display audio levels in real-time

3. **Error Handling**:
   - Add retry logic for failed recordings
   - Better error messages for users
   - Fallback for unsupported formats

4. **Performance**:
   - Optimize Blob conversion
   - Reduce memory usage for long recordings
   - Implement audio compression if needed

## Common Issues & Solutions

### Issue: "No recording URI returned"
**Cause**: Recording stopped before it started or expo-audio initialization failed
**Solution**: Ensure `audioRecorder.record()` completes before stopping

### Issue: Playback fails with "Failed to load audio"
**Cause**: File was deleted before playback or invalid Blob
**Solution**: Ensure Blob is valid and file exists before playing

### Issue: Permission denied
**Cause**: User denied microphone permission or app.json not configured
**Solution**:
1. Check app.json has correct permission entries
2. Rebuild app after changing permissions
3. Check device settings

### Issue: Poor audio quality
**Cause**: Incorrect audio source or low sample rate
**Solution**: Ensure `audioSource: 'voice_communication'` on Android

## TypeScript Support

All audio hooks are fully typed:

```typescript
// Hook return types
interface AudioRecorder {
  start(): Promise<void>;
  stop(): Promise<Blob>;
  isRecording(): boolean;
  getSupportedMimeType(): string | null;
}

interface AudioPlayer {
  play(audioData: Blob): Promise<number>;
  stop(): void;
  pause(): void;
  resume(): void;
  isPlaying(): boolean;
  isPaused(): boolean;
  clearQueue(): void;
}

// Configuration
interface AudioCaptureConfig {
  sampleRate?: number;
  numberOfChannels?: number;
  bitRate?: number;
}
```

## Summary

Phase 2 successfully implements audio capture and playback for the voice-mobile app using expo-audio. The implementation:

✅ Matches web app audio constraints (16kHz, mono, optimized for speech)
✅ Supports all platforms (iOS, Android, Web)
✅ Provides Blob output compatible with WebSocket transmission
✅ Includes test screen for verification
✅ Fully typed with TypeScript
✅ Follows React Native best practices
✅ Properly manages permissions and temporary files

The implementation is ready for integration with Phase 1 (WebSocket) to create the complete voice assistant mobile experience.
