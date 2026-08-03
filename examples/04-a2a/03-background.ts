/**
 * 03 — Long-running work: leave it running, come back for it.
 *
 * With `allowBackgroundResponses` the agent returns as soon as the remote side accepts the work,
 * handing back a `continuationToken`. Passing that token to a later run picks the same task back
 * up — awaited it reads the task once, iterated it re-subscribes to the live stream, and a task
 * that finished while nobody was listening still comes back with its result.
 *
 * Start the local agent first, then run:
 * `pnpm --filter example-04-a2a background`
 */
import { A2AAgent } from '@polymind-inc/agent-framework-a2a';

const agent = await A2AAgent.fromUrl(process.env.A2A_AGENT_URL ?? 'http://localhost:4100');

// A background run needs an explicit session: the token has to have somewhere to resume into.
const session = agent.createSession();
const accepted = await agent.run('Was invoice 42 paid?', {
  session,
  allowBackgroundResponses: true,
});

let token = accepted.continuationToken;
if (token === undefined) {
  // Fast agents finish inside the first call; there is nothing to resume.
  console.log('answered immediately:', accepted.text);
} else {
  console.log('accepted, token:', JSON.stringify(token));

  // A token is JSON: persist it, and resume in another process or after a restart.
  const restored = agent.deserializeSession(JSON.parse(JSON.stringify(session)));
  token = JSON.parse(JSON.stringify(token)) as typeof token;

  for (let attempt = 1; ; attempt++) {
    const resumed = await agent.run(undefined, { session: restored, continuationToken: token });
    if (resumed.continuationToken === undefined) {
      console.log(`finished after ${attempt} check(s):`, resumed.text);
      break;
    }
    token = resumed.continuationToken;
    console.log(`still working (check ${attempt})…`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// Iterating a resumed run re-subscribes instead, so the remaining updates arrive as they happen.
const live = agent.createSession();
const started = await agent.run('Was invoice 7 paid?', { session: live, allowBackgroundResponses: true });
if (started.continuationToken !== undefined) {
  process.stdout.write('re-subscribed: ');
  const stream = agent.run(undefined, { session: live, continuationToken: started.continuationToken });
  for await (const update of stream) {
    process.stdout.write(update.text);
  }
  console.log();
}
