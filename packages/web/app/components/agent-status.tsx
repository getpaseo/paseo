import type { AgentStatus } from '../types/realtime-events';

interface AgentStatusProps {
  status: AgentStatus;
}

export default function AgentStatus({ status }: AgentStatusProps) {
  function getStatusConfig() {
    switch (status) {
      case 'disconnected':
        return {
          color: 'bg-gray-500',
          text: 'Disconnected',
          icon: '○',
          animate: false
        };
      case 'connecting':
        return {
          color: 'bg-yellow-500',
          text: 'Connecting',
          icon: '◐',
          animate: true
        };
      case 'connected':
        return {
          color: 'bg-green-500',
          text: 'Connected',
          icon: '●',
          animate: false
        };
      case 'listening':
        return {
          color: 'bg-blue-500',
          text: 'Listening',
          icon: '🎤',
          animate: true
        };
      case 'processing':
        return {
          color: 'bg-purple-500',
          text: 'Processing',
          icon: '⚙',
          animate: true
        };
      case 'tool_executing':
        return {
          color: 'bg-orange-500',
          text: 'Executing Tool',
          icon: '🔧',
          animate: true
        };
      case 'speaking':
        return {
          color: 'bg-cyan-500',
          text: 'Speaking',
          icon: '🔊',
          animate: true
        };
    }
  }

  const config = getStatusConfig();

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-gray-100 rounded-lg">
      <div className="relative">
        <div
          className={`w-3 h-3 rounded-full ${config.color} ${config.animate ? 'animate-pulse' : ''}`}
        />
      </div>
      <span className="text-sm font-medium text-gray-700">
        {config.icon} {config.text}
      </span>
    </div>
  );
}
