import { defaultPorts, envList, envPair, envPort } from '../../packages/config/env.ts';
import { loadData } from '../../packages/places/data.ts';
import { createHttpServer } from './http.ts';
import { loadTownExplorerPage } from './town-explorer.ts';

const host = process.env.HOST ?? '127.0.0.1';
const port = envPort('PORT', defaultPorts.app);
const allowedOrigins = new Set(envList('ALLOWED_ORIGINS'));
const { snapshot, policies, travelEstimates } = loadData();
const bank = envPair('BANK_API_URL', 'BANK_API_TOKEN', 'to enable the synthetic bank bridge');
const bankApi = bank ? { baseUrl: bank[0], token: bank[1] } : undefined;
const server = createHttpServer(snapshot, policies, {
  allowedOrigins,
  bankApi,
  travelEstimates,
  townExplorerPage: loadTownExplorerPage(),
});
server.listen(port, host, () => {
  console.log(`ReloCat MCP listening on http://${host}:${port}/mcp · ${snapshot.version}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => server.close());
}
