import { useState, useEffect, useRef } from 'react';
import { createAudioRecorder, type AudioRecorder } from '../lib/audio-capture';

interface VoiceControlsProps {
  onAudioRecorded: (audio: Blob, format: string) => void;
  isProcessing: boolean;
}

export function VoiceControls({ onAudioRecorded, isProcessing }: VoiceControlsProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionState, setPermissionState] = useState<'prompt' | 'granted' | 'denied'>('prompt');
  const recorderRef = useRef<AudioRecorder | null>(null);

  useEffect(() => {
    // Initialize recorder
    recorderRef.current = createAudioRecorder();

    // Check microphone permission
    if (navigator.permissions) {
      navigator.permissions
        .query({ name: 'microphone' as PermissionName })
        .then((result) => {
          setPermissionState(result.state);
          result.onchange = () => {
            setPermissionState(result.state);
          };
        })
        .catch(() => {
          setPermissionState('prompt');
        });
    }
  }, []);

  async function handleToggleRecording() {
    const recorder = recorderRef.current;
    if (!recorder) return;

    try {
      setError(null);

      if (isRecording) {
        // Stop recording
        console.log('[VoiceControls] Stopping recording...');
        const audioBlob = await recorder.stop();
        setIsRecording(false);

        // Get format from blob type
        const format = audioBlob.type || 'audio/webm';
        console.log(`[VoiceControls] Recording complete: ${audioBlob.size} bytes, format: ${format}`);

        // Send to parent
        onAudioRecorded(audioBlob, format);
      } else {
        // Start recording
        console.log('[VoiceControls] Starting recording...');
        await recorder.start();
        setIsRecording(true);
        setPermissionState('granted');
      }
    } catch (err: any) {
      console.error('[VoiceControls] Recording error:', err);
      setError(err.message || 'Failed to access microphone');
      setIsRecording(false);

      if (err.message.includes('Permission denied')) {
        setPermissionState('denied');
      }
    }
  }

  const buttonDisabled = isProcessing || permissionState === 'denied';

  return (
    <div className="voice-controls">
      <button
        onClick={handleToggleRecording}
        disabled={buttonDisabled}
        className={`voice-button ${isRecording ? 'recording' : ''} ${isProcessing ? 'processing' : ''}`}
        title={isRecording ? 'Stop recording' : 'Start recording'}
      >
        {isRecording ? (
          <>
            <span className="recording-indicator" />
            <span>Recording...</span>
          </>
        ) : isProcessing ? (
          <>
            <span className="processing-indicator" />
            <span>Processing...</span>
          </>
        ) : (
          <>
            <span className="microphone-icon">🎤</span>
            <span>Record</span>
          </>
        )}
      </button>

      {error && <div className="voice-error">{error}</div>}

      {permissionState === 'denied' && (
        <div className="permission-denied">
          Microphone access denied. Please enable it in your browser settings.
        </div>
      )}
    </div>
  );
}
