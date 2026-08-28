import type { ReadResourceResult } from '@modelcontextprotocol/client';
import type { Skill, SkillLoadFailure, SkillsSourceContext } from '@polymind-inc/agent-framework-core';
import { AgentSession } from '@polymind-inc/agent-framework-core';
import { describe, expect, it } from 'vitest';
import { McpConnection } from './connection.js';
import type { McpResourceReader } from './skills.js';
import { mcpSkillsSource } from './skills.js';
import type { TestResource } from './test-server.js';
import { TestMcpServer } from './test-server.js';

const INDEX_URI = 'skill://index.json';

const SKILL_MD = [
  '---',
  'name: unit-converter',
  'description: Converts between common units.',
  '---',
  '## Usage',
  '',
  'See references/units-table.md.',
].join('\n');

function indexOf(...entries: Array<Record<string, unknown>>): TestResource {
  return {
    uri: INDEX_URI,
    mimeType: 'application/json',
    text: JSON.stringify({
      $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
      skills: entries,
    }),
  };
}

const unitConverterEntry = {
  name: 'unit-converter',
  type: 'skill-md',
  description: 'Converts between common units.',
  url: 'skill://unit-converter/SKILL.md',
};

function serverWith(resources: TestResource[]): { server: TestMcpServer; connection: McpConnection } {
  const server = new TestMcpServer([], { resources });
  return { server, connection: new McpConnection({ transport: () => server }) };
}

function context(overrides: Partial<SkillsSourceContext> = {}): SkillsSourceContext {
  return {
    agent: { id: 'agent-1' },
    session: new AgentSession(),
    reportSkillError: () => {},
    ...overrides,
  };
}

const names = (skills: readonly Skill[]): string[] => skills.map((s) => s.frontmatter.name);

describe('discovery', () => {
  it('builds one skill per skill-md entry without reading any of their bodies', async () => {
    const { server, connection } = serverWith([
      indexOf(unitConverterEntry, {
        name: 'currency-converter',
        type: 'skill-md',
        description: 'Converts currencies.',
        url: 'skill://currency-converter/SKILL.md',
      }),
    ]);

    const skills = await mcpSkillsSource(connection).getSkills(context());

    expect(names(skills)).toEqual(['unit-converter', 'currency-converter']);
    // Discovery is one round trip: the catalogue. Bodies are fetched only when loaded.
    expect(server.reads).toEqual([INDEX_URI]);
    await connection.close();
  });

  it('serves no skills when the server publishes no index', async () => {
    const { connection } = serverWith([]);
    expect(await mcpSkillsSource(connection).getSkills(context())).toEqual([]);
    await connection.close();
  });

  it('serves no skills when the index is empty or unparseable, reporting the parse failure', async () => {
    const failures: SkillLoadFailure[] = [];
    const { connection } = serverWith([{ uri: INDEX_URI, text: 'not json' }]);

    const skills = await mcpSkillsSource(connection).getSkills(
      context({ reportSkillError: (failure) => failures.push(failure) }),
    );

    expect(skills).toEqual([]);
    expect(failures).toHaveLength(1);
    await connection.close();
  });

  it('reports an index whose root is a JSON array as invalid, like any non-object', async () => {
    const failures: SkillLoadFailure[] = [];
    const { connection } = serverWith([{ uri: INDEX_URI, text: '[]' }]);

    const skills = await mcpSkillsSource(connection).getSkills(
      context({ reportSkillError: (failure) => failures.push(failure) }),
    );

    expect(skills).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(String(failures[0]?.error)).toContain('must contain a JSON object');
    await connection.close();
  });

  it('surfaces a real failure instead of reading it as "no skills"', async () => {
    // An authorization rejection must not look the same as an empty catalogue: an agent that
    // silently lost its skills is worse than one that says why.
    const server = new TestMcpServer([], { resources: [{ uri: 'skill://other', text: 'x' }] });
    const original = server.send.bind(server);
    server.send = async (message: unknown): Promise<void> => {
      const request = message as { id?: number; method?: string };
      if (request.method === 'resources/read') {
        queueMicrotask(() =>
          server.onmessage?.({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32000, message: 'unauthorized' },
          }),
        );
        return;
      }
      await original(message);
    };
    const connection = new McpConnection({ transport: () => server });

    await expect(mcpSkillsSource(connection).getSkills(context())).rejects.toThrow(/unauthorized/);
    await connection.close();
  });

  it.each([
    ['an unsupported type', { name: 'bundled', type: 'archive', description: 'x', url: 'skill://b.zip' }],
    ['no url', { name: 'nameless', type: 'skill-md', description: 'x' }],
    ['no description', { name: 'terse', type: 'skill-md', url: 'skill://terse/SKILL.md' }],
    [
      'a name the specification rejects',
      { name: 'Bad Name', type: 'skill-md', description: 'x', url: 'skill://b/SKILL.md' },
    ],
  ])('skips an entry with %s and names it in the failure it reports', async (_label, bad) => {
    const failures: SkillLoadFailure[] = [];
    const { connection } = serverWith([indexOf(bad, unitConverterEntry)]);

    const skills = await mcpSkillsSource(connection).getSkills(
      context({ reportSkillError: (failure) => failures.push(failure) }),
    );

    // The healthy entry survives: one unusable skill does not take the catalogue down with it.
    expect(names(skills)).toEqual(['unit-converter']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.skill).toBe(bad.name);
    await connection.close();
  });
});

