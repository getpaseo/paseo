"""
LiveKit Voice Agent with MCP Support (Python)
Migrated from Node.js version with added MCP integration
"""

import asyncio
import os
from pathlib import Path
from typing import Annotated

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
)
from livekit.agents.llm.mcp import MCPServerHTTP

# Load environment variables
load_dotenv()


def load_system_prompt() -> str:
    """Load system prompt from agent-prompt.md file."""
    prompt_path = Path(__file__).parent / "agent-prompt.md"
    return prompt_path.read_text()


# Load system prompt from external file for easier editing
SYSTEM_PROMPT = load_system_prompt()


async def entrypoint(ctx: JobContext):
    """Main entry point for the voice agent."""

    # Get MCP server URL from environment
    mcp_server_url = os.getenv("MCP_SERVER_URL")

    # Prepare MCP servers list
    mcp_servers = []
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
    agent = voice.Agent(
        instructions=SYSTEM_PROMPT,
        mcp_servers=mcp_servers,  # Native MCP support!
    )

    # Create the agent session with LiveKit Inference
    # Using same configuration as Node.js version
    session = voice.AgentSession(
        stt="assemblyai/universal-streaming:en",
        llm="openai/gpt-4.1-mini",
        tts="cartesia/sonic-2:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
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
