// Re-export types from openai-realtime-api for type safety
import type { RealtimeServerEvents, RealtimeClientEvents } from 'openai-realtime-api';

export type RealtimeServerEvent = RealtimeServerEvents.EventMap[RealtimeServerEvents.EventType];
export type RealtimeClientEvent = RealtimeClientEvents.EventMap[RealtimeClientEvents.EventType];

// Agent status enum
export type AgentStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'listening'
  | 'processing'
  | 'tool_executing'
  | 'speaking';

// Event category for UI display
export type EventCategory =
  | 'connection'
  | 'audio'
  | 'speech'
  | 'transcription'
  | 'response'
  | 'tool_call'
  | 'error'
  | 'buffer'
  | 'other';

// Log entry with parsed event data
export interface LogEntry {
  id: string;
  timestamp: number;
  category: EventCategory;
  eventType: string;
  event: RealtimeServerEvent;
  summary?: string;
}

// Helper to categorize events
export function categorizeEvent(event: RealtimeServerEvent): EventCategory {
  const type = event.type;

  if (type.startsWith('session.')) return 'connection';
  if (type.startsWith('input_audio_buffer.')) return 'speech';
  if (type.includes('transcription')) return 'transcription';
  if (type.includes('function_call')) return 'tool_call';
  if (type.startsWith('response.audio')) return 'audio';
  if (type.startsWith('response.')) return 'response';
  if (type.startsWith('conversation.')) return 'audio';
  if (type.includes('error')) return 'error';
  if (type.includes('rate_limits')) return 'buffer';

  return 'other';
}

// Helper to get event summary
export function getEventSummary(event: RealtimeServerEvent): string {
  const type = event.type;

  switch (type) {
    case 'session.created':
      return 'Session established';

    case 'input_audio_buffer.speech_started':
      return 'User started speaking';

    case 'input_audio_buffer.speech_stopped':
      return 'User stopped speaking';

    case 'input_audio_buffer.committed':
      return 'Audio committed for processing';

    case 'conversation.item.input_audio_transcription.completed':
      if ('transcript' in event) {
        return `Transcription: "${event.transcript}"`;
      }
      return 'Transcription completed';

    case 'response.audio_transcript.delta':
      if ('delta' in event) {
        return `AI: "${event.delta}"`;
      }
      return 'AI speaking...';

    case 'response.audio_transcript.done':
      if ('transcript' in event) {
        return `AI said: "${event.transcript}"`;
      }
      return 'AI finished speaking';

    case 'response.function_call_arguments.done':
      if ('name' in event && 'arguments' in event) {
        return `Tool: ${event.name}(${event.arguments})`;
      }
      return 'Tool call executed';

    case 'response.audio.delta':
      return 'AI audio streaming...';

    case 'response.audio.done':
      return 'AI audio complete';

    case 'response.done':
      return 'Response completed';

    case 'error':
      if ('error' in event && typeof event.error === 'object' && event.error !== null && 'message' in event.error) {
        return `Error: ${event.error.message}`;
      }
      return 'Error occurred';

    default:
      return type;
  }
}

// Helper to get status from event
export function getStatusFromEvent(event: RealtimeServerEvent): AgentStatus | null {
  const type = event.type;

  switch (type) {
    case 'session.created':
      return 'connected';

    case 'input_audio_buffer.speech_started':
      return 'listening';

    case 'input_audio_buffer.speech_stopped':
    case 'input_audio_buffer.committed':
      return 'processing';

    case 'response.function_call_arguments.done':
      return 'tool_executing';

    case 'response.audio.delta':
      return 'speaking';

    case 'response.audio.done':
    case 'response.done':
      return 'connected';

    default:
      return null;
  }
}
