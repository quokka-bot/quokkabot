import type { FastifyRequest } from "fastify";

export function redactRequestUrl(url: string): string {
  const index = url.indexOf("?");
  if (index < 0) return url;
  const path = url.slice(0, index);
  const query = new URLSearchParams(url.slice(index + 1));
  const callback = path === "/api/connect/google/callback";
  const imageUpload = /^\/api\/agents\/[^/]+\/attachments$/.test(path);
  // Rebuild entries individually so duplicate and percent-encoded names receive the same treatment.
  const redacted = new URLSearchParams();
  for (const [key, value] of query) {
    redacted.append(key, callback || (imageUpload && key.toLowerCase() === "name") || ["code", "state", "token", "ticket"].includes(key.toLowerCase()) ? "[redacted]" : value);
  }
  return `${path}?${redacted}`;
}

export function serializeRequest(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactRequestUrl(request.url),
    hostname: request.hostname,
    remoteAddress: request.ip,
    remotePort: request.raw.socket?.remotePort,
  };
}
