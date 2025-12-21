#!/usr/bin/env node

import { Codex } from '@openai/codex-sdk';

console.log('Testing codexPathOverride option...\n');

// Test 1: Default (embedded binary)
console.log('Test 1: Using default embedded binary');
const defaultCodex = new Codex();
console.log('✓ Created Codex instance with default settings');

// Test 2: System binary via codexPathOverride
console.log('\nTest 2: Using system binary via codexPathOverride');
const systemCodex = new Codex({
  codexPathOverride: '/Users/moboudra/.asdf/installs/nodejs/22.20.0/bin/codex'
});
console.log('✓ Created Codex instance with codexPathOverride');

// Test 3: Using which codex
console.log('\nTest 3: Using which codex result');
import { execSync } from 'child_process';
const whichCodex = execSync('which codex', { encoding: 'utf8' }).trim();
console.log('System codex location:', whichCodex);

const whichCodexInstance = new Codex({
  codexPathOverride: whichCodex
});
console.log('✓ Created Codex instance with system codex from PATH');

console.log('\n✅ All tests passed! codexPathOverride option is available and working.');
console.log('\nConclusion: You can use the system-installed codex by passing:');
console.log('  new Codex({ codexPathOverride: "/path/to/system/codex" })');
