'use client';

import { useState, useCallback } from 'react';
import type {
  RealtimeServerEvent,
  AgentStatus,
  LogEntry,
  EventCategory
} from '../types/realtime-events';
import {
  categorizeEvent,
  getEventSummary,
  getStatusFromEvent
} from '../types/realtime-events';

const MAX_LOG_ENTRIES = 100;

interface UseEventLogReturn {
  logs: LogEntry[];
  agentStatus: AgentStatus;
  addLog: (event: RealtimeServerEvent) => void;
  setAgentStatus: (status: AgentStatus) => void;
  clearLogs: () => void;
}

export function useEventLog(): UseEventLogReturn {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('disconnected');

  const addLog = useCallback((event: RealtimeServerEvent) => {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substring(7)}`,
      timestamp: Date.now(),
      category: categorizeEvent(event),
      eventType: event.type,
      event,
      summary: getEventSummary(event)
    };

    setLogs(prevLogs => {
      const newLogs = [...prevLogs, entry];
      // Keep only the last MAX_LOG_ENTRIES
      if (newLogs.length > MAX_LOG_ENTRIES) {
        return newLogs.slice(-MAX_LOG_ENTRIES);
      }
      return newLogs;
    });

    // Auto-update agent status based on event
    const newStatus = getStatusFromEvent(event);
    if (newStatus) {
      setAgentStatus(newStatus);
    }
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  return {
    logs,
    agentStatus,
    addLog,
    setAgentStatus,
    clearLogs
  };
}
