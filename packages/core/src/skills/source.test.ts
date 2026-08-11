import { describe, expect, it, vi } from 'vitest';
import { AgentSession } from '../agent/session.js';
import type { Skill } from './skill.js';
import { inlineSkill } from './skill.js';
import type { SkillLoadFailure, SkillsSource, SkillsSourceContext } from './source.js';
import {
  aggregateSkills,
  cacheSkills,
  deduplicateSkills,
  filterSkills,
  inMemorySkillsSource,
} from './source.js';

function skill(name: string): Skill {
  return inlineSkill({ name, description: `The ${name} skill.`, instructions: 'Do the thing.' });
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

describe('inMemorySkillsSource', () => {
  it('serves the skills it was given and is unaffected by later mutation of the array', async () => {
    const skills = [skill('alpha')];
    const source = inMemorySkillsSource(skills);
    skills.push(skill('beta'));
    expect(names(await source.getSkills(context()))).toEqual(['alpha']);
  });
});

describe('aggregateSkills', () => {
  it('concatenates the sources in declaration order', async () => {
    const source = aggregateSkills([
      inMemorySkillsSource([skill('alpha')]),
      inMemorySkillsSource([skill('beta')]),
    ]);
    expect(names(await source.getSkills(context()))).toEqual(['alpha', 'beta']);
  });

  it('reports a failing source and still serves the others', async () => {
    const failures: SkillLoadFailure[] = [];
    const broken: SkillsSource = {
      getSkills: () => Promise.reject(new Error('server unreachable')),
    };
    const source = aggregateSkills([broken, inMemorySkillsSource([skill('beta')])]);

    const skills = await source.getSkills(context({ reportSkillError: (f) => failures.push(f) }));

    expect(names(skills)).toEqual(['beta']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toMatchObject({ message: 'server unreachable' });
  });

  it('lets an abort through instead of reporting it as a source failure', async () => {
    const controller = new AbortController();
    const failures: SkillLoadFailure[] = [];
    const aborting: SkillsSource = {
      getSkills: () => {
        controller.abort();
        return Promise.reject(new Error('aborted'));
      },
    };
    const source = aggregateSkills([aborting]);

    await expect(
      source.getSkills(context({ signal: controller.signal, reportSkillError: (f) => failures.push(f) })),
    ).rejects.toThrow();
    expect(failures).toEqual([]);
  });
});

describe('filterSkills', () => {
  it('keeps only what the predicate accepts', async () => {
    const source = filterSkills(
      inMemorySkillsSource([skill('public-a'), skill('internal-b')]),
      (candidate) => !candidate.frontmatter.name.startsWith('internal'),
    );
    expect(names(await source.getSkills(context()))).toEqual(['public-a']);
  });
});

describe('deduplicateSkills', () => {
  it('keeps the first of each name, comparing case-insensitively', async () => {
    const dropped: string[] = [];
    const source = deduplicateSkills(
      aggregateSkills([
        inMemorySkillsSource([skill('alpha')]),
        inMemorySkillsSource([skill('alpha'), skill('beta')]),
      ]),
      { onDuplicate: (name) => dropped.push(name) },
    );

    const skills = await source.getSkills(context());

    expect(names(skills)).toEqual(['alpha', 'beta']);
    // The winner is the first occurrence, so ordering the sources decides which one the agent gets.
    expect(await skills[0]?.getContent()).toContain('alpha');
    expect(dropped).toEqual(['alpha']);
  });
});

describe('cacheSkills', () => {
  it('queries the inner source once', async () => {
    const inner = { getSkills: vi.fn(async () => [skill('alpha')]) };
    const source = cacheSkills(inner);

    await source.getSkills(context());
    await source.getSkills(context());

    expect(inner.getSkills).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight load between concurrent runs', async () => {
    let started = 0;
    const source = cacheSkills({
      getSkills: async () => {
        started++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [skill('alpha')];
      },
    });

    await Promise.all([source.getSkills(context()), source.getSkills(context())]);

    expect(started).toBe(1);
  });

  it('does not cache a failure, so the next run retries', async () => {
    let attempt = 0;
    const source = cacheSkills({
      getSkills: async () => {
        attempt++;
        if (attempt === 1) {
          throw new Error('transient');
        }
        return [skill('alpha')];
      },
    });

    await expect(source.getSkills(context())).rejects.toThrow('transient');
    expect(names(await source.getSkills(context()))).toEqual(['alpha']);
  });

  it('re-queries once the refresh interval has passed', async () => {
    vi.useFakeTimers();
    try {
      const inner = { getSkills: vi.fn(async () => [skill('alpha')]) };
      const source = cacheSkills(inner, { refreshIntervalMs: 1000 });

      await source.getSkills(context());
      vi.advanceTimersByTime(999);
      await source.getSkills(context());
      expect(inner.getSkills).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2);
      await source.getSkills(context());
      expect(inner.getSkills).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps partitions apart, so one tenant never sees another tenant lookup', async () => {
    const source = cacheSkills(
      { getSkills: async (ctx) => [skill(`skill-for-${ctx.agent.id}`)] },
      { isolationKey: (ctx) => ctx.agent.id },
    );

    const first = await source.getSkills(context({ agent: { id: 'tenant-a' } }));
    const second = await source.getSkills(context({ agent: { id: 'tenant-b' } }));

    expect(names(first)).toEqual(['skill-for-tenant-a']);
    expect(names(second)).toEqual(['skill-for-tenant-b']);
  });
});
