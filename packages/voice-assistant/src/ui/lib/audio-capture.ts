export interface AudioCaptureConfig {
  mimeType?: string;
  audioBitsPerSecond?: number;
}

export interface AudioRecorder {
  start(): Promise<void>;
  stop(): Promise<Blob>;
  isRecording(): boolean;
  getSupportedMimeType(): string | null;
}

export function createAudioRecorder(config?: AudioCaptureConfig): AudioRecorder {
  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let stream: MediaStream | null = null;
  let recording = false;

  // Detect supported mime type
  function getSupportedMimeType(): string | null {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
      'audio/wav',
    ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }

    return null;
  }

  async function start(): Promise<void> {
    if (recording) {
      throw new Error('Already recording');
    }

    try {
      // Request microphone permission with WebRTC audio processing constraints
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,      // Remove echo from speakers
          noiseSuppression: true,       // Remove background noise
          autoGainControl: true,        // Normalize volume
          sampleRate: 16000,            // Optimal for speech (Whisper works well with this)
          channelCount: 1,              // Mono audio (sufficient for voice)
        },
        video: false,
      });

      // Check which constraints were actually applied
      const track = stream.getAudioTracks()[0];
      const settings = track.getSettings();
      console.log('[AudioRecorder] Audio settings:', settings);

      // Try WebM/Opus first (best compression and quality for speech)
      const mimeType = config?.mimeType ||
        (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : getSupportedMimeType());

      if (!mimeType) {
        throw new Error('No supported audio mime type found');
      }

      // Create MediaRecorder
      const options: MediaRecorderOptions = {
        mimeType,
      };

      if (config?.audioBitsPerSecond) {
        options.audioBitsPerSecond = config.audioBitsPerSecond;
      }

      mediaRecorder = new MediaRecorder(stream, options);
      audioChunks = [];

      // Collect data chunks
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
          console.log(`[AudioRecorder] Chunk received: ${event.data.size} bytes`);
        }
      };

      // Start recording
      mediaRecorder.start(100); // Collect chunks every 100ms
      recording = true;

      console.log('[AudioRecorder] Recording started with constraints:', {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 16000,
        channelCount: 1,
        mimeType,
      });
    } catch (error: any) {
      console.error('[AudioRecorder] Failed to start recording:', error);
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
      throw new Error(`Failed to start audio recording: ${error.message}`);
    }
  }

  async function stop(): Promise<Blob> {
    if (!recording || !mediaRecorder) {
      throw new Error('Not recording');
    }

    return new Promise((resolve, reject) => {
      if (!mediaRecorder) {
        reject(new Error('MediaRecorder not initialized'));
        return;
      }

      mediaRecorder.onstop = () => {
        // Create blob from chunks
        const mimeType = mediaRecorder?.mimeType || 'audio/webm';
        const audioBlob = new Blob(audioChunks, { type: mimeType });

        console.log('[AudioRecorder] Recording stopped:', {
          size: audioBlob.size,
          type: mimeType,
          chunks: audioChunks.length,
        });

        // Clean up
        if (stream) {
          stream.getTracks().forEach((track) => {
            track.stop();
            console.log('[AudioRecorder] Stopped track:', track.label);
          });
          stream = null;
        }

        recording = false;
        mediaRecorder = null;
        audioChunks = [];

        resolve(audioBlob);
      };

      mediaRecorder.onerror = (event: Event) => {
        console.error('[AudioRecorder] MediaRecorder error:', event);
        reject(new Error('MediaRecorder error during stop'));
      };

      // Stop recording
      mediaRecorder.stop();
    });
  }

  function isRecordingFunc(): boolean {
    return recording;
  }

  return {
    start,
    stop,
    isRecording: isRecordingFunc,
    getSupportedMimeType,
  };
}

export function checkMicrophonePermission(): Promise<PermissionState> {
  // Check if browser supports permissions API
  if (!navigator.permissions) {
    return Promise.resolve('prompt' as PermissionState);
  }

  return navigator.permissions
    .query({ name: 'microphone' as PermissionName })
    .then((result) => result.state)
    .catch(() => 'prompt' as PermissionState);
}
