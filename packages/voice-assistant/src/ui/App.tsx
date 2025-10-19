import { useState, useEffect, useRef } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { VoiceControls } from "./components/VoiceControls";
import { createAudioPlayer } from "./lib/audio-playback";
import "./App.css";

interface LogEntry {
  id: string;
  timestamp: number;
  type: "system" | "info" | "success" | "error" | "user" | "assistant" | "tool";
  message: string;
  metadata?: Record<string, unknown>;
}

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
  const logEndRef = useRef<HTMLDivElement>(null);
  const audioPlayerRef = useRef(createAudioPlayer());

  // WebSocket URL - use ws://localhost:3000/ws in dev, or construct from current host in prod
  const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${
    window.location.host
  }/ws`;

  const ws = useWebSocket(wsUrl);

  const addLog = (
    type: LogEntry["type"],
    message: string,
    metadata?: Record<string, unknown>
  ) => {
    console.trace("addLog", type, message, metadata);
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
        type: string;
        content: string;
        metadata?: Record<string, unknown>;
      };

      // Map activity log types to UI log types
      let logType: LogEntry["type"] = "info";
      if (data.type === "transcript") logType = "user";
      else if (data.type === "assistant") logType = "assistant";
      else if (data.type === "tool_call" || data.type === "tool_result")
        logType = "tool";
      else if (data.type === "error") logType = "error";

      addLog(logType, data.content, data.metadata);

      // Clear streaming state when complete assistant message arrives
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
      (payload: unknown) => {
        // Note: Transcription is already broadcast as activity_log with type "transcript"
        // No need to log it again here to avoid duplication
        setIsProcessingAudio(false);
      }
    );

    // Listen for audio output (TTS)
    const unsubAudioOutput = ws.on("audio_output", async (payload: unknown) => {
      const data = payload as { audio: string; format: string; id: string };

      try {
        addLog("info", "Playing assistant audio response...");
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

        setIsPlayingAudio(false);
        addLog("success", "Audio playback complete");
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

  const handlePing = () => {
    ws.sendPing();
    addLog("info", "Sent ping to server");
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userInput.trim() || !ws.isConnected) return;

    // Send message to server
    ws.sendUserMessage(userInput);

    // Clear input and reset streaming state
    setUserInput("");
    setCurrentAssistantMessage("");
  };

  const handleAudioRecorded = async (audioBlob: Blob, format: string) => {
    if (!ws.isConnected) {
      addLog("error", "Cannot send audio - not connected to server");
      return;
    }

    try {
      setIsProcessingAudio(true);
      addLog("info", "Sending audio to server...");

      // Convert blob to base64
      const arrayBuffer = await audioBlob.arrayBuffer();
      const base64Audio = btoa(
        new Uint8Array(arrayBuffer).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          ""
        )
      );

      // Send audio chunk via WebSocket
      ws.send({
        type: "audio_chunk",
        payload: {
          audio: base64Audio,
          format: format,
          isLast: true,
        },
      });

      console.log(
        `[App] Sent audio: ${audioBlob.size} bytes, format: ${format}`
      );
    } catch (error: any) {
      console.error("[App] Error sending audio:", error);
      addLog("error", `Failed to send audio: ${error.message}`);
      setIsProcessingAudio(false);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Voice Assistant</h1>
        <div
          className={`status-indicator ${
            ws.isConnected ? "connected" : "disconnected"
          }`}
        >
          {ws.isConnected ? "connected" : "disconnected"}
        </div>
      </header>

      <main className="main">
        <div className="chat-interface">
          <h2>Chat with Assistant</h2>

          <VoiceControls
            onAudioRecorded={handleAudioRecorded}
            isProcessing={isProcessingAudio}
            isPlaying={isPlayingAudio}
          />

          <div className="activity-log">
            <div className="log-entries">
              {logs.map((log) => (
                <div key={log.id} className={`log-entry ${log.type}`}>
                  <span className="log-time">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="log-message">{log.message}</span>
                  {log.metadata && (
                    <details className="log-metadata">
                      <summary>Details</summary>
                      <pre>{JSON.stringify(log.metadata, null, 2)}</pre>
                    </details>
                  )}
                </div>
              ))}
              {currentAssistantMessage && (
                <div className="log-entry assistant streaming">
                  <span className="log-time">
                    {new Date().toLocaleTimeString()}
                  </span>
                  <span className="log-message">{currentAssistantMessage}</span>
                  <span className="streaming-indicator">...</span>
                </div>
              )}
              <div ref={logEndRef} />
            </div>
          </div>

          <form onSubmit={handleSendMessage} className="message-form">
            <input
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder="Type a message to the assistant..."
              disabled={!ws.isConnected}
              className="message-input"
            />
            <button
              type="submit"
              disabled={!ws.isConnected || !userInput.trim()}
              className="send-button"
            >
              Send
            </button>
          </form>

          <div className="test-controls">
            <button
              onClick={handlePing}
              disabled={!ws.isConnected}
              className="ping-button"
            >
              Send Ping (Test)
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
