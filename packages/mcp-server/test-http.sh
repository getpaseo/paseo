#!/bin/bash

# Test MCP HTTP server with curl
# Usage: ./test-http.sh

PASSWORD="dev-password"
BASE_URL="http://localhost:3000"

echo "Testing MCP HTTP server..."
echo

# Test 1: Health check
echo "1. Health check:"
curl -s "$BASE_URL/" | jq .
echo

# Test 2: MCP initialize request
echo "2. Sending MCP initialize request:"
curl -s -X POST "$BASE_URL/messages?password=$PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {
        "name": "test-client",
        "version": "1.0.0"
      }
    }
  }' | jq .
echo

# Test 3: List tools
echo "3. Listing available tools:"
curl -s -X POST "$BASE_URL/messages?password=$PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list"
  }' | jq .
echo

echo "Done!"
