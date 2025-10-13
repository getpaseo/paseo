import { NextResponse } from 'next/server';
import { SYSTEM_PROMPT } from './system-prompt';

export async function POST() {
  const apiKey = process.env.OPENAI_API_KEY;
  const mcpServerUrl = process.env.MCP_SERVER_URL;

  if (!apiKey) {
    return NextResponse.json(
      { error: 'OpenAI API key not configured' },
      { status: 500 }
    );
  }

  if (!mcpServerUrl) {
    return NextResponse.json(
      { error: 'MCP server URL not configured' },
      { status: 500 }
    );
  }

  try {
    const response = await fetch(
      'https://api.openai.com/v1/realtime/sessions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-realtime',
          voice: 'shimmer',
          instructions: SYSTEM_PROMPT,
          input_audio_transcription: {
            model: 'gpt-4o-transcribe',
          },
          tools: [
            {
              type: 'mcp',
              server_label: 'tmux-mcp',
              server_url: mcpServerUrl,
              require_approval: 'never',
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Session creation error:', error);
    return NextResponse.json(
      { error: 'Failed to create session' },
      { status: 500 }
    );
  }
}
