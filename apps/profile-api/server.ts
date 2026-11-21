import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ApiError, createStore, profileSchema, sections, seedRuntime, userId } from './store.ts';
import type { Section } from './store.ts';

async function body(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 262144) throw new ApiError(413, 'Body exceeds 256 KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Invalid JSON'); }
}
function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
export function createProfileApi(root: string, token: string) {
  if (!token) throw new Error('PROFILE_API_TOKEN is required');
  const store = createStore(root);
  return createServer(async (req, res) => {
    try {
      const expected = Buffer.from(`Bearer ${token}`);
      const actual = Buffer.from(req.headers.authorization ?? '');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new ApiError(401, 'Bearer token required');
      const parts = (req.url ?? '').split('?')[0].split('/').filter(Boolean);
      if (parts[0] !== 'users' || parts.length > 3) throw new ApiError(404, 'Route not found');
      if (parts.length === 1) {
        if (req.method === 'GET') return reply(res, 200, { users: await store.list() });
        if (req.method === 'POST') {
          const data = profileSchema.parse(await body(req));
          const id = userId.parse(data.details.id);
          return reply(res, 201, await store.create(id, data));
        }
      } else {
        const id = userId.parse(parts[1]);
        if (parts.length === 2 && req.method === 'GET') {
          const values = await Promise.all(sections.map(async s => [s, await store.read(id, s)]));
          return reply(res, 200, Object.fromEntries(values));
        }
        if (parts.length === 3) {
          if (!sections.includes(parts[2] as Section)) throw new ApiError(404, 'Section not found');
          const section = parts[2] as Section;
          if (req.method === 'GET') return reply(res, 200, await store.read(id, section));
          if (req.method === 'PUT') return reply(res, 200, await store.write(id, section, await body(req)));
        }
      }
      throw new ApiError(405, 'Method not allowed');
    } catch (error) {
      if (error instanceof ApiError) return reply(res, error.status, { error: error.message });
      if (error instanceof z.ZodError) return reply(res, 400, { error: 'Invalid profile data', issues: error.issues });
      reply(res, 500, { error: 'Profile storage failure' });
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.env.PROFILE_DATA_DIR ?? 'data/runtime-users');
  const server = createProfileApi(root, process.env.PROFILE_API_TOKEN ?? '');
  await seedRuntime(resolve('data/users'), root);
  const port = Number(process.env.PORT ?? 3001);
  server.listen(port, '127.0.0.1', () => console.log(`Profile API: http://127.0.0.1:${port}`));
}
