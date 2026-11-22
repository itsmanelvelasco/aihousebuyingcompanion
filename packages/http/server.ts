import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** An error with an HTTP status that route handlers can throw and servers translate into a JSON reply. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** Read a bounded UTF-8 body as text. */
export async function readText(request: IncomingMessage, maxBytes: number, tooLarge = 'Request body is too large') {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    length += buffer.length;
    if (length > maxBytes) throw new ApiError(413, tooLarge);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Read a bounded JSON body. */
export async function readJson(request: IncomingMessage, maxBytes = 65_536, tooLarge?: string): Promise<unknown> {
  const text = await readText(request, maxBytes, tooLarge);
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Invalid JSON');
  }
}

export function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, jsonHeaders).end(JSON.stringify(value));
}

export function sendText(response: ServerResponse, status: number, body: string, type = 'text/plain') {
  response
    .writeHead(status, {
      'Content-Type': `${type}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    .end(body);
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function requireBearer(request: IncomingMessage, token: string) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.authorization ?? '');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ApiError(401, 'Bearer token required');
  }
}

/** Path segments without the query string. */
export function pathParts(request: IncomingMessage) {
  return (request.url ?? '').split('?')[0].split('/').filter(Boolean);
}
