import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load system prompt from agent-prompt.md in package root
export function loadSystemPrompt(): string {
  const promptPath = path.join(__dirname, '../../../agent-prompt.md');
  return readFileSync(promptPath, 'utf-8');
}

// Cache the loaded prompt
let cachedPrompt: string | null = null;

export function getSystemPrompt(): string {
  if (!cachedPrompt) {
    cachedPrompt = loadSystemPrompt();
  }
  return cachedPrompt;
}
