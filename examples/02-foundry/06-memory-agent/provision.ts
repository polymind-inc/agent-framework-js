/**
 * Provisions the memory store the agent in `main.ts` reads and writes.
 *
 * Safe to re-run: an existing store of the same name is left alone. Your identity needs
 * **Azure AI User** on the Foundry project.
 *
 *   pnpm --filter example-02-foundry memory:provision
 *
 * Pass `--reset <user-id>` to also erase everything stored for one user, which is how you get a
 * clean slate while trying the sample out.
 */

import { FoundryMemoryProvider } from '@polymind-inc/agent-framework/foundry';

const projectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
if (projectEndpoint === undefined) {
  throw new Error('Set FOUNDRY_PROJECT_ENDPOINT to your Foundry project endpoint.');
}
const memoryStoreName = process.env.MEMORY_STORE_NAME;
if (memoryStoreName === undefined) {
  throw new Error('Set MEMORY_STORE_NAME to the memory store to provision.');
}

// The scope is irrelevant to provisioning — no run happens here — but it is a required part of the
// provider's contract, so the script names the user it may also be asked to reset.
const resetUser = process.argv[process.argv.indexOf('--reset') + 1];
const memory = new FoundryMemoryProvider({
  projectEndpoint,
  memoryStoreName,
  scope: resetUser ?? 'provisioning',
});

const created = await memory.ensureMemoryStoreCreated(
  {
    kind: 'default',
    chat_model: process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME ?? 'gpt-4o-mini',
    embedding_model: process.env.AZURE_AI_EMBEDDING_MODEL_DEPLOYMENT_NAME ?? 'text-embedding-3-small',
    options: {
      // Durable facts about the user are the point of this sample; per-conversation summaries are
      // not, and the transcript already covers them.
      user_profile_enabled: true,
      user_profile_details:
        'Preferences and stable facts only. Avoid sensitive data such as age, finances, precise ' +
        'location and credentials.',
      chat_summary_enabled: false,
    },
  },
  { description: 'Memory store for the agent-framework-js hosted memory sample' },
);

console.log(
  created
    ? `Created memory store '${memoryStoreName}'.`
    : `Memory store '${memoryStoreName}' already exists; left as-is.`,
);

if (process.argv.includes('--reset')) {
  if (resetUser === undefined) {
    throw new Error('--reset needs the user id whose memories should be erased.');
  }
  const erased = await memory.deleteStoredMemories(resetUser);
  console.log(erased ? `Erased the memories of '${resetUser}'.` : `'${resetUser}' had no memories.`);
}
