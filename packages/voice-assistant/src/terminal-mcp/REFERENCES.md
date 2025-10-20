```typescript
const server = new McpServer({
  name: "my-app",
  version: "1.0.0",
});

// Simple tool with parameters
server.registerTool(
  "calculate-bmi",
  {
    title: "BMI Calculator",
    description: "Calculate Body Mass Index",
    inputSchema: {
      weightKg: z.number(),
      heightM: z.number(),
    },
    outputSchema: { bmi: z.number() },
  },
  async ({ weightKg, heightM }) => {
    const output = { bmi: weightKg / (heightM * heightM) };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(output),
        },
      ],
      structuredContent: output,
    };
  }
);

// Async tool with external API call
server.registerTool(
  "fetch-weather",
  {
    title: "Weather Fetcher",
    description: "Get weather data for a city",
    inputSchema: { city: z.string() },
    outputSchema: { temperature: z.number(), conditions: z.string() },
  },
  async ({ city }) => {
    const response = await fetch(`https://api.weather.com/${city}`);
    const data = await response.json();
    const output = { temperature: data.temp, conditions: data.conditions };
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  }
);

// Tool that returns ResourceLinks
server.registerTool(
  "list-files",
  {
    title: "List Files",
    description: "List project files",
    inputSchema: { pattern: z.string() },
    outputSchema: {
      count: z.number(),
      files: z.array(z.object({ name: z.string(), uri: z.string() })),
    },
  },
  async ({ pattern }) => {
    const output = {
      count: 2,
      files: [
        { name: "README.md", uri: "file:///project/README.md" },
        { name: "index.ts", uri: "file:///project/src/index.ts" },
      ],
    };
    return {
      content: [
        { type: "text", text: JSON.stringify(output) },
        // ResourceLinks let tools return references without file content
        {
          type: "resource_link",
          uri: "file:///project/README.md",
          name: "README.md",
          mimeType: "text/markdown",
          description: "A README file",
        },
        {
          type: "resource_link",
          uri: "file:///project/src/index.ts",
          name: "index.ts",
          mimeType: "text/typescript",
          description: "An index file",
        },
      ],
      structuredContent: output,
    };
  }
);
```

```typescript
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

  bench('InMemoryTransport', async () => {
    const client = new Client(
      {
        name: 'test client',
        version: '1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    const server = createServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    const tools = await client.listTools();
    if (!tools.tools.length) throw new Error('No tools found');
    await client.close();
  });
});

```
