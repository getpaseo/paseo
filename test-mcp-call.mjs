#!/usr/bin/env node

const CLAUDE_AGENT_ID = 'f7644b18-7fb9-4491-80f3-788d0d27a119';
const CODEX_AGENT_ID = 'd7c360ea-1579-4091-b224-ee8442400823';

const url = 'http://127.0.0.1:6767/mcp/agents';
const auth = Buffer.from('mo:bo').toString('base64');

async function makeRequest(method, params) {
  console.log(`\n[TEST] Calling ${method} with params:`, JSON.stringify(params, null, 2));
  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: method,
          arguments: params
        }
      })
    });

    const elapsed = Date.now() - startTime;
    console.log(`[TEST] Response received in ${elapsed}ms`);

    const data = await response.json();
    console.log(`[TEST] Response:`, JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`[TEST] Request failed after ${elapsed}ms:`, error.message);
    throw error;
  }
}

async function initialize() {
  console.log('[TEST] Initializing MCP session...');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${auth}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'test-client',
          version: '1.0.0'
        }
      }
    })
  });
  const data = await response.json();
  console.log('[TEST] Initialized:', JSON.stringify(data, null, 2));
}

async function main() {
  console.log('=== Testing MCP Agent Control Tools ===\n');

  // Initialize session
  await initialize();

  // Test 1: Get status of Codex agent (should work)
  console.log('\n--- Test 1: get_agent_status on Codex agent ---');
  await makeRequest('get_agent_status', { agentId: CODEX_AGENT_ID });

  // Test 2: Get status of Claude agent (might hang)
  console.log('\n--- Test 2: get_agent_status on Claude agent ---');
  await makeRequest('get_agent_status', { agentId: CLAUDE_AGENT_ID });

  console.log('\n=== All tests complete ===');
}

main().catch(console.error);
