# OpenAI Realtime API Configuration Options

This document lists all available configuration parameters for the OpenAI Realtime API session.

## Core Parameters

### `model`
- **Type**: `string`
- **Default**: `'gpt-4o-realtime-preview-2024-12-17'`
- **Options**: `'gpt-realtime'`, `'gpt-4o-realtime-preview-2024-12-17'`
- **Description**: The Realtime model to use. `gpt-realtime` is the latest production model.

### `voice`
- **Type**: `string`
- **Default**: `'alloy'`
- **Options**: `'alloy'`, `'echo'`, `'fable'`, `'onyx'`, `'nova'`, `'shimmer'`
- **Description**: Voice to use for AI speech generation

### `modalities`
- **Type**: `array of strings`
- **Default**: `['text', 'audio']`
- **Options**: `['text']`, `['audio']`, `['text', 'audio']`
- **Description**: Response modalities to use. Set to `['text']` for text-only mode with separate TTS.

### `temperature`
- **Type**: `float`
- **Default**: `0.8`
- **Range**: `0.6` to `1.2`
- **Description**: Controls response randomness. Lower values = more deterministic, higher values = more creative.

### `max_response_output_tokens`
- **Type**: `integer`
- **Default**: Not specified
- **Example**: `2048`
- **Description**: Maximum number of tokens in the model's response.

### `instructions`
- **Type**: `string`
- **Default**: None
- **Description**: System instructions for the model (like system messages in Chat API)

---

## Audio Configuration

### `input_audio_format`
- **Type**: `string`
- **Default**: `'pcm16'`
- **Options**: `'pcm16'`, `'g711_ulaw'`, `'g711_alaw'`
- **Description**: Format for input audio

### `output_audio_format`
- **Type**: `string`
- **Default**: `'pcm16'`
- **Options**: `'pcm16'`, `'g711_ulaw'`, `'g711_alaw'`
- **Description**: Format for output audio

### `input_audio_transcription`
- **Type**: `object`
- **Default**: None
- **Properties**:
  - `model`: Transcription model (e.g., `'gpt-4o-transcribe'`)
- **Description**: Configuration for transcribing input audio
- **Example**:
  ```json
  {
    "model": "gpt-4o-transcribe"
  }
  ```

### `input_audio_noise_reduction` (New in 2025)
- **Type**: `object | null`
- **Default**: `null`
- **Description**: Noise reduction configuration for input audio
- **Note**: Using noise reduction can impact latency, especially with semantic VAD turn detection
- **Status**: Recently added parameter, check latest API docs for configuration details

---

## Turn Detection Configuration

Controls when the AI should start/stop responding based on voice activity.

### `turn_detection`
- **Type**: `object | null`
- **Default**: Server VAD mode
- **Description**: Configuration for turn detection

#### Server VAD Mode (Default)
```json
{
  "type": "server_vad",
  "threshold": 0.5,
  "prefix_padding_ms": 300,
  "silence_duration_ms": 500,
  "create_response": true,
  "interrupt_response": true
}
```

**Parameters**:
- `threshold` (float, 0.0-1.0): Voice activity detection threshold. Higher values (e.g., 0.7) work better in noisy environments.
- `prefix_padding_ms` (integer): Audio to include before speech starts (ms)
- `silence_duration_ms` (integer): Silence duration to wait before considering speech ended (ms)
- `create_response` (boolean): Automatically create response when turn detected
- `interrupt_response` (boolean): Allow user to interrupt AI responses

#### Semantic VAD Mode
```json
{
  "type": "semantic_vad",
  "eagerness": "auto",
  "create_response": true,
  "interrupt_response": true
}
```

**Parameters**:
- `eagerness` (string): `'low'`, `'medium'`, `'high'`, or `'auto'`. Controls how quickly the model responds.
- `create_response` (boolean): Automatically create response
- `interrupt_response` (boolean): Allow interruptions

**Note**: Semantic VAD can have higher latency, especially with noise reduction enabled.

#### Disable Turn Detection
```json
{
  "type": "none"
}
```
Use this if you want manual control over when responses are generated.

---

## Tool Configuration

