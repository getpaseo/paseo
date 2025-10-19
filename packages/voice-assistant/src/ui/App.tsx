import { useState, useEffect, useRef } from "react";
import { Mic, Send } from "lucide-react";
import { useWebSocket } from "./hooks/useWebSocket";
import { createAudioPlayer } from "./lib/audio-playback";
import { createAudioRecorder, type AudioRecorder } from "./lib/audio-capture";
import { ToolCallCard } from "./components/ToolCallCard";
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
      status: "executing" | "completed";
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
  const logEndRef = useRef<HTMLDivElement>(null);
  const audioPlayerRef = useRef(createAudioPlayer());
  const recorderRef = useRef<AudioRecorder | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // WebSocket URL - use ws://localhost:3000/ws in dev, or construct from current host in prod
  const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${
    window.location.host
  }/ws`;

  const ws = useWebSocket(wsUrl);

  useEffect(() => {
    recorderRef.current = createAudioRecorder();
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
    const unsubStatus = ws.on("status", (payload: unknown) => {
      const data = payload as { status: string; message?: string };
      addLog("info", data.message || `Status: ${data.status}`);
    });

    // Listen for pong messages
    const unsubPong = ws.on("pong", () => {
      addLog("success", "Received pong from server");
    });

    // Listen for activity log messages
    const unsubActivity = ws.on("activity_log", (payload: unknown) => {
      const data = payload as {
        id: string;
        type: string;
        content: string;
        metadata?: Record<string, unknown>;
      };

      // Handle tool calls
      if (data.type === "tool_call") {
        const { toolCallId, toolName, arguments: args } = data.metadata as {
          toolCallId: string;
          toolName: string;
          arguments: any;
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

      if (data.type === "tool_result") {
        const { toolCallId, result } = data.metadata as {
          toolCallId: string;
          result: any;
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
    const unsubChunk = ws.on("assistant_chunk", (payload: unknown) => {
      const data = payload as { chunk: string };
      setCurrentAssistantMessage((prev) => prev + data.chunk);
    });

    // Listen for transcription results
    const unsubTranscription = ws.on(
      "transcription_result",
      (_payload: unknown) => {
        // Note: Transcription is already broadcast as activity_log with type "transcript"
        // No need to log it again here to avoid duplication
        setIsProcessingAudio(false);
      }
    );

    // Listen for audio output (TTS)
    const unsubAudioOutput = ws.on("audio_output", async (payload: unknown) => {
      const data = payload as { audio: string; format: string; id: string };

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
          type: "audio_played",
          payload: { id: data.id },
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
      unsubPong();
      unsubActivity();
      unsubChunk();
      unsubTranscription();
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
          type: "audio_chunk",
          payload: {
            audio: base64Audio,
            format: format,
            isLast: true,
          },
        });

        console.log(`[App] Sent audio: ${audioBlob.size} bytes, format: ${format}`);
      } else {
        console.log('[App] Starting recording...');
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
              {logs.map((log) =>
                log.type === "tool_call" ? (
                  <ToolCallCard
                    key={log.id}
                    toolName={log.toolName}
                    args={log.args}
                    result={log.result}
                    status={log.status}
                  />
                ) : (
                  <div key={log.id} className={`log-entry ${log.type}`}>
                    <span className="log-message">{log.message}</span>
                    {log.metadata && (
                      <details className="log-metadata">
                        <summary>Details</summary>
                        <pre>{JSON.stringify(log.metadata, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                )
              )}
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
              disabled={!ws.isConnected || isRecording}
              className="message-input"
              rows={1}
            />
            <button
              type="button"
              onClick={handleButtonClick}
              disabled={!ws.isConnected || isProcessingAudio}
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
    </div>
  );
}

export default App;
