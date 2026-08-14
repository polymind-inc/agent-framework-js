import { describe, expect, it } from 'vitest';
import { ConfigurationError, ToolInvocationError } from '../errors.js';
import type { Skill, SkillInvocationContext } from './skill.js';
import { inlineSkill, markdownSkill, skillResource, skillScript } from './skill.js';

/** The context a resource or script sees; the provider builds the real one from the tool call. */
function invocation(skill: Skill): SkillInvocationContext {
  return { skill, callId: 'call-1' };
}

describe('skillResource', () => {
  it('returns static content on every read', async () => {
    const resource = skillResource({ name: 'table', content: 'kg=2.205lb' });
    const skill = inlineSkill({ name: 'a', description: 'x', instructions: 'y', resources: [resource] });
    expect(await resource.read(invocation(skill))).toBe('kg=2.205lb');
    expect(await resource.read(invocation(skill))).toBe('kg=2.205lb');
  });

  it('computes a dynamic value per read and receives the invocation context', async () => {
    let reads = 0;
    const seen: string[] = [];
    const resource = skillResource({
      name: 'counter',
      read: (ctx) => {
        seen.push(ctx.callId);
        return ++reads;
      },
    });
    const skill = inlineSkill({ name: 'a', description: 'x', instructions: 'y', resources: [resource] });
    expect(await resource.read(invocation(skill))).toBe(1);
    expect(await resource.read(invocation(skill))).toBe(2);
    expect(seen).toEqual(['call-1', 'call-1']);
  });

  it.each([
    ['neither', {}],
    ['both', { content: 'a', read: () => 'b' }],
  ])('refuses a resource declaring %s of content and read', (_label, extra) => {
    expect(() => skillResource({ name: 'x', ...extra })).toThrow(ConfigurationError);
  });
});

describe('skillScript', () => {
  const convert = skillScript({
    name: 'convert',
    description: 'Multiplies a value',
    parameters: {
      type: 'object',
      properties: { value: { type: 'number' }, factor: { type: 'number' } },
      required: ['value', 'factor'],
    },
    run: (args: Record<string, unknown>) => Number(args.value) * Number(args.factor),
  });

  it('advertises the resolved JSON Schema', () => {
    expect(convert.parametersSchema).toMatchObject({ type: 'object', required: ['value', 'factor'] });
  });

  it('runs with the model-supplied arguments', async () => {
    const skill = inlineSkill({ name: 'a', description: 'x', instructions: 'y', scripts: [convert] });
    expect(await convert.run({ value: 2, factor: 3 }, invocation(skill))).toBe(6);
  });

  it('validates against a Standard Schema and rejects bad arguments as a tool error', async () => {
    const typed = skillScript({
      name: 'greet',
      parameters: {
        '~standard': {
          version: 1 as const,
          vendor: 'test',
          validate: (value: unknown) => {
            const name = (value as { name?: unknown }).name;
            return typeof name === 'string'
              ? { value: { name } }
              : { issues: [{ message: 'name must be a string' }] };
          },
        },
        toJsonSchema: () => ({ type: 'object', properties: { name: { type: 'string' } } }),
      },
      run: (args) => `hello ${args.name}`,
    });
    const skill = inlineSkill({ name: 'a', description: 'x', instructions: 'y', scripts: [typed] });

    expect(await typed.run({ name: 'ada' }, invocation(skill))).toBe('hello ada');
    await expect(typed.run({ name: 7 }, invocation(skill))).rejects.toThrow(ToolInvocationError);
  });

  it('validates raw JSON Schema arguments before running a skill script', async () => {
    let executed = false;
    const raw = skillScript({
      name: 'raw',
      parameters: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
        additionalProperties: false,
      },
      run: () => {
        executed = true;
      },
    });
    const skill = inlineSkill({ name: 'a', description: 'x', instructions: 'y', scripts: [raw] });

    await expect(raw.run({ value: 'not a number' }, invocation(skill))).rejects.toThrow(ToolInvocationError);
    expect(executed).toBe(false);
  });
});

describe('inlineSkill', () => {
  it('synthesizes a body from the instructions and the listings', async () => {
    const skill = inlineSkill({
      name: 'unit-converter',
      description: 'Converts <units> & such',
      instructions: 'Use the table.',
      resources: [skillResource({ name: 'table', description: 'Pairs', content: 'kg=2.205lb' })],
      scripts: [
        skillScript({
          name: 'convert',
          parameters: { type: 'object', properties: { value: { type: 'number' } } },
          run: () => 0,
        }),
      ],
    });

    const content = await skill.getContent();
    expect(content).toContain('<name>unit-converter</name>');
    // Escaped: the description reaches the model inside an element, and a stray angle bracket
    // would otherwise close it.
    expect(content).toContain('<description>Converts &lt;units&gt; &amp; such</description>');
    expect(content).toContain('<instructions>\nUse the table.\n</instructions>');
    expect(content).toContain('<resource name="table" description="Pairs"/>');
    expect(content).toContain('<parameters_schema>{"type":"object"');
  });

  it('emits self-closing listings when there are none, so the model does not invent names', async () => {
    const skill = inlineSkill({ name: 'a', description: 'x', instructions: 'y' });
    const content = await skill.getContent();
    expect(content).toContain('<available_resources />');
    expect(content).toContain('<available_scripts />');
  });

  it('resolves resources and scripts by name, ignoring case', async () => {
    const skill = inlineSkill({
      name: 'a',
      description: 'x',
      instructions: 'y',
      resources: [skillResource({ name: 'Table', content: 'v' })],
      scripts: [skillScript({ name: 'Convert', parameters: { type: 'object' }, run: () => 1 })],
    });
    expect(await skill.getResource?.('table')).toBeDefined();
    expect(await skill.getScript?.('CONVERT')).toBeDefined();
    expect(await skill.getResource?.('missing')).toBeUndefined();
  });

  it('validates the frontmatter at declaration time', () => {
    expect(() => inlineSkill({ name: 'Bad Name', description: 'x', instructions: 'y' })).toThrow(
      ConfigurationError,
    );
  });
});

describe('markdownSkill', () => {
  const document = ['---', 'name: pricing', 'description: How we price.', '---', '# Pricing', 'Body.'].join(
    '\n',
  );

  it('keeps the document verbatim and appends the listings', async () => {
    const skill = markdownSkill({
      markdown: document,
      resources: [skillResource({ name: 'references/table.md', content: '| a | b |' })],
    });

    expect(skill.frontmatter).toEqual({ name: 'pricing', description: 'How we price.' });
    const content = await skill.getContent();
    expect(content.startsWith(document)).toBe(true);
    expect(content).toContain('<resource name="references/table.md"/>');
    expect(content).toContain('<available_scripts />');
  });

  it('resolves a resource by the exact name the listing advertises', async () => {
    const skill = markdownSkill({
      markdown: document,
      resources: [skillResource({ name: 'references/table.md', content: 'rows' })],
    });
    const resource = await skill.getResource?.('references/table.md');
    expect(await resource?.read(invocation(skill))).toBe('rows');
  });

  it('refuses a document with no frontmatter', () => {
    expect(() => markdownSkill({ markdown: '# no frontmatter' })).toThrow(ConfigurationError);
  });
});
