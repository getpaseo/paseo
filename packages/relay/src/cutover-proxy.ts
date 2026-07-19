interface CutoverProxy {
  fetch(request: Request): Promise<Response>;
}

export function createCutoverProxy(origin: string): CutoverProxy {
  const originUrl = new URL(origin);

  return {
    async fetch(request: Request): Promise<Response> {
      const upstreamUrl = new URL(request.url);
      upstreamUrl.protocol = originUrl.protocol;
      upstreamUrl.host = originUrl.host;

      return fetch(new Request(upstreamUrl, request));
    },
  };
}
