'use client';

import { useState } from 'react';
import { useWebRTCVoice } from './hooks/use-webrtc-voice';
import { useAudioLevel } from './hooks/use-audio-level';
import { useAudioDevices } from './hooks/use-audio-devices';
import { useEventLog } from './hooks/use-event-log';
import VolumeBar from './components/volume-bar';
import MuteButton from './components/mute-button';
import DeviceSelector from './components/device-selector';
import AgentStatus from './components/agent-status';
import ActivityLogPanel from './components/activity-log-panel';

export default function VoiceClient() {
  const [isMuted, setIsMuted] = useState(false);

  // Initialize event logging
  const { logs, agentStatus, addLog, clearLogs } = useEventLog();

  const {
    isConnected,
    isConnecting,
    error,
    stream,
    connect,
    disconnect
  } = useWebRTCVoice({
    onEvent: addLog
  });

  const {
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    error: devicesError,
  } = useAudioDevices();

  const volume = useAudioLevel(stream);

  function handleConnect() {
    connect(selectedDeviceId);
  }

  function handleMuteToggle() {
    if (!stream) return;

    const newMutedState = !isMuted;

    stream.getAudioTracks().forEach(track => {
      track.enabled = !newMutedState;
    });

    setIsMuted(newMutedState);
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4 md:gap-8 p-4 md:p-8">
      <h1 className="text-2xl md:text-4xl font-bold text-center">Real-Time Voice</h1>

      {/* Agent Status */}
      <AgentStatus status={agentStatus} />

      {devicesError && (
        <div className="bg-yellow-50 border border-yellow-400 text-yellow-800 px-4 py-3 rounded max-w-md text-sm md:text-base">
          <p className="font-medium">⚠️ {devicesError}</p>
          {devicesError.includes('HTTPS') && (
            <p className="mt-2 text-xs md:text-sm">
              For mobile access, use HTTPS or a tunneling service like ngrok or Cloudflare Tunnel.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded max-w-md text-sm md:text-base">
          {error}
        </div>
      )}

      <div className="flex flex-col md:flex-row items-center md:items-end gap-4 md:gap-8 w-full max-w-2xl">
        <div className="flex justify-center w-full md:w-auto">
          <VolumeBar volume={volume} isMuted={isMuted} />
        </div>

        <div className="flex flex-col gap-4 w-full md:w-auto md:min-w-[240px]">
          {!isConnected && (
            <DeviceSelector
              devices={devices}
              selectedDeviceId={selectedDeviceId}
              onDeviceChange={setSelectedDeviceId}
              disabled={isConnecting}
            />
          )}

          {!isConnected ? (
            <button
              onClick={handleConnect}
              disabled={isConnecting || !!devicesError}
              className="w-full px-6 md:px-8 py-3 md:py-4 bg-green-500 hover:bg-green-600 text-white rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isConnecting ? 'Connecting...' : 'Start Voice Chat'}
            </button>
          ) : (
            <>
              <MuteButton
                isMuted={isMuted}
                onToggle={handleMuteToggle}
                disabled={!isConnected}
              />
              <button
                onClick={disconnect}
                className="w-full px-6 md:px-8 py-3 md:py-4 bg-gray-500 hover:bg-gray-600 text-white rounded-lg font-medium"
              >
                Disconnect
              </button>
            </>
          )}
        </div>
      </div>

      {isConnected && (
        <p className="text-green-600 font-medium text-center text-sm md:text-base">
          Connected - Speak to interact with AI
        </p>
      )}

      {/* Activity Log Panel */}
      <ActivityLogPanel logs={logs} onClear={clearLogs} />
    </div>
  );
}
