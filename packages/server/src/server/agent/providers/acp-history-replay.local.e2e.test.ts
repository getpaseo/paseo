import { describe, expect, test } from "vitest";
import { ACPAgentClient } from "./acp-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";

// A mode request deterministically releases replay through a controlled stdio peer.
// Post-result cases deliberately violate the protocol completion boundary.
const peer = String.raw`
import { createInterface } from 'node:readline';
const beforeResult = process.argv[1] === 'before';
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\n');
const update = (kind, id, text) => send({method:'session/update', params:{sessionId:'saved',update:{sessionUpdate:kind,messageId:id,content:{type:'text',text}}}});
const tail = () => {
  update('agent_message_chunk','reply-1','first reply');
  update('user_message_chunk','user-2','follow up');
  update('agent_message_chunk','reply-2','second reply');
};
for await (const line of createInterface({input:process.stdin})) {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
  } else if (request.method === 'session/load') {
    update('user_message_chunk','user-1','first prompt');
    if (beforeResult) tail();
    send({id:request.id,result:{modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]}}});
  } else if (request.method === 'session/set_mode') {
    if (!beforeResult) tail();
    send({id:request.id,result:{}});
  } else if (request.id !== undefined) {
    send({id:request.id,result:{}});
  }
}
`;

describe("ACP persisted history through a real stdio peer", () => {
  for (const order of ["before", "after", "during-drain"] as const) {
    test(`retains all turns with ${order} replay`, async () => {
      const client = new ACPAgentClient({
        provider: "acp",
        logger: createTestLogger(),
        defaultCommand: [process.execPath, "--input-type=module", "-e", peer, order],
      });
      const session = await client.resumeSession(
        { provider: "acp", sessionId: "saved" },
        { cwd: process.cwd() },
      );
      try {
        const collect = async () => {
          const events: AgentStreamEvent[] = [];
          for await (const event of session.streamHistory()) events.push(event);
          return events;
        };
        const pendingHistory = order === "during-drain" ? collect() : undefined;
        await session.setMode("default");
        const history = await (pendingHistory ?? collect());
        expect(
          history.flatMap((event) =>
            event.type === "timeline" && "text" in event.item ? [event.item.text] : [],
          ),
        ).toEqual(["first prompt", "first reply", "follow up", "second reply"]);
      } finally {
        await session.close();
      }
    });
  }
});