describe('loading', () => {
  it('fetches the body on demand and reuses it afterwards', async () => {
    const { server, connection } = serverWith([
      indexOf(unitConverterEntry),
      { uri: 'skill://unit-converter/SKILL.md', text: SKILL_MD },
    ]);

    const [skill] = await mcpSkillsSource(connection).getSkills(context());

    expect(await skill?.getContent()).toContain('See references/units-table.md.');
    expect(await skill?.getContent()).toContain('## Usage');
    expect(server.reads.filter((uri) => uri.endsWith('SKILL.md'))).toHaveLength(1);
    await connection.close();
  });

  it('resolves a resource against the skill root', async () => {
    const { server, connection } = serverWith([
      indexOf(unitConverterEntry),
      { uri: 'skill://unit-converter/references/units-table.md', text: '| miles | km |' },
    ]);

    const [skill] = await mcpSkillsSource(connection).getSkills(context());
    const resource = await skill?.getResource?.('references/units-table.md');

    expect(server.reads).toContain('skill://unit-converter/references/units-table.md');
    expect(await resource?.read({ skill: skill as Skill, callId: 'c1' })).toBe('| miles | km |');
    await connection.close();
  });

  it('returns a binary resource as data content rather than a base64 string', async () => {
    const { connection } = serverWith([
      indexOf(unitConverterEntry),
      { uri: 'skill://unit-converter/chart.png', blob: 'aGk=', mimeType: 'image/png' },
    ]);

    const [skill] = await mcpSkillsSource(connection).getSkills(context());
    const resource = await skill?.getResource?.('chart.png');

    expect(await resource?.read({ skill: skill as Skill, callId: 'c1' })).toEqual([
      { type: 'data', uri: 'data:image/png;base64,aGk=', mediaType: 'image/png' },
    ]);
    await connection.close();
  });

  it('answers a missing resource with nothing, so the provider can tell the model it does not exist', async () => {
    const { connection } = serverWith([indexOf(unitConverterEntry)]);
    const [skill] = await mcpSkillsSource(connection).getSkills(context());
    expect(await skill?.getResource?.('nope.md')).toBeUndefined();
    await connection.close();
  });

  it.each([
    ['/etc/passwd'],
    ['../../secrets.md'],
    ['file:///etc/passwd'],
    ['..\\..\\secrets.md'],
    ['%2e%2e/secrets.md'],
    ['nested/%252e%252e/secrets.md'],
  ])('refuses the resource name %j without asking the server', async (name) => {
    const { server, connection } = serverWith([indexOf(unitConverterEntry)]);
    const [skill] = await mcpSkillsSource(connection).getSkills(context());

    expect(await skill?.getResource?.(name)).toBeUndefined();
    expect(server.reads).toEqual([INDEX_URI]);
    await connection.close();
  });

  it('fetches a resource whose listed name contains a literal percent-escape at that exact uri', async () => {
    // The traversal check decodes the name to inspect it, but the name the server listed is the
    // name it serves: the request must go out undecoded.
    const { server, connection } = serverWith([
      indexOf(unitConverterEntry),
      { uri: 'skill://unit-converter/references/a%20b.md', text: '| miles | km |' },
    ]);

    const [skill] = await mcpSkillsSource(connection).getSkills(context());
    const resource = await skill?.getResource?.('references/a%20b.md');

    expect(server.reads).toContain('skill://unit-converter/references/a%20b.md');
    expect(await resource?.read({ skill: skill as Skill, callId: 'c1' })).toBe('| miles | km |');
    await connection.close();
  });

  it.each([['100%.md'], ['50%_off.md']])(
    'accepts the name %j, whose bare percent is not a valid escape, and fetches it literally',
    async (name) => {
      // A segment that decodeURIComponent refuses cannot be decoded by anything downstream either,
      // so it is not an encoding attack — the name goes through as-is.
      const { server, connection } = serverWith([
        indexOf(unitConverterEntry),
        { uri: `skill://unit-converter/${name}`, text: 'plain' },
      ]);

      const [skill] = await mcpSkillsSource(connection).getSkills(context());
      const resource = await skill?.getResource?.(name);

      expect(server.reads).toContain(`skill://unit-converter/${name}`);
      expect(await resource?.read({ skill: skill as Skill, callId: 'c1' })).toBe('plain');
      await connection.close();
    },
  );

  it('forwards the abort signal to the SKILL.md and resource reads', async () => {
    const seen: Array<{ uri: string; signal: AbortSignal | undefined }> = [];
    const reader: McpResourceReader = {
      readResource: async (uri, options): Promise<ReadResourceResult> => {
        seen.push({ uri, signal: options?.signal });
        if (uri === INDEX_URI) {
          return { contents: [{ uri, text: JSON.stringify({ skills: [unitConverterEntry] }) }] };
        }
        return { contents: [{ uri, text: 'content' }] };
      },
    };
    const controller = new AbortController();

    const [skill] = await mcpSkillsSource(reader).getSkills(context());
    await skill?.getContent({ signal: controller.signal });
    await skill?.getResource?.('notes.md', { signal: controller.signal });

    const forwarded = seen.filter((request) => request.uri !== INDEX_URI);
    expect(forwarded).toHaveLength(2);
    expect(forwarded.map((request) => request.signal)).toEqual([controller.signal, controller.signal]);
  });

  it('treats a url that is not a SKILL.md as the skill namespace itself', async () => {
    const { server, connection } = serverWith([
      indexOf({ ...unitConverterEntry, url: 'skill://unit-converter' }),
      { uri: 'skill://unit-converter/notes.md', text: 'notes' },
    ]);

    const [skill] = await mcpSkillsSource(connection).getSkills(context());
    await skill?.getResource?.('notes.md');

    expect(server.reads).toContain('skill://unit-converter/notes.md');
    await connection.close();
  });
});

