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

/** Escape text for an HTML element or a quoted attribute. Every value a page prints goes through this. */
export function escapeHtml(value: unknown) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string,
  );
}

/** Cookies of a request by name. A malformed pair is skipped; the first value of a repeated name wins. */
export function parseCookies(request: IncomingMessage) {
  const cookies: Record<string, string> = {};
  for (const pair of (request.headers.cookie ?? '').split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    const name = pair.slice(0, index).trim();
    if (name in cookies) continue;
    try {
      cookies[name] = decodeURIComponent(pair.slice(index + 1).trim());
    } catch {
      // An undecodable value is not a cookie this server set.
    }
  }
  return cookies;
}

export type CookieOptions = {
  /** Seconds until the browser drops it; 0 deletes it. Omitted: a session cookie. */
  maxAgeSeconds?: number;
  /** Send only over HTTPS. Set whenever the request arrived over HTTPS. */
  secure: boolean;
  path?: string;
  sameSite?: 'Lax' | 'Strict';
};

/** One `Set-Cookie` value. Always HttpOnly: no cookie of this server is for scripts to read. */
export function serializeCookie(name: string, value: string, options: CookieOptions) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`, 'HttpOnly'];
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure) parts.push('Secure');
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.trunc(options.maxAgeSeconds))}`);
  return parts.join('; ');
}

/** Read a bounded `application/x-www-form-urlencoded` body. Another content type is refused with 415. */
export async function readForm(request: IncomingMessage, maxBytes = 16_384) {
  if (!String(request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded'))
    throw new ApiError(415, 'Expected a form body');
  const fields: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(await readText(request, maxBytes))) {
    if (!(name in fields)) fields[name] = value;
  }
  return fields;
}

/**
 * Headers of a server-rendered page: no scripts at all, styles only inline, no framing, no referrer,
 * and forms that post only to this origin. `formAction` adds origins a form may redirect to, which
 * the OAuth consent page needs for the client's redirect URI.
 */
export function pageHeaders(formAction: string[] = []) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      'img-src data:',
      'font-src data:',
      "base-uri 'none'",
      "frame-ancestors 'none'",
      `form-action 'self'${formAction.map(origin => ` ${origin}`).join('')}`,
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}

export function sendHtml(response: ServerResponse, status: number, html: string, formAction: string[] = []) {
  response.writeHead(status, pageHeaders(formAction)).end(html);
}

/** A redirect that is never cached. `location` must be built by the server, never copied from a request. */
export function redirect(response: ServerResponse, location: string, status = 303) {
  response
    .writeHead(status, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    .end();
}

/** The bearer token of a request, or undefined when the header is absent or of another scheme. */
export function bearerToken(request: IncomingMessage) {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(request.headers.authorization ?? '');
  return match?.[1];
}

/**
 * Who an `/api` request acts for. `admin` is the operator's service token and may touch any user;
 * a person's credential may only touch `/users/<its own id>/…`, and writes need `write`.
 */
export type ApiAccess =
  | 'admin'
  | {
      userId: string;
      /** May save answers and habits (`person:write`, or a session with its CSRF token). */
      write: boolean;
      /** May read (`person:read`). Absent means yes, as every credential could before scopes for reads existed. */
      read?: boolean;
      /** May connect banks, sync, import statements and correct movements (`bank:manage`). */
      bank?: boolean;
    };

/** Resolves a person's credential (OAuth token or session). Returns null when the request carries none. */
export type ApiAuthorizer = (request: IncomingMessage) => ApiAccess | null;

/**
 * The access of an `/api` request: the admin bearer token, or whatever `authorize` recognises.
 * Throws 401 when there is no valid credential.
 */
export function apiAccess(request: IncomingMessage, adminToken: string, authorize?: ApiAuthorizer): ApiAccess {
  const expected = Buffer.from(`Bearer ${adminToken}`);
  const actual = Buffer.from(request.headers.authorization ?? '');
  if (expected.length === actual.length && timingSafeEqual(expected, actual)) return 'admin';
  const access = authorize?.(request) ?? null;
  if (!access) throw new ApiError(401, 'Bearer token required');
  return access;
}

/**
 * Enforce the user scope: a person's credential reaches only its own `/users/<id>/…` routes, and
 * only the writes `mayWrite` allows. Anything else is 403, whether or not the other id exists.
 */
export function requireOwnRoute(
  access: ApiAccess,
  request: IncomingMessage,
  parts: string[],
  mayWrite: (parts: string[], method: string) => boolean | 'bank',
) {
  if (access === 'admin') return;
  if (parts[0] !== 'users' || parts[1] !== access.userId) throw new ApiError(403, 'Forbidden');
  if (request.method === 'GET' || request.method === 'HEAD') {
    if (access.read === false) throw new ApiError(403, 'Forbidden');
    return;
  }
  // `true` is a write of answers or habits; `'bank'` is a change to the person's own bank data.
  const needs = mayWrite(parts, request.method ?? '');
  if (needs === false || (needs === 'bank' ? access.bank !== true : !access.write))
    throw new ApiError(403, 'Forbidden');
}

/** One part of a `multipart/form-data` body: a form field, or a file with its name. */
export type FormPart = { name: string; filename?: string; value: string };

/**
 * Read a bounded `multipart/form-data` body (a form with a file field) as text parts. Only what a
 * plain HTML form sends is understood: parts separated by the boundary, each with a
 * `Content-Disposition: form-data; name="..."[; filename="..."]` header. Anything else is refused.
 */
export async function readMultipart(request: IncomingMessage, maxBytes: number, tooLarge?: string) {
  const type = String(request.headers['content-type'] ?? '');
  const boundary = /^multipart\/form-data;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(type);
  if (!boundary) throw new ApiError(415, 'Expected a form with a file');
  const text = await readText(request, maxBytes, tooLarge);
  const parts: FormPart[] = [];
  for (const chunk of text.split(`--${boundary[1] ?? boundary[2]}`).slice(1)) {
    if (chunk.startsWith('--')) break;
    const split = chunk.indexOf('\r\n\r\n');
    if (split < 0) throw new ApiError(400, 'Malformed form body');
    const disposition = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(chunk.slice(0, split));
    const name = disposition && /(?:^|;)\s*name="([^"]*)"/.exec(disposition[1]);
    if (!name) throw new ApiError(400, 'Malformed form body');
    const filename = /(?:^|;)\s*filename="([^"]*)"/.exec(disposition[1])?.[1];
    // The part ends with the line break that precedes the next boundary.
    parts.push({ name: name[1], filename, value: chunk.slice(split + 4).replace(/\r\n$/, '') });
    if (parts.length > 20) throw new ApiError(400, 'Too many form fields');
  }
  return parts;
}
