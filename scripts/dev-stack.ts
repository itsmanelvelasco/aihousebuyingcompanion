import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

// One owner for file writes: the bank worker runs inside the profile API.
const profilePort = z.coerce.number().int().min(1).max(65535).parse(process.env.PROFILE_API_PORT ?? 3001);
const appPort = z.coerce.number().int().min(1).max(65535).parse(process.env.APP_PORT ?? 8787);
if (profilePort === appPort) throw new Error('Profile and app ports must differ');
const baseUrl = `http://127.0.0.1:${profilePort}`;
const token = process.env.PROFILE_API_TOKEN || randomUUID();
const children: ChildProcess[] = [];
let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
function launch(file: string, extra: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [resolve(file)], { stdio: 'inherit', env: { ...process.env, ...extra } });
  children.push(child);
  child.on('error', () => shutdown(1));
  child.on('exit', code => { if (!closing) shutdown(code ?? 1); });
  return child;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown());
launch('apps/profile-api/server.ts', { PORT: String(profilePort), PROFILE_API_TOKEN: token, DEMO_BANK_USERS: process.env.DEMO_BANK_USERS ?? 'user-001' });
try {
  let ready = false;
  for (let attempt = 0; attempt < 120 && !closing; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/users`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* wait for initial fixture copy */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Profile API did not become ready');
  const envFile = new URL('../.env', import.meta.url);
  const localVoice = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  launch('demo-plugin/server.ts', {
    PORT: String(appPort), HOST: '127.0.0.1', PROFILE_API_URL: baseUrl, PROFILE_API_TOKEN: token,
    ...(localVoice.OPENAI_API_KEY && { OPENAI_API_KEY: localVoice.OPENAI_API_KEY }),
    ...(localVoice.REALTIME_MODEL && { REALTIME_MODEL: localVoice.REALTIME_MODEL }),
  });
  console.log(`Connected demo: http://127.0.0.1:${appPort}/preview · profile API ${baseUrl}`);
  console.log(`Test the data: http://127.0.0.1:${appPort}/test`);
  console.log('Synthetic background feed enabled for DEMO_BANK_USERS; credentials stay in server process memory. Ctrl+C stops both services.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Stack startup failed'); shutdown(1); }
