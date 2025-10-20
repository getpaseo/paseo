// Shared server types

export interface ServerConfig {
  port: number;
  isDev: boolean;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: Date;
  type: 'transcript' | 'assistant' | 'tool_call' | 'tool_result' | 'error' | 'system';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface WebSocketMessage {
  type: 'activity_log' | 'status' | 'ping' | 'pong' | 'user_message' | 'assistant_chunk'
       | 'audio_chunk' | 'audio_output' | 'recording_state' | 'transcription_result' | 'audio_played'
       | 'artifact';
  payload: unknown;
}

export interface AudioChunkPayload {
  audio: string; // base64 encoded audio data
  format: string; // 'webm', 'ogg', etc.
  isLast: boolean; // true when recording stopped
}

export interface RecordingStatePayload {
  isRecording: boolean;
}

export interface TranscriptionResultPayload {
  text: string;
  language?: string;
  duration?: number;
}

export interface AudioOutputPayload {
  audio: string; // base64 encoded audio data (complete)
  format: string; // 'mp3'
  id: string; // unique ID for queue management
}

export interface AudioPlayedPayload {
  id: string; // unique ID of the audio that finished playing
}

export interface ArtifactPayload {
  type: 'markdown' | 'diff' | 'image' | 'code';
  id: string;
  title: string;
  content: string; // resolved content (base64 for file/command sources, plain text for text source)
  isBase64: boolean; // true if content is base64 encoded (from file or command_output)
}
