import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { expect, test } from "vitest";

import { clipMcpProtocolVersionHeader } from "./mcp-protocol-version-clip.js";

// A request as Node presents it: raw pairs in wire case, and `headers` keyed in
// lower case with duplicate values joined by ", ".
function request(rawHeaders: string[]) {
  const headers: Record<string, string> = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    headers[name] = name in headers ? `${headers[name]}, ${rawHeaders[i + 1]}` : rawHeaders[i + 1];
  }
  return { headers, rawHeaders: [...rawHeaders] };
}

const OLDER_SUPPORTED = SUPPORTED_PROTOCOL_VERSIONS[1];

test.each([
  {
    header: "an unsupported version",
    raw: ["Content-Type", "application/json", "MCP-Protocol-Version", "2026-07-28"],
    expected: ["Content-Type", "application/json", "MCP-Protocol-Version", LATEST_PROTOCOL_VERSION],
  },
  {
    header: "the same unsupported version twice, in two cases",
    raw: ["mcp-protocol-version", "DRAFT-2026-v1", "Mcp-Protocol-Version", "DRAFT-2026-v1"],
    expected: ["mcp-protocol-version", LATEST_PROTOCOL_VERSION],
  },
  {
    header: "a supported older version",
    raw: ["mcp-protocol-version", OLDER_SUPPORTED],
    expected: ["mcp-protocol-version", OLDER_SUPPORTED],
  },
])("$header leaves one effective protocol header the SDK server accepts", ({ raw, expected }) => {
  const req = request(raw);

  clipMcpProtocolVersionHeader(req);

  expect(req.rawHeaders).toEqual(expected);
  expect(req.headers).toEqual(request(expected).headers);
});