describe('resource content mapping', () => {
  /** A source over a reader whose non-index reads answer with `result`. */
  async function readMapped(result: ReadResourceResult): Promise<unknown> {
    const reader: McpResourceReader = {
      readResource: async (uri): Promise<ReadResourceResult> =>
        uri === INDEX_URI
          ? { contents: [{ uri, text: JSON.stringify({ skills: [unitConverterEntry] }) }] }
          : result,
    };
    const [skill] = await mcpSkillsSource(reader).getSkills(context());
    const resource = await skill?.getResource?.('asset');
    return await resource?.read({ skill: skill as Skill, callId: 'c1' });
  }

  it('returns joined text when the result carries only text blocks', async () => {
    expect(
      await readMapped({
        contents: [
          { uri: 'skill://u/asset', text: 'a' },
          { uri: 'skill://u/asset', text: 'b' },
        ],
      }),
    ).toBe('a\nb');
  });

  it('prefers the first binary block of a mixed result, as the reference implementations do', async () => {
    // Both reference implementations answer with the first blob and drop the text when a result
    // mixes the two; text wins only when there is no binary content at all.
    expect(
      await readMapped({
        contents: [
          { uri: 'skill://u/asset', text: 'caption' },
          { uri: 'skill://u/asset', blob: 'aGk=', mimeType: 'image/png' },
          { uri: 'skill://u/asset', blob: 'bGk=', mimeType: 'image/jpeg' },
        ],
      }),
    ).toEqual([{ type: 'data', uri: 'data:image/png;base64,aGk=', mediaType: 'image/png' }]);
  });

  it('keeps the MIME type of a data-URI blob whose mimeType field is missing', async () => {
    expect(
      await readMapped({ contents: [{ uri: 'skill://u/asset', blob: 'data:image/png;base64,aGk=' }] }),
    ).toEqual([{ type: 'data', uri: 'data:image/png;base64,aGk=', mediaType: 'image/png' }]);
  });

  it('lets an explicit mimeType field win over the MIME type inside a data-URI blob', async () => {
    expect(
      await readMapped({
        contents: [{ uri: 'skill://u/asset', blob: 'data:image/png;base64,aGk=', mimeType: 'image/webp' }],
      }),
    ).toEqual([{ type: 'data', uri: 'data:image/webp;base64,aGk=', mediaType: 'image/webp' }]);
  });

  it('answers an empty result with null, as the reference implementations do', async () => {
    expect(await readMapped({ contents: [] })).toBeNull();
  });
});

describe('configuration', () => {
  it('reads a caller-chosen index uri', async () => {
    const { server, connection } = serverWith([
      { ...indexOf(unitConverterEntry), uri: 'skill://catalogue.json' },
    ]);

    const skills = await mcpSkillsSource(connection, { indexUri: 'skill://catalogue.json' }).getSkills(
      context(),
    );

    expect(names(skills)).toEqual(['unit-converter']);
    expect(server.reads).toEqual(['skill://catalogue.json']);
    await connection.close();
  });

  it('labels its failures with the configured origin', async () => {
    const failures: SkillLoadFailure[] = [];
    const { connection } = serverWith([
      indexOf({ name: 'bundled', type: 'archive', description: 'x', url: 'skill://b.zip' }),
    ]);

    await mcpSkillsSource(connection, { origin: 'support toolbox' }).getSkills(
      context({ reportSkillError: (failure) => failures.push(failure) }),
    );

    expect(failures[0]?.origin).toBe('support toolbox');
    await connection.close();
  });
});
