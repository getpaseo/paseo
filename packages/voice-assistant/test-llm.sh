#!/bin/bash

# Test script for LLM integration
# This script demonstrates how to use the /api/test-llm endpoint

echo "Testing LLM Integration"
echo "======================"
echo ""

# Check if server is running
if ! curl -s http://localhost:3000/api/health > /dev/null; then
  echo "❌ Server is not running on port 3000"
  echo "Please start the server with: npm start"
  exit 1
fi

echo "✓ Server is running"
echo ""

# Test 1: Create a terminal
echo "Test 1: Create a terminal called 'llm-test'"
echo "--------------------------------------------"
curl -s -X POST http://localhost:3000/api/test-llm \
  -H "Content-Type: application/json" \
  -d '{"message": "create a terminal called llm-test"}' | jq .
echo ""

# Test 2: List all terminals
echo ""
echo "Test 2: List all terminals"
echo "--------------------------"
curl -s -X POST http://localhost:3000/api/test-llm \
  -H "Content-Type: application/json" \
  -d '{"message": "list all terminals"}' | jq .
echo ""

# Test 3: Run a command in the terminal
echo ""
echo "Test 3: Run 'echo hello from LLM' in the llm-test terminal"
echo "-----------------------------------------------------------"
curl -s -X POST http://localhost:3000/api/test-llm \
  -H "Content-Type: application/json" \
  -d '{"message": "run echo \"hello from LLM\" in the llm-test terminal"}' | jq .
echo ""

echo ""
echo "✓ All tests completed!"
echo ""
echo "Note: You can also test manually with:"
echo "curl -X POST http://localhost:3000/api/test-llm \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{\"message\": \"your message here\"}' | jq ."
