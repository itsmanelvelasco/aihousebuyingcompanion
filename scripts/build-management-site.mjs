import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// Self-contained so the generated function has no repository/runtime-data imports.
export async function profileGateway(request) {
  const reply = (status, error) => new Response(JSON.stringify({ error }), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
  const url = new URL(request.url);
  if (['/interviewer/voice', '/interviewer/classify', '/interviewer/scenario'].includes(url.pathname)) {
    return reply(503, 'Hosted voice and classification are unavailable until an authenticated backend adapter is configured.');
  }
  const id = '[a-z0-9][a-z0-9-]{0,63}';
  const routes = [
    ['^/users$', ['GET', 'POST']],
    [`^/users/${id}$`, ['GET']],
    [`^/users/${id}/(?:details|preferences|bank-account)$`, ['GET', 'PUT']],
    [`^/users/${id}/context$`, ['GET']],
    [`^/users/${id}/inputs$`, ['GET', 'POST']],
    [`^/users/${id}/inputs/${id}$`, ['PUT', 'DELETE']],
    [`^/users/${id}/bank/(?:accounts|transactions)$`, ['GET', 'POST']],
    [`^/users/${id}/bank/accounts/${id}$`, ['PUT']],
    [`^/users/${id}/bank/transactions/${id}$`, ['PUT', 'DELETE']],
    [`^/users/${id}/bank/(?:events|summary)$`, ['GET']],
    [`^/users/${id}/bank/runtime$`, ['GET', 'POST']],
    [`^/users/${id}/bank/(?:demo|simulate|runtime/tick)$`, ['POST']]
  ];
  const route = routes.find(([pattern]) => new RegExp(pattern).test(url.pathname));
  if (!route) return reply(404, 'Unknown management API route.');
  if (!route[1].includes(request.method)) return reply(405, 'Method not allowed.');
  if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return reply(403, 'Same-origin requests required.');
  const bearer = request.headers.get('authorization');
  if (!bearer || !/^Bearer [^\s]+$/.test(bearer)) return reply(401, 'Enter your profile API bearer token.');
  let backend;
  try {
    backend = new URL(process.env.PROFILE_API_ORIGIN ?? '');
    if (backend.protocol !== 'https:' || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash
      || ['localhost', '127.0.0.1', '[::1]'].includes(backend.hostname)) throw new Error();
  } catch { return reply(503, 'The persistent profile backend has not been configured.'); }
  const headers = { Authorization: bearer };
  const type = request.headers.get('content-type');
  if (type) headers['Content-Type'] = type;
  let body;
  if (!['GET', 'HEAD'].includes(request.method)) {
    if (request.body && !type?.startsWith('application/json')) return reply(415, 'Expected JSON.');
    const reader = request.body?.getReader();
    const chunks = []; let length = 0;
    try { if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 262144) { await reader.cancel(); return reply(413, 'Request exceeds 256 KiB.'); }
        chunks.push(value);
      }
    } } catch { return reply(400, 'Request body could not be read.'); }
    body = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  }
  try {
    const upstream = await fetch(new URL(url.pathname + url.search, backend), {
      method: request.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(15000)
    });
    if (upstream.status >= 500) return reply(502, 'The profile backend is unavailable.');
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    } });
  } catch { return reply(502, 'The profile backend is unavailable.'); }
}

export async function buildManagementSite(output = resolve('artifacts/team-plugin/netlify')) {
  const files = new Map([
    ['public/index.html', 'apps/profile-api/admin.html'],
    ['public/manage/app.mjs', 'apps/profile-api/admin.mjs'],
    ['public/interviewer/index.html', 'apps/interviewer/index.html'],
    ['public/interviewer/app.mjs', 'apps/interviewer/app.mjs'],
    ['public/interviewer/finances.mjs', 'apps/interviewer/finances.mjs']
  ]);
  const allowed = new Set([...files.keys(), 'functions/profile-api.mjs']);
  // Reject unexpected old output rather than deleting directories or publishing leftovers.
  async function inspect(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (!allowed.has(relative(output, path).replaceAll('\\', '/'))) throw new Error('Unexpected file in deployment output; use a clean output directory.');
    }
  }
  await inspect(output);
  for (const [target, source] of files) {
    const destination = resolve(output, target);
    await mkdir(resolve(destination, '..'), { recursive: true });
    await copyFile(resolve(source), destination);
  }
  const indexPath = resolve(output, 'public/index.html');
  const html = await readFile(indexPath, 'utf8');
  await writeFile(indexPath, html
    .replace('Local development workspace', 'Hosted management workspace')
    .replace('Enter your local API token', 'Enter your profile API token')
    .replace('Voice uses configured OpenAI API credits. Starts only when you press Start.', 'Hosted voice is unavailable. Guided interview works without API credits.'));
  await mkdir(resolve(output, 'functions'), { recursive: true });
  await writeFile(resolve(output, 'functions/profile-api.mjs'),
    `export default ${profileGateway.toString()};\nexport const config = { path: ['/users', '/users/*', '/interviewer/voice', '/interviewer/classify', '/interviewer/scenario'] };\n`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildManagementSite();
  console.log('Built Netlify management assets and restricted API gateway; backend deployment is configured separately.');
}
