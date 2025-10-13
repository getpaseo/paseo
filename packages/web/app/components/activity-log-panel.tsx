'use client';

import { useState, useEffect, useRef } from 'react';
import type { LogEntry, EventCategory } from '../types/realtime-events';

interface ActivityLogPanelProps {
  logs: LogEntry[];
  onClear: () => void;
}

export default function ActivityLogPanel({ logs, onClear }: ActivityLogPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const prevLogsLengthRef = useRef(0);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (logContainerRef.current && isOpen) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, isOpen]);

  // Track unread count
  useEffect(() => {
    if (!isOpen && logs.length > prevLogsLengthRef.current) {
      const newLogs = logs.length - prevLogsLengthRef.current;
      setUnreadCount(prev => prev + newLogs);
    }
    prevLogsLengthRef.current = logs.length;
  }, [logs, isOpen]);

  // Reset unread count when opening
  useEffect(() => {
    if (isOpen) {
      setUnreadCount(0);
    }
  }, [isOpen]);

  function getCategoryColor(category: EventCategory): string {
    switch (category) {
      case 'connection':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'speech':
        return 'bg-green-100 text-green-800 border-green-200';
      case 'transcription':
        return 'bg-cyan-100 text-cyan-800 border-cyan-200';
      case 'tool_call':
        return 'bg-purple-100 text-purple-800 border-purple-200';
      case 'response':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'error':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'buffer':
        return 'bg-gray-100 text-gray-800 border-gray-200';
      case 'audio':
        return 'bg-indigo-100 text-indigo-800 border-indigo-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  }

  function formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${ms}`;
  }

  function LogEntryItem({ entry }: { entry: LogEntry }) {
    const [isExpanded, setIsExpanded] = useState(false);

    return (
      <div className="border-b border-gray-700 pb-2 mb-2 last:border-b-0">
        <div className="flex items-start gap-2">
          <span className="text-xs text-gray-400 font-mono shrink-0">
            {formatTime(entry.timestamp)}
          </span>
          <span
            className={`text-xs px-2 py-0.5 rounded border font-medium shrink-0 ${getCategoryColor(entry.category)}`}
          >
            {entry.category.toUpperCase()}
          </span>
        </div>
        <div className="mt-1 text-sm text-gray-200">
          {entry.summary || entry.eventType}
        </div>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-xs text-blue-400 hover:text-blue-300 mt-1"
        >
          {isExpanded ? '▼ Hide details' : '▶ Show details'}
        </button>
        {isExpanded && (
          <pre className="mt-2 p-2 bg-gray-900 rounded text-xs text-gray-300 overflow-x-auto">
            {JSON.stringify(entry.event, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  return (
    <>
      {/* Toggle Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-4 right-4 z-50 bg-gray-800 hover:bg-gray-700 text-white rounded-full p-3 shadow-lg transition-colors"
        aria-label="Toggle activity log"
      >
        <div className="relative">
          <svg
            className="w-6 h-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
            />
          </svg>
          {unreadCount > 0 && (
            <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </div>
      </button>

      {/* Panel */}
      <div
        className={`fixed bottom-0 right-0 z-40 bg-gray-800 border-l border-t border-gray-700 shadow-2xl transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        } w-full md:w-[450px] h-[50vh] md:h-[60vh] flex flex-col`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h3 className="text-lg font-semibold text-white">Activity Log</h3>
          <div className="flex gap-2">
            <button
              onClick={onClear}
              className="text-sm px-3 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
            >
              Clear
            </button>
            <button
              onClick={() => setIsOpen(false)}
              className="text-gray-400 hover:text-white transition-colors"
              aria-label="Close"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Log Container */}
        <div
          ref={logContainerRef}
          className="flex-1 overflow-y-auto p-4 space-y-2"
        >
          {logs.length === 0 ? (
            <div className="text-center text-gray-400 py-8">
              No events yet. Connect to start logging.
            </div>
          ) : (
            logs.map(entry => <LogEntryItem key={entry.id} entry={entry} />)
          )}
        </div>
      </div>
    </>
  );
}
