import type { PiAgentMessage } from "../rpc-types.js";

interface PiImageHistoryEntry {
  id: string;
  parentId: string | null;
  message: PiAgentMessage;
}

const entries: PiImageHistoryEntry[] = [
  {
    id: "57061f34",
    parentId: "9e61cd48",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "",
        },
        {
          type: "image",
          data: "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABfklEQVR4nO3RAQmAABBDUUPYP6MNtIMMxvR9LsCxd9yqdrQf+HsAygEoB6AcgHIAygEoB6AcgHIAygEoB6AcgHIAygEoB6AcgHIAygEoB6AcgHIAygEoFwO4zvNXl9oNAIDNS+0GAMDmpXYDAGDzUrsBALB5qd0AANi81G4AAGxeajcAADYvtRsAAJuX2g0AgM1L7QYAwOaldgMAYPNSuwEAsHmp3QAA2LzUbgAAbF5qNwAANi+1GwAAm5faDQCAzUvtBgDA5qV2AwBg81K7AQCweandAADYvNRuAABsXmo3AAA2L7UbAACbl9oNAIDNS+0GAMDmpXYDAGDzUrsBALB5qd0AANi81G4AAGxeajcAADYvtRsAAJuX2g0AgM1L7QYAwOaldgMAYPNSuwEAsHmp3QAA2LzUbgAAbF5qNwAANi+1G4CvAOhdAMoBKAegHIByAMoBKAegHIByAMoBKAegHIByAMoBKAegHIByAMoBKAegHIByAMoBKAeg3AOlxutiG6CP/AAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        },
      ],
    },
  },
  {
    id: "8d685bfe",
    parentId: "57061f34",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "The image shows a red square.",
        },
      ],
      responseId: "chatcmpl-202610170331459670478748268d9d6BQ03vEV3",
    },
  },
  {
    id: "8417b730",
    parentId: "8d685bfe",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "Name the color and shape visible in this attached image. Reply in one short sentence.",
        },
        {
          type: "image",
          data: "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAB7ElEQVR4nO3RwW0CQRQEUYLgTP4BkJ85IPlgWTbsLlvd86s0Afzpd/kytAt9wPQEgBMATgA4AeAEgBMATgA4AeAEgBMATgA4AeAEgBMATgA4AeAEgBMATgC4eoDr/UafsCsB4LoBrvfb89GHbE8AuGKA7/WrDQSAawX4sX6vgQBwlQC/rl9qIABcH8Af6zcaCABXBvDv+nUGAsA1Aby4fpeBAHA1AG+tX2QgAFwHwIb1WwwEgCsA2Lx+hYEAcOkAO9fPNxAALhrgkPXDDQSAywU4cP1kAwHgQgEOXz/WQAC4RIAPrZ9pIABcHMBH1w80EAAuC+CE9dMMBIALAjht/SgDAeBSAE5eP8dAALgIAGT9EAMB4HgAcP0EAwFmA+Dr4wYCDAbAd08wEGAqAL54iIEAIwHwrXMMBJgHgK8cZSDAMAB83zQDASYB4MsGGggwBgDfNNNAgBkA+JqxBgIMAMB3TDYQYHUAfMFwAwGWBsC3yzcQYF0AfLUKAwEWBcD3ajEQYEUAfKkiAwGWA8A36jIQYC0AfJ06AwEWAsB3aTQQYBUAfJFSAwGWAMC36DUQoB8AX6HaQIByAPz/CY8EsJ0JACcAnABwAsAJACcAnABwAsAJACcAnABwAsAJACcAnABwAsAJACcAnABwD/3mY1IktLCwAAAAAElFTkSuQmCC",
          mimeType: "image/png",
        },
      ],
    },
  },
  {
    id: "f1b64f31",
    parentId: "8417b730",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "The image shows a green triangle.",
        },
      ],
      responseId: "chatcmpl-202610170331498395063948268d9d67pm73lN2",
    },
  },
];

export const imageHistory = {
  provenance: {
    piVersion: "1.3.0",
    model: "google-cloud/gemini-3.8-flash",
    capturedAt: "2026-10-17T03:31:26Z",
    source: "6513124ca16cf18db0df5eba3fda80c9fe2b37f0",
    description:
      "Synthetic red square and green triangle; native user/assistant entries with only text, image and response identities retained.",
  },
  entries,
};