### `tools`
- **Type**: `array of objects`
- **Default**: `[]`
- **Description**: Tools available for the model to use

#### Remote MCP Server Tool
```json
{
  "type": "mcp",
  "server_label": "my-mcp-server",
  "server_url": "https://example.com/mcp",
  "authorization": "Bearer token",  // Optional
  "require_approval": "never"       // or "always"
}
```

**Parameters**:
- `type`: Must be `'mcp'` for MCP servers
- `server_label`: Friendly name for the server
- `server_url`: HTTPS URL of the MCP server
- `authorization`: Optional auth header value
- `require_approval`: `'never'` for auto-execution, `'always'` for manual approval

#### Function Tool (Client-Side)
```json
{
  "type": "function",
  "name": "function_name",
  "description": "What the function does",
  "parameters": {
    "type": "object",
    "properties": {
      "param1": {
        "type": "string",
        "description": "Parameter description"
      }
    },
    "required": ["param1"]
  }
}
```

### `tool_choice`
- **Type**: `string`
- **Default**: `'auto'`
- **Options**: `'auto'`, `'required'`, `'none'`
- **Description**: Controls when tools are used
  - `'auto'`: AI decides when to use tools
  - `'required'`: AI must use a tool
  - `'none'`: Tools disabled for this response

---

## Current Configuration (app/api/session/route.ts)

```typescript
{
  model: 'gpt-realtime',
  voice: 'shimmer',
  input_audio_transcription: {
    model: 'gpt-4o-transcribe',
  },
  tools: [
    {
      type: 'mcp',
      server_label: 'local-mcp',
      server_url: 'https://mohameds-macbook-pro.tail8fe838.ts.net/mcp?password=dev-password',
      require_approval: 'never',
    },
  ],
}
```

---

## Recommended Settings for Different Use Cases

### High Quality Conversation (Default)
```json
{
  "model": "gpt-realtime",
  "temperature": 0.8,
  "turn_detection": {
    "type": "server_vad",
    "threshold": 0.5
  }
}
```

### Noisy Environment
```json
{
  "model": "gpt-realtime",
  "input_audio_noise_reduction": {},
  "turn_detection": {
    "type": "server_vad",
    "threshold": 0.7,  // Higher threshold for noisy environments
    "silence_duration_ms": 700  // Wait longer for silence
  }
}
```

### More Deterministic Responses
```json
{
  "model": "gpt-realtime",
  "temperature": 0.6,
  "max_response_output_tokens": 1024
}
```

### Fast, Responsive Conversation
```json
{
  "model": "gpt-realtime",
  "turn_detection": {
    "type": "semantic_vad",
    "eagerness": "high"
  }
}
```

### Manual Control (No Auto-Response)
```json
{
  "model": "gpt-realtime",
  "turn_detection": {
    "type": "none"
  }
}
```

---

## Notes on Noise Reduction

**Availability**: `input_audio_noise_reduction` is a newly added parameter (2025).

**Pros**:
- Improves recognition in noisy environments
- Better handling of background noise

**Cons**:
- Can increase latency, especially with semantic VAD
- May affect audio quality in some cases

**Recommendation**: Test with and without noise reduction to see if the latency trade-off is worth it for your use case.

---

## Client-Side Audio Processing

In addition to server-side configuration, consider client-side audio processing:

1. **Browser WebRTC**: Modern browsers include:
   - Echo cancellation
   - Noise suppression
   - Automatic gain control

2. **getUserMedia constraints**:
   ```javascript
   navigator.mediaDevices.getUserMedia({
     audio: {
       echoCancellation: true,
       noiseSuppression: true,
       autoGainControl: true
     }
   });
   ```

These are currently **not configured** in the app but can be added in `use-webrtc-voice.ts` for additional audio quality improvements.

---

## References

- [OpenAI Realtime API Documentation](https://platform.openai.com/docs/guides/realtime)
- [OpenAI Realtime API Reference](https://platform.openai.com/docs/api-reference/realtime)
- [LiveKit OpenAI Plugin Docs](https://docs.livekit.io/agents/integrations/realtime/openai/)
