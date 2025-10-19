"""
LiveKit Voice Agent with MCP Support (Python)
Migrated from Node.js version with added MCP integration
"""

import asyncio
import os
from pathlib import Path
from typing import Any, AsyncIterable, Coroutine

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    AutoSubscribe,
    JobContext,
    JobProcess,
    WorkerOptions,
    cli,
    llm,
    voice,
    inference,
)
from livekit.agents.llm.mcp import MCPServerHTTP
from livekit.agents.llm.tool_context import FunctionTool, RawFunctionTool
from livekit.agents.voice import ModelSettings
from livekit.plugins import anthropic, openai, silero
from livekit.plugins.turn_detector.english import EnglishModel

# Load environment variables
load_dotenv()


def load_system_prompt() -> str:
    """Load system prompt from agent-prompt.md file."""
    prompt_path = Path(__file__).parent / "agent-prompt.md"
    return prompt_path.read_text()


# Load system prompt from external file for easier editing
SYSTEM_PROMPT = load_system_prompt()


class TimedAgent(voice.Agent):
    """Agent that waits for TTS to complete before executing tool calls."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._current_speech_handle: Any = None

    async def llm_node(
        self,
        chat_ctx: llm.ChatContext,
        tools: list[FunctionTool | RawFunctionTool],
        model_settings: ModelSettings,
    ) -> AsyncIterable[llm.ChatChunk | str]:
        """Override llm_node to buffer tool calls until after text."""
        tool_chunk_buffer: list[llm.ChatChunk] = []
        text_chunks: list[llm.ChatChunk] = []

        print(f"[TimedAgent] llm_node called")

        # Get result from parent - might be coroutine or async iterable
        parent_result = super().llm_node(chat_ctx, tools, model_settings)

        # Handle coroutine case
        if isinstance(parent_result, Coroutine):
            resolved = await parent_result
            # The resolved value should be an async iterable
            if resolved is None:
                print(f"[TimedAgent] parent_result resolved to None")
                return
            parent_result = resolved  # type: ignore[assignment]

        # Now iterate
        async for chunk in parent_result:  # type: ignore[union-attr]
            if isinstance(chunk, llm.ChatChunk) and chunk.delta:
                # Collect text chunks
                if chunk.delta.content:
                    print(f"[TimedAgent] Text chunk: {chunk.delta.content[:50]}...")
                    text_chunks.append(chunk)
                    yield chunk  # Let TTS start immediately

                # Buffer tool calls
                if chunk.delta.tool_calls:
                    print(f"[TimedAgent] Tool call chunk: {chunk.delta.tool_calls}")
                    tool_chunk_buffer.append(chunk)
            else:
                print(f"[TimedAgent] Other chunk type: {type(chunk)}")
                yield chunk

        print(f"[TimedAgent] Done iterating. text_chunks={len(text_chunks)}, tool_chunks={len(tool_chunk_buffer)}")

        # If we have tool calls, wait for speech to complete
        if tool_chunk_buffer:
            if text_chunks:
                # Estimate speech duration: ~150 words per minute = 2.5 words/sec = 0.4 sec/word
                total_words = sum(
                    len(chunk.delta.content.split())
                    for chunk in text_chunks
                    if chunk.delta and chunk.delta.content
                )
                # Add extra buffer time for TTS processing and network
                estimated_duration = (total_words * 0.4) + 1.0
                print(f"[TimedAgent] Waiting {estimated_duration}s for {total_words} words to be spoken")
                await asyncio.sleep(estimated_duration)
            else:
                # No text but we have tool calls - wait a default amount
                print(f"[TimedAgent] No text chunks but have tool calls - waiting 2s default")
                await asyncio.sleep(2.0)

        # Now yield the tool calls
        print(f"[TimedAgent] Yielding {len(tool_chunk_buffer)} tool calls")
        for tool_chunk in tool_chunk_buffer:
            yield tool_chunk


async def entrypoint(ctx: JobContext) -> None:
    """Main entry point for the voice agent."""

    # Get API keys from environment
    openrouter_api_key = os.getenv("OPENROUTER_API_KEY")
    if not openrouter_api_key:
        raise ValueError("OPENROUTER_API_KEY environment variable is required")

    # Get MCP server URL from environment
    mcp_server_url = os.getenv("MCP_SERVER_URL")

    # Prepare MCP servers list
    mcp_servers: list[MCPServerHTTP] = []
    if mcp_server_url:
        print(f"✓ MCP Server configured: {mcp_server_url}")
        server = MCPServerHTTP(
            url=mcp_server_url,
            timeout=10
        )
        mcp_servers.append(server)
    else:
        print("⚠ No MCP_SERVER_URL found in environment")

    # Connect to the room
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    # Create the voice agent with MCP tools
    agent = TimedAgent(
        instructions=SYSTEM_PROMPT,
        mcp_servers=mcp_servers,  # Native MCP support!
    )

    # Create the agent session with BYOK (Bring Your Own Key)
    # Using Claude via OpenRouter for redundancy against downtime
    session: Any = voice.AgentSession(
        stt=openai.STT(
            model="gpt-4o-transcribe",
        ),
        vad=silero.VAD.load(
            min_silence_duration=1.2,  # Wait 1.2s after speech ends before considering turn complete (default: 0.55s)
        ),
        turn_detection=EnglishModel(),  # Context-aware turn detector prevents premature turn-taking
        llm=openai.LLM(
            model="anthropic/claude-sonnet-4.5",
            # model="z-ai/glm-4.6",
            base_url="https://openrouter.ai/api/v1",
            api_key=openrouter_api_key,
        ),
        tts=inference.TTS(
            model="inworld/inworld-tts-1",
            voice="Olivia",
            language="en"
        ),
        # Tool execution limits
        max_tool_steps=10,  # Max consecutive tool calls per turn (default: 3)
        # Turn detection configuration - less aggressive (give user more time)
        min_endpointing_delay=1.0,  # Minimum 1s before responding (default: 0.5s)
        # Interruption configuration - more aggressive (allow faster interruption)
        allow_interruptions=True,  # Allow user to interrupt agent mid-speech
        min_interruption_duration=0.2,  # Detect interruption after 0.2s of speech (default: 0.5s)
        min_interruption_words=0,  # Don't require full word to interrupt (default: 0)
        # Generation configuration
        preemptive_generation=True,  # Disable preemptive generation for more accurate responses
    )

    # Start the session
    await session.start(agent=agent, room=ctx.room)

    print(f"✓ Agent started successfully in room: {ctx.room.name}")
    print(f"✓ MCP servers: {len(mcp_servers)} configured")


if __name__ == "__main__":
    # Run the agent worker
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
        )
    )
