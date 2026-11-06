import type { OmpAgentMessage } from "../rpc-types.js";

// Synthetic image and native OMP normalization captured in the one-prompt 2026-10-27 QA run.
export const imageHistory = {
  clientMessageId: "6736-omp-image-20261027",
  originalImage: {
    data: "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABfklEQVR4nO3RAQmAABBDUUPYP6MNtIMMxvR9LsCxd9yqdrQf+HsAygEoB6AcgHIAygEoB6AcgHIAygEoB6AcgHIAygEoB6AcgHIAygEoB6AcgHIAygEoFwO4zvNXl9oNAIDNS+0GAMDmpXYDAGDzUrsBALB5qd0AANi81G4AAGxeajcAADYvtRsAAJuX2g0AgM1L7QYAwOaldgMAYPNSuwEAsHmp3QAA2LzUbgAAbF5qNwAANi+1GwAAm5faDQCAzUvtBgDA5qV2AwBg81K7AQCweandAADYvNRuAABsXmo3AAA2L7UbAACbl9oNAIDNS+0GAMDmpXYDAGDzUrsBALB5qd0AANi81G4AAGxeajcAADYvtRsAAJuX2g0AgM1L7QYAwOaldgMAYPNSuwEAsHmp3QAA2LzUbgAAbF5qNwAANi+1G4CvAOhdAMoBKAegHIByAMoBKAegHIByAMoBKAegHIByAMoBKAegHIByAMoBKAegHIByAMoBKAeg3AOlxutiG6CP/AAAAABJRU5ErkJggg==",
    mimeType: "image/png",
  },
  nativeEntry: {
    type: "message",
    id: "a6c4387f",
    parentId: null,
    timestamp: "2026-10-27T06:06:34.364Z",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "Describe the dominant colors and shapes in the attached test image in one short sentence. Do not use tools.",
        },
        {
          type: "image",
          mimeType: "image/webp",
          data: "UklGRnYBAABXRUJQVlA4IGoBAADwEgCdASrIAMgAPm02mUgkIyKhJggQgA2JZW7hceECea1gWIDBAPQA6ADrAPQA6V3yMwLEF7gvcF7gvcF7gvcF4QrrtmyNtAUYwalsPzZT9nCcuRecZ7TlUREAeEa7jyHnU1sLkV//TkzL/fr12sU0Gu48Z7TlUpEs98mzNsapDKTrD8Qim1GyNtAUYwV2q14q3gFOsaXP8bNd/9UfqioAAP7/UlAAEz9aPKsHSwRI6f/cNI6BrZo6uBHVswasXmuar+3IE0Aepi8f06v7/BFbs37h/3kyidk3/5lHSm2fTJDQfkLDl/b7xCipUVEIN7VXqwibypXpF/qhWjGtta5B+b39vMonYCCCvqxENbsSwZ0dq2E9tIz+V/l4EAQ4ICDJmlj0kcC1zu/W9t4M2EibckOazyg5SQtGiHsP8RGWTtiqj7l8fgeCK2koCfEY6wyGW8DGKDD7xyqMH0+AAcx69F3Np11AAAAAAA==",
        },
      ],
      timestamp: 1793081194364,
    },
  },
} satisfies {
  clientMessageId: string;
  originalImage: { data: string; mimeType: string };
  nativeEntry: {
    type: string;
    id: string;
    parentId: null;
    timestamp: string;
    message: OmpAgentMessage;
  };
};
