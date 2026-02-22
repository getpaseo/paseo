import { describe, expect, it } from 'vitest'

import {
  AgentStreamMessageSchema,
  FetchAgentTimelineResponseMessageSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WSOutboundMessageSchema,
} from './messages.js'

describe('shared messages stream parsing', () => {
  it('parses representative fetch_agent_timeline_response payload', () => {
    const parsed = FetchAgentTimelineResponseMessageSchema.parse({
      type: 'fetch_agent_timeline_response',
      payload: {
        requestId: 'req-1',
        agentId: 'agent_live',
        direction: 'tail',
        projection: 'projected',
        epoch: 'epoch-1',
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
        startCursor: { epoch: 'epoch-1', seq: 1 },
        endCursor: { epoch: 'epoch-1', seq: 2 },
        hasOlder: false,
        hasNewer: false,
        entries: [
          {
            provider: 'codex',
            item: { type: 'assistant_message', text: 'hello' },
            timestamp: '2026-02-08T20:10:00.000Z',
            seqStart: 1,
            seqEnd: 2,
            sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
            collapsed: ['assistant_merge'],
          },
        ],
        error: null,
      },
    })

    expect(parsed.payload.entries).toHaveLength(1)
    expect(parsed.payload.entries[0]?.item.type).toBe('assistant_message')
  })

  it('parses representative agent_stream tool_call event', () => {
    const parsed = AgentStreamMessageSchema.parse({
      type: 'agent_stream',
      payload: {
        agentId: 'agent_live',
        timestamp: '2026-02-08T20:10:00.000Z',
        event: {
          type: 'timeline',
          provider: 'claude',
          item: {
            type: 'tool_call',
            callId: 'call_live',
            name: 'shell',
            status: 'running',
            detail: {
              type: 'shell',
              command: 'ls',
            },
            error: null,
          },
        },
      },
    })

    expect(parsed.payload.event.type).toBe('timeline')
    if (parsed.payload.event.type === 'timeline') {
      expect(parsed.payload.event.item.type).toBe('tool_call')
      if (parsed.payload.event.item.type === 'tool_call') {
        expect(parsed.payload.event.item.status).toBe('running')
      }
    }
  })

  it('parses representative sub_agent tool_call event', () => {
    const parsed = AgentStreamMessageSchema.parse({
      type: 'agent_stream',
      payload: {
        agentId: 'agent_live',
        timestamp: '2026-02-08T20:10:00.000Z',
        event: {
          type: 'timeline',
          provider: 'claude',
          item: {
            type: 'tool_call',
            callId: 'call_sub_agent_live',
            name: 'Task',
            status: 'running',
            detail: {
              type: 'sub_agent',
              subAgentType: 'Explore',
              description: 'Inspect repository structure',
              log: '[Read] README.md',
              actions: [
                {
                  index: 1,
                  toolName: 'Read',
                  summary: 'README.md',
                },
              ],
            },
            error: null,
          },
        },
      },
    })

    expect(parsed.payload.event.type).toBe('timeline')
    if (parsed.payload.event.type === 'timeline') {
      expect(parsed.payload.event.item.type).toBe('tool_call')
      if (parsed.payload.event.item.type === 'tool_call') {
        expect(parsed.payload.event.item.detail.type).toBe('sub_agent')
      }
    }
  })

  it('rejects removed initialize_agent_request inbound payload', () => {
    const parsed = SessionInboundMessageSchema.safeParse({
      type: 'initialize_agent_request',
      agentId: 'agent-legacy',
      requestId: 'req-legacy-1',
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects removed initialize_agent_request outbound payload', () => {
    const parsed = SessionOutboundMessageSchema.safeParse({
      type: 'initialize_agent_request',
      payload: {
        requestId: 'req-legacy-1',
        agentId: 'agent-legacy',
        agentStatus: 'running',
        timelineSize: 12,
      },
    })
    expect(parsed.success).toBe(false)
  })

  it('parses directory suggestions request and response payloads', () => {
    const requestParsed = SessionInboundMessageSchema.safeParse({
      type: 'directory_suggestions_request',
      query: 'proj',
      cwd: '/tmp/project',
      includeFiles: true,
      includeDirectories: true,
      limit: 20,
      requestId: 'req-dir-1',
    })
    expect(requestParsed.success).toBe(true)

    const responseParsed = SessionOutboundMessageSchema.safeParse({
      type: 'directory_suggestions_response',
      payload: {
        directories: ['/Users/test/projects/paseo'],
        entries: [{ path: '/Users/test/projects/paseo', kind: 'directory' }],
        error: null,
        requestId: 'req-dir-1',
      },
    })
    expect(responseParsed.success).toBe(true)
  })

  it('rejects websocket envelope for removed agent_stream_snapshot message type', () => {
    const fixture = {
      type: 'agent_stream_snapshot',
      payload: {
        agentId: 'agent-legacy',
        events: [],
      },
    }
    const wrapped = WSOutboundMessageSchema.safeParse({
      type: 'session',
      message: fixture,
    })
    expect(wrapped.success).toBe(false)
  })

  it('rejects removed legacy git diff request messages', () => {
    const gitDiffParsed = SessionInboundMessageSchema.safeParse({
      type: 'git_diff_request',
      agentId: 'agent-1',
      requestId: 'req-1',
    })
    expect(gitDiffParsed.success).toBe(false)

    const highlightedParsed = SessionInboundMessageSchema.safeParse({
      type: 'highlighted_diff_request',
      agentId: 'agent-1',
      requestId: 'req-2',
    })
    expect(highlightedParsed.success).toBe(false)
  })

  it('rejects removed legacy git diff response messages', () => {
    const gitDiffParsed = SessionOutboundMessageSchema.safeParse({
      type: 'git_diff_response',
      payload: {
        agentId: 'agent-1',
        diff: '',
        error: null,
        requestId: 'req-1',
      },
    })
    expect(gitDiffParsed.success).toBe(false)

    const highlightedParsed = SessionOutboundMessageSchema.safeParse({
      type: 'highlighted_diff_response',
      payload: {
        agentId: 'agent-1',
        files: [],
        error: null,
        requestId: 'req-2',
      },
    })
    expect(highlightedParsed.success).toBe(false)
  })
})
