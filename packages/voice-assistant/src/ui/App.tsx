import { useState, useEffect, useRef } from "react";
import { Mic, Send, Radio } from "lucide-react";
import { useWebSocket } from "./hooks/useWebSocket";
import { createAudioPlayer } from "./lib/audio-playback";
import { createAudioRecorder, type AudioRecorder } from "./lib/audio-capture";
import { createRealtimeVAD, float32ArrayToBlob, type RealtimeVAD } from "./lib/audio-realtime";
import { ToolCallCard } from "./components/ToolCallCard";
import { ArtifactDrawer, type Artifact } from "./components/ArtifactDrawer";
import "./App.css";

type LogEntry =
  | {
      type: "system" | "info" | "success" | "error" | "user" | "assistant";
      id: string;
      timestamp: number;
      message: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "tool_call";
      id: string;
      timestamp: number;
      toolName: string;
      args: any;
      result?: any;
      error?: any;
      status: "executing" | "completed" | "failed";
    }
  | {
      type: "artifact";
      id: string;
      timestamp: number;
      artifactId: string;
      artifactType: string;
      title: string;
    };

function App() {
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: "1",
      timestamp: Date.now(),
      type: "system",
      message: "System initialized",
    },
  ]);
  const [userInput, setUserInput] = useState("");
  const [currentAssistantMessage, setCurrentAssistantMessage] = useState("");
  const [isProcessingAudio, setIsProcessingAudio] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isRealtimeMode, setIsRealtimeMode] = useState(false);
  const [isSpeechDetected, setIsSpeechDetected] = useState(false);
  const [isVADLoading, setIsVADLoading] = useState(false);
  const [currentArtifact, setCurrentArtifact] = useState<Artifact | null>(null);
  const [artifacts, setArtifacts] = useState<Map<string, Artifact>>(new Map());
  const logEndRef = useRef<HTMLDivElement>(null);
  const audioPlayerRef = useRef(createAudioPlayer());
  const recorderRef = useRef<AudioRecorder | null>(null);
  const vadRef = useRef<RealtimeVAD | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // WebSocket URL - use ws://localhost:3000/ws in dev, or construct from current host in prod
  const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${
    window.location.host
  }/ws`;

  const ws = useWebSocket(wsUrl);

  useEffect(() => {
    recorderRef.current = createAudioRecorder();

    // Cleanup VAD on unmount
    return () => {
      if (vadRef.current) {
        vadRef.current.destroy();
      }
    };
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const newHeight = Math.max(textareaRef.current.scrollHeight, 44);
      textareaRef.current.style.height = `${newHeight}px`;
    }
  }, [userInput]);

  const addLog = (
    type: "system" | "info" | "success" | "error" | "user" | "assistant",
    message: string,
    metadata?: Record<string, unknown>
  ) => {
    setLogs((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        timestamp: Date.now(),
        type,
        message,
        metadata,
      },
    ]);
  };

  useEffect(() => {
    // Listen for status messages
    const unsubStatus = ws.on("status", (message) => {
      if (message.type !== 'status') return;
      const msg = 'message' in message.payload ? String(message.payload.message) : undefined;
      addLog("info", msg || `Status: ${message.payload.status}`);
    });

    // Listen for activity log messages
    const unsubActivity = ws.on("activity_log", (message) => {
      if (message.type !== 'activity_log') return;
      const data = message.payload;

      // Handle tool calls
      if (data.type === "tool_call" && data.metadata) {
        const { toolCallId, toolName, arguments: args } = data.metadata as {
          toolCallId: string;
          toolName: string;
          arguments: unknown;
        };

        setLogs((prev) => [
          ...prev,
          {
            type: "tool_call",
            id: toolCallId,
            timestamp: Date.now(),
            toolName,
            args,
            status: "executing",
          },
        ]);
        return;
      }

      if (data.type === "tool_result" && data.metadata) {
        const { toolCallId, result } = data.metadata as {
          toolCallId: string;
          result: unknown;
        };

        setLogs((prev) =>
          prev.map((log) =>
            log.type === "tool_call" && log.id === toolCallId
              ? { ...log, result, status: "completed" as const }
              : log
          )
        );
        return;
      }

      // Handle tool errors - update tool call status to failed
      if (data.type === "error" && data.metadata && 'toolCallId' in data.metadata) {
        const { toolCallId, error } = data.metadata as {
          toolCallId: string;
          error: unknown;
        };

        setLogs((prev) =>
          prev.map((log) =>
            log.type === "tool_call" && log.id === toolCallId
              ? { ...log, error, status: "failed" as const }
              : log
          )
        );
        // Don't return - still add the error message to the log
      }

      // Map activity log types to UI log types
      let logType: "system" | "info" | "success" | "error" | "user" | "assistant" = "info";
      if (data.type === "transcript") logType = "user";
      else if (data.type === "assistant") logType = "assistant";
      else if (data.type === "error") logType = "error";

      addLog(logType, data.content, data.metadata);

      // Clear streaming state when assistant segment is received
      if (data.type === "assistant") {
        setCurrentAssistantMessage("");
      }
    });

    // Listen for streaming assistant chunks
    const unsubChunk = ws.on("assistant_chunk", (message) => {
      if (message.type !== 'assistant_chunk') return;
      setCurrentAssistantMessage((prev) => prev + message.payload.chunk);
    });

    // Listen for transcription results
    const unsubTranscription = ws.on("transcription_result", () => {
      // Note: Transcription is already broadcast as activity_log with type "transcript"
      // No need to log it again here to avoid duplication
      setIsProcessingAudio(false);
    });

    // Listen for artifacts
    const unsubArtifact = ws.on("artifact", (message) => {
      if (message.type !== 'artifact') return;
      const artifact = message.payload;

      // Add to artifacts map
      setArtifacts((prev) => {
        const newMap = new Map(prev);
        newMap.set(artifact.id, artifact);
        return newMap;
      });

      // Add as clickable log entry
      setLogs((prev) => [
        ...prev,
        {
          type: "artifact" as const,
          id: Date.now().toString(),
          timestamp: Date.now(),
          artifactId: artifact.id,
          artifactType: artifact.type,
          title: artifact.title,
        },
      ]);

      // Show drawer by default
      setCurrentArtifact(artifact);
    });

    // Listen for audio output (TTS)
    const unsubAudioOutput = ws.on("audio_output", async (message) => {
      if (message.type !== 'audio_output') return;
      const data = message.payload;

      try {
        setIsPlayingAudio(true);

        // Decode base64 audio
        const binaryString = atob(data.audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        // Create blob with correct mime type
        const mimeType =
          data.format === "mp3" ? "audio/mpeg" : `audio/${data.format}`;
        const audioBlob = new Blob([bytes], { type: mimeType });

        // Play audio
        await audioPlayerRef.current.play(audioBlob);

        // Send confirmation back to server
        ws.send({
          type: "session",
          message: {
            type: "audio_played",
            id: data.id,
          },
        });

        setIsPlayingAudio(false);
      } catch (error: any) {
        console.error("[App] Audio playback error:", error);
        addLog("error", `Audio playback failed: ${error.message}`);
        setIsPlayingAudio(false);
      }
    });

    return () => {
      unsubStatus();
      unsubActivity();
      unsubChunk();
      unsubTranscription();
      unsubArtifact();
      unsubAudioOutput();
    };
  }, [ws]);

  useEffect(() => {
    if (ws.isConnected) {
      addLog("success", "WebSocket connected");
    } else {
      addLog("system", "WebSocket disconnected");
    }
  }, [ws.isConnected]);

  // Auto-scroll to bottom when new logs are added
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, currentAssistantMessage]);

  const handleSendMessage = () => {
    if (!userInput.trim() || !ws.isConnected) return;

    // Stop any currently playing audio and clear the queue
    audioPlayerRef.current.stop();
    setIsPlayingAudio(false);

    // Send message to server
    ws.sendUserMessage(userInput);

    // Clear input and reset streaming state
    setUserInput("");
    setCurrentAssistantMessage("");
  };

  const handleToggleRecording = async () => {
    const recorder = recorderRef.current;
    if (!recorder || !ws.isConnected) return;

    try {
      if (isRecording) {
        console.log('[App] Stopping recording...');
        const audioBlob = await recorder.stop();
        setIsRecording(false);

        const format = audioBlob.type || 'audio/webm';
        console.log(`[App] Recording complete: ${audioBlob.size} bytes, format: ${format}`);

        setIsProcessingAudio(true);
        addLog("info", "Sending audio to server...");

        const arrayBuffer = await audioBlob.arrayBuffer();
        const base64Audio = btoa(
          new Uint8Array(arrayBuffer).reduce(
            (data, byte) => data + String.fromCharCode(byte),
            ""
          )
        );

        ws.send({
          type: "session",
          message: {
            type: "audio_chunk",
            audio: base64Audio,
            format: format,
            isLast: true,
          },
        });

        console.log(`[App] Sent audio: ${audioBlob.size} bytes, format: ${format}`);
      } else {
        console.log('[App] Starting recording...');

        // Stop any currently playing audio when starting to record
        audioPlayerRef.current.stop();
        setIsPlayingAudio(false);

        await recorder.start();
        setIsRecording(true);
      }
    } catch (error: any) {
      console.error('[App] Recording error:', error);
      addLog("error", `Failed to record audio: ${error.message}`);
      setIsRecording(false);
    }
  };

  const handleButtonClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();

    if (userInput.trim()) {
      handleSendMessage();
    } else {
      await handleToggleRecording();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Detect if device is desktop (not mobile/tablet)
    const isDesktop = window.matchMedia('(pointer: fine)').matches;

    if (e.key === 'Enter') {
      if (isDesktop && !e.shiftKey && userInput.trim()) {
        // Desktop: plain Enter sends message
        e.preventDefault();
        handleSendMessage();
      }
      // Desktop: Shift+Enter creates new line (default behavior)
      // Mobile: Enter creates new line (default behavior)
    }
  };

  const handleCloseArtifact = () => {
    setCurrentArtifact(null);
  };

  const handleOpenArtifact = (artifactId: string) => {
    const artifact = artifacts.get(artifactId);
    if (artifact) {
      setCurrentArtifact(artifact);
    }
  };

  const handleToggleRealtimeMode = async () => {
    if (!ws.isConnected) return;

    try {
      if (isRealtimeMode) {
        // Stop realtime mode
        if (vadRef.current) {
          vadRef.current.pause();
        }
        setIsRealtimeMode(false);
        setIsSpeechDetected(false);
        addLog("info", "Realtime mode stopped");
      } else {
        // Start realtime mode
        setIsVADLoading(true);
        addLog("info", "Starting realtime mode...");

        // Create VAD instance if it doesn't exist
        if (!vadRef.current) {
          vadRef.current = createRealtimeVAD({
            onModelLoading: () => {
              console.log("[App] VAD model loading...");
              setIsVADLoading(true);
            },
            onModelLoaded: () => {
              console.log("[App] VAD model loaded");
              setIsVADLoading(false);
            },
            onSpeechStart: () => {
              console.log("[App] Speech detected!");
              setIsSpeechDetected(true);

              // Interrupt playback when speech is detected
              audioPlayerRef.current.stop();
              setIsPlayingAudio(false);
              setCurrentAssistantMessage("");

              // Send abort request to server immediately
              ws.send({
                type: "session",
                message: {
                  type: "abort_request",
                },
              });
            },
            onSpeechEnd: async (audioData: Float32Array) => {
              console.log("[App] Speech ended, processing...");
              setIsSpeechDetected(false);
              setIsProcessingAudio(true);

              try {
                // Convert Float32Array to audio blob
                const audioBlob = float32ArrayToBlob(audioData, 16000);
                console.log(`[App] Converted to blob: ${audioBlob.size} bytes`);

                // Send to server
                const arrayBuffer = await audioBlob.arrayBuffer();
                const base64Audio = btoa(
                  new Uint8Array(arrayBuffer).reduce(
                    (data, byte) => data + String.fromCharCode(byte),
                    ""
                  )
                );

                ws.send({
                  type: "session",
                  message: {
                    type: "audio_chunk",
                    audio: base64Audio,
                    format: audioBlob.type,
                    isLast: true,
                  },
                });

                console.log(`[App] Sent realtime audio to server`);
              } catch (error: any) {
                console.error("[App] Failed to process VAD audio:", error);
                addLog("error", `Failed to process audio: ${error.message}`);
                setIsProcessingAudio(false);
              }
            },
            onVADMisfire: () => {
              console.log("[App] VAD misfire");
              setIsSpeechDetected(false);
            },
            onError: (error: Error) => {
              console.error("[App] VAD error:", error);
              addLog("error", `VAD error: ${error.message}`);
              setIsVADLoading(false);
              setIsRealtimeMode(false);
            },
          });
        }

        // Start VAD
        await vadRef.current.start();
        setIsRealtimeMode(true);
        setIsVADLoading(false);
        addLog("success", "Realtime mode started - speak anytime!");
      }
    } catch (error: any) {
      console.error("[App] Realtime mode error:", error);
      addLog("error", `Failed to toggle realtime mode: ${error.message}`);
      setIsRealtimeMode(false);
      setIsVADLoading(false);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Voice Assistant</h1>
        <div className="header-status">
          {isPlayingAudio && <div className="audio-playing-indicator" title="Playing audio" />}
          <div
            className={`status-indicator ${
              ws.isConnected ? "connected" : "disconnected"
            }`}
          >
            {ws.isConnected ? "connected" : "disconnected"}
          </div>
        </div>
      </header>

      <main className="main">
        <div className="chat-interface">
          <div className="activity-log">
            <div className="log-entries">
              {logs.map((log) => {
                if (log.type === "tool_call") {
                  return (
                    <ToolCallCard
                      key={log.id}
                      toolName={log.toolName}
                      args={log.args}
                      result={log.result}
                      error={log.error}
                      status={log.status}
                    />
                  );
                }

                if (log.type === "artifact") {
                  return (
                    <div
                      key={log.id}
                      className="log-entry artifact clickable"
                      onClick={() => handleOpenArtifact(log.artifactId)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          handleOpenArtifact(log.artifactId);
                        }
                      }}
                    >
                      <span className="log-message">
                        📋 {log.artifactType}: {log.title}
                      </span>
                    </div>
                  );
                }

                return (
                  <div key={log.id} className={`log-entry ${log.type}`}>
                    <span className="log-message">{log.message}</span>
                    {log.metadata && (
                      <details className="log-metadata">
                        <summary>Details</summary>
                        <pre>{JSON.stringify(log.metadata, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                );
              })}
              {currentAssistantMessage && (
                <div className="log-entry assistant streaming">
                  <span className="log-message">{currentAssistantMessage}</span>
                  <span className="streaming-indicator">...</span>
                </div>
              )}
              <div ref={logEndRef} />
            </div>
          </div>

          <div className="message-form">
            <textarea
              ref={textareaRef}
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message or tap mic to talk..."
              disabled={!ws.isConnected || isRecording || isRealtimeMode}
              className="message-input"
              rows={1}
            />
            <button
              type="button"
              onClick={handleToggleRealtimeMode}
              disabled={!ws.isConnected || isRecording || isVADLoading}
              className={`send-button realtime-button ${isRealtimeMode ? 'active' : ''} ${isSpeechDetected ? 'speech-detected' : ''} ${isVADLoading ? 'loading' : ''}`}
              title={isRealtimeMode ? "Stop realtime mode" : "Start realtime mode"}
            >
              {isVADLoading ? (
                <span className="loading-indicator" />
              ) : (
                <Radio size={20} />
              )}
            </button>
            <button
              type="button"
              onClick={handleButtonClick}
              disabled={!ws.isConnected || isProcessingAudio || isRealtimeMode}
              className={`send-button ${isRecording ? 'recording' : ''} ${isProcessingAudio ? 'processing' : ''} ${userInput.trim() ? 'has-text' : ''}`}
            >
              {isRecording ? (
                <span className="recording-indicator" />
              ) : isProcessingAudio ? (
                <span className="processing-indicator" />
              ) : userInput.trim() ? (
                <Send size={20} />
              ) : (
                <Mic size={20} />
              )}
            </button>
          </div>
        </div>
      </main>

      <ArtifactDrawer
        artifact={currentArtifact}
        onClose={handleCloseArtifact}
      />
    </div>
  );
}

export default App;
