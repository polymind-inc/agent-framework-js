/**
 * 04 — Talking to an agent that requires credentials.
 *
 * Authentication belongs to the A2A client, not to the framework: build the client with a `fetch`
 * that carries your credentials, then hand it to `new A2AAgent({ client })`. Nothing else about the
 * agent changes — runs, sessions and tokens work exactly as in the other examples.
 *
 * Two recipes, both run against the local agent:
 *
 * 1. a static token, which covers API keys and service credentials;
 * 2. a token that can expire, refreshed on a 401 and retried once.
 *
 * The card is fetched with the same credentials, because a protected agent usually protects its
 * card too.
 *
 * Start the local agent with a token, then run this:
 * `A2A_TOKEN=invoice-secret pnpm --filter example-04-a2a server`
 * `A2A_TOKEN=invoice-secret pnpm --filter example-04-a2a authentication`
 */
import {
  type AuthenticationHandler,
  ClientFactory,
  ClientFactoryOptions,
  createAuthenticatingFetchWithRetry,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from '@a2a-js/sdk/client';
import { A2AAgent } from '@polymind-inc/agent-framework-a2a';

const url = process.env.A2A_AGENT_URL ?? 'http://localhost:4100';
const token = process.env.A2A_TOKEN ?? 'invoice-secret';

/**
 * Builds an agent whose card lookup and every later request go through `fetchImpl`.
 *
 * The card is resolved first so the agent can take its name and description from it, then the
 * client is built for that card with the same transport factories the SDK uses by default — only
 * with your `fetch` underneath.
 */
async function connect(fetchImpl: typeof fetch): Promise<A2AAgent> {
  const agentCard = await new DefaultAgentCardResolver({ fetchImpl }).resolve(url);
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl }), new RestTransportFactory({ fetchImpl })],
    }),
  );
  return new A2AAgent({ client: await factory.createFromAgentCard(agentCard), agentCard });
}

// ---------------------------------------------------------------------------
// 1. A static credential: one header on every request.
// ---------------------------------------------------------------------------

function bearerFetch(bearer: string): typeof fetch {
  return (input, init) =>
    fetch(input, { ...init, headers: { ...init?.headers, authorization: `Bearer ${bearer}` } });
}

const agent = await connect(bearerFetch(token));
console.log(`Connected to "${agent.name}" with a static token`);
console.log('answer:', (await agent.run('Was invoice 42 paid?')).text);

// ---------------------------------------------------------------------------
// 2. A credential that expires: refresh on 401 and retry.
// ---------------------------------------------------------------------------

// Stands in for a token store. It starts out holding a stale token, so the first request really is
// rejected and the refresh path really runs.
let cached = 'expired-token';
let refreshes = 0;
const fetchToken = async (): Promise<string> => {
  refreshes += 1;
  return token;
};

const handler: AuthenticationHandler = {
  headers: async () => ({ authorization: `Bearer ${cached}` }),
  // Called for every response. Returning headers retries the request once with them; returning
  // `undefined` lets the response through as it is.
  shouldRetryWithHeaders: async (_request, response) =>
    response.status === 401 ? { authorization: `Bearer ${await fetchToken()}` } : undefined,
  // The retry worked, so keep what worked instead of refreshing again on the next call.
  onSuccessfulRetry: async (headers) => {
    cached = headers['authorization']?.replace('Bearer ', '') ?? cached;
  },
};

const refreshing = await connect(createAuthenticatingFetchWithRetry(fetch, handler));
console.log(`\nConnected to "${refreshing.name}" after refreshing an expired token`);

const session = refreshing.createSession();
console.log('answer:', (await refreshing.run('Was invoice 7 paid?', { session })).text);
// The refreshed token is reused, so a second turn does not pay for another round trip.
console.log('answer:', (await refreshing.run('And invoice 8?', { session })).text);
console.log(`token refreshed ${refreshes} time(s) for 3 requests`);
