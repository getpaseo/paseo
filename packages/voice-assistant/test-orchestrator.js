/**
 * Simple test script to verify the orchestrator and LLM integration
 * Run with: OPENAI_API_KEY=your_key node test-orchestrator.js
 */

import { initializeOpenAI, streamLLM } from './dist/server/agent/llm-openai.js';
import { getSystemPrompt } from './dist/server/agent/system-prompt.js';

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.error('ERROR: OPENAI_API_KEY environment variable is not set');
    console.error('Usage: OPENAI_API_KEY=your_key node test-orchestrator.js');
    process.exit(1);
  }

  console.log('Initializing OpenAI client...');
  initializeOpenAI(apiKey);

  console.log('\nStarting conversation with assistant...');
  console.log('User: "list all terminals"\n');

  const messages = [
    { role: 'system', content: getSystemPrompt() },
    { role: 'user', content: 'list all terminals' }
  ];

  console.log('Assistant response:');

  try {
    const response = await streamLLM({
      messages,
      onChunk: (chunk) => {
        process.stdout.write(chunk);
      },
      onToolCall: (toolName, args) => {
        console.log(`\n[Tool Call] ${toolName}`, JSON.stringify(args, null, 2));
      },
      onToolResult: (toolName, result) => {
        console.log(`[Tool Result] ${toolName}:`, JSON.stringify(result, null, 2));
      },
      onFinish: () => {
        console.log('\n\nConversation complete!');
      }
    });

    console.log('\n\nFinal response:', response);
  } catch (error) {
    console.error('\nError:', error.message);
    console.error(error.stack);
  }
}

main();
