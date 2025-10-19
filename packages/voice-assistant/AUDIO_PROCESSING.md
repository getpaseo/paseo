# Audio Processing Architecture

## Overview

This application uses **browser-side WebRTC audio processing** with **WebSocket transport**. We do NOT use WebRTC for peer-to-peer connections.

## Why This Architecture?

### Browser-Side WebRTC Processing
- ✅ Echo cancellation - Removes feedback from speakers
- ✅ Noise suppression - Filters background noise
- ✅ Auto gain control - Normalizes volume levels
- ✅ No server-side processing needed

### WebSocket Transport
- ✅ Simple and reliable
- ✅ Works with existing infrastructure
- ✅ No NAT traversal issues
- ✅ Easy to debug

### No Server-Side WebRTC
- ❌ Server doesn't need to be a WebRTC peer
- ❌ No complex signaling protocol needed
- ❌ No audio encoding/decoding on server
- ❌ Simpler architecture

## Audio Flow

### Voice Input (STT)
1. Browser: `getUserMedia()` with audio constraints
2. Browser: MediaRecorder captures processed audio
3. Browser → Server: WebSocket (base64-encoded audio)
4. Server: OpenAI Whisper transcription
5. Server: LLM processing
6. Server: Generate TTS response

### Voice Output (TTS)
1. Server: OpenAI TTS generates MP3
2. Server → Browser: WebSocket (base64-encoded MP3)
3. Browser: HTMLAudioElement playback

## Audio Constraints

The browser applies these constraints to audio capture:

```javascript
{
  echoCancellation: true,    // Remove echo
  noiseSuppression: true,    // Remove noise
  autoGainControl: true,     // Normalize volume
  sampleRate: 16000,         // Optimal for speech
  channelCount: 1,           // Mono
}
```

These constraints are applied via the Web Audio API in `getUserMedia()`, which uses the browser's built-in audio processing pipeline (same as WebRTC uses internally).

## Audio Format

- **Input Format**: WebM/Opus (preferred) or browser's best available codec
- **Sample Rate**: 16kHz (optimal for speech recognition)
- **Channels**: Mono (sufficient for voice)
- **Output Format**: MP3 (from OpenAI TTS)

## Browser Compatibility

- ✅ Chrome/Edge - Full support
- ✅ Firefox - Full support
- ✅ Safari - Full support (iOS requires https)
- ✅ Mobile browsers - Supported

## Testing Audio Processing

To verify echo cancellation and noise suppression work:

1. Play music or make noise near your microphone
2. Start recording
3. Speak while noise is present
4. Stop recording and check transcription
5. Background noise should be filtered out

## Performance

- **Latency**: 2-4 seconds total
  - STT: 1-2s (Whisper API)
  - LLM: 0.5-1s (OpenAI GPT)
  - TTS: 0.5-1s (OpenAI TTS)
- **Bandwidth**: ~10-20 KB/s for audio (both directions)
- **Audio Quality**: Excellent for speech (16kHz mono)

## Implementation Details

### Browser Side (`src/ui/lib/audio-capture.ts`)

The `createAudioRecorder()` function:
1. Requests microphone access with WebRTC audio constraints
2. Creates a MediaRecorder to capture processed audio
3. Collects audio chunks during recording
4. Returns a Blob when recording stops

Key features:
- Logs actual applied audio settings for debugging
- Prefers WebM/Opus codec (best for speech)
- Falls back to other supported codecs if needed
- Stops all audio tracks on completion

### Server Side (`src/server/websocket-server.ts`)

The WebSocket server:
1. Receives base64-encoded audio chunks
2. Buffers chunks until recording completes
3. Passes complete audio to STT handler
4. Broadcasts transcription and TTS response

Key features:
- Simple message-based protocol
- No complex state management
- Broadcasts to all connected clients

## Troubleshooting

### Microphone Permission Denied
- Ensure HTTPS is used (required on mobile)
- Check browser permissions settings
- Try in a different browser

### Poor Audio Quality
- Check microphone settings in OS
- Verify audio constraints are applied (check console logs)
- Test microphone in other applications

### High Latency
- Check network connection
- Verify server is responding quickly
- Monitor OpenAI API response times

## Future Enhancements

Potential improvements to consider:

1. **Voice Activity Detection (VAD)**: Automatically start/stop recording based on speech detection
2. **Audio Preprocessing**: Additional client-side filtering before sending to server
3. **Compression**: Use more aggressive compression for lower bandwidth
4. **Streaming STT**: Stream audio to server for real-time transcription
5. **Audio Visualization**: Show waveform or volume meter during recording

## References

- [MDN: getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [MDN: MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [OpenAI Whisper API](https://platform.openai.com/docs/guides/speech-to-text)
- [OpenAI TTS API](https://platform.openai.com/docs/guides/text-to-speech)
