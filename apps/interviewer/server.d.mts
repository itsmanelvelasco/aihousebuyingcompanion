import type { IncomingMessage, ServerResponse } from 'node:http';

export function interviewRequestOrigin(request: IncomingMessage, publicOrigin?: string | null): string | null;
export function handleInterviewRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  trustedOrigin: string | null
): Promise<void>;
