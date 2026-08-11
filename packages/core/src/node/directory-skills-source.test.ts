import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSession } from '../agent/session.js';
import type { SkillLoadFailure, SkillsSourceContext } from '../skills/source.js';
import { cacheSkills } from '../skills/source.js';
import { directorySkillsSource } from './directory-skills-source.js';

let root: string;
const failures: SkillLoadFailure[] = [];

function context(): SkillsSourceContext {
  return {
    agent: { id: 'agent-1' },
    session: new AgentSession(),
    reportSkillError: (failure) => {
      failures.push(failure);
    },
  };
}

async function writeSkill(directory: string, name: string, body = 'Do the thing.'): Promise<string> {
  const path = join(root, directory);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Does ${name} things.\n---\n\n${body}\n`,
    'utf8',
  );
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'af-dir-skills-'));
  failures.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('directorySkillsSource', () => {
  it('loads a skill from a directory holding a SKILL.md', async () => {
    const path = await writeSkill('summarize', 'summarize');

    const skills = await directorySkillsSource({ paths: [path] }).getSkills(context());

    expect(skills).toHaveLength(1);
    expect(skills[0]?.frontmatter).toMatchObject({
      name: 'summarize',
      description: 'Does summarize things.',
    });
    expect(await skills[0]?.getContent()).toContain('Do the thing.');
  });

  it('loads every skill directory under a parent', async () => {
    await writeSkill('skills/summarize', 'summarize');
    await writeSkill('skills/report', 'report');
    await mkdir(join(root, 'skills/not-a-skill'), { recursive: true });

    const skills = await directorySkillsSource({ paths: [join(root, 'skills')] }).getSkills(context());

    expect(skills.map((skill) => skill.frontmatter.name).sort()).toEqual(['report', 'summarize']);
  });

  it('serves sibling files as resources named by their relative path', async () => {
    const path = await writeSkill('summarize', 'summarize');
    await writeFile(join(path, 'style-guide.md'), 'Be brief.', 'utf8');
    await mkdir(join(path, 'references'), { recursive: true });
    await writeFile(join(path, 'references/pricing.csv'), 'plan,price', 'utf8');

    const [skill] = await directorySkillsSource({ paths: [path] }).getSkills(context());
    const content = await skill?.getContent();

    expect(content).toContain('<resource name="style-guide.md"/>');
    expect(content).toContain('<resource name="references/pricing.csv"/>');
    const resource = await skill?.getResource?.('references/pricing.csv');
    expect(await resource?.read({ skill: skill!, callId: 'c1' })).toBe('plan,price');
  });

  it('leaves files outside the resource extensions alone', async () => {
    const path = await writeSkill('summarize', 'summarize');
    await writeFile(join(path, 'notes.md'), 'kept', 'utf8');
    await writeFile(join(path, 'binary.bin'), 'skipped', 'utf8');

    const [skill] = await directorySkillsSource({ paths: [path] }).getSkills(context());

    expect(await skill?.getResource?.('notes.md')).toBeDefined();
    expect(await skill?.getResource?.('binary.bin')).toBeUndefined();
  });

  it('stops at the configured depth', async () => {
    const path = await writeSkill('summarize', 'summarize');
    await mkdir(join(path, 'a/b'), { recursive: true });
    await writeFile(join(path, 'a/near.md'), 'near', 'utf8');
    await writeFile(join(path, 'a/b/far.md'), 'far', 'utf8');

    const [shallow] = await directorySkillsSource({ paths: [path], searchDepth: 1 }).getSkills(context());
    expect(await shallow?.getResource?.('a/near.md')).toBeUndefined();

    const [deep] = await directorySkillsSource({ paths: [path], searchDepth: 3 }).getSkills(context());
    expect(await deep?.getResource?.('a/b/far.md')).toBeDefined();
  });

  it('applies the resource filter', async () => {
    const path = await writeSkill('summarize', 'summarize');
    await writeFile(join(path, 'keep.md'), 'keep', 'utf8');
    await writeFile(join(path, 'drop.md'), 'drop', 'utf8');

    const [skill] = await directorySkillsSource({
      paths: [path],
      resourceFilter: (_name, relativePath) => relativePath !== 'drop.md',
    }).getSkills(context());

    expect(await skill?.getResource?.('keep.md')).toBeDefined();
    expect(await skill?.getResource?.('drop.md')).toBeUndefined();
  });

  describe('scope', () => {
    it('refuses a resource name that climbs out of the skill directory', async () => {
      const path = await writeSkill('summarize', 'summarize');
      await writeFile(join(root, 'secret.md'), 'top secret', 'utf8');
      await writeFile(join(path, 'public.md'), 'fine', 'utf8');

      const [skill] = await directorySkillsSource({ paths: [path] }).getSkills(context());

      // Resources are served by name from what discovery found, so a name that climbs out of the
      // directory resolves to nothing — there is no path for it to be joined onto.
      for (const name of ['../secret.md', '../../secret.md', join(root, 'secret.md'), '/etc/passwd']) {
        expect(await skill?.getResource?.(name), name).toBeUndefined();
      }
      const allowed = await skill?.getResource?.('public.md');
      expect(await allowed?.read({ skill: skill!, callId: 'c1' })).toBe('fine');
    });

    it('does not serve a file reached through a symbolic link', async () => {
      const path = await writeSkill('summarize', 'summarize');
      await writeFile(join(root, 'secret.md'), 'top secret', 'utf8');
      try {
        await symlink(join(root, 'secret.md'), join(path, 'link.md'));
      } catch {
        // Creating a link needs a privilege the runner may not have; the guard is exercised by
        // the linked-directory case below either way.
        return;
      }

      const [skill] = await directorySkillsSource({ paths: [path] }).getSkills(context());

      expect(await skill?.getResource?.('link.md')).toBeUndefined();
    });

    it('refuses to read a listed resource that has since become a link', async () => {
      // Discovery decides what exists, but the read happens later, after the name has travelled
      // through the model. A file swapped for a link in between must not be followed.
      const path = await writeSkill('summarize', 'summarize');
      await writeFile(join(root, 'secret.md'), 'top secret', 'utf8');
      await writeFile(join(path, 'notes.md'), 'ordinary', 'utf8');

      const [skill] = await directorySkillsSource({ paths: [path] }).getSkills(context());
      const resource = await skill?.getResource?.('notes.md');
      expect(resource).toBeDefined();

      await rm(join(path, 'notes.md'));
      try {
        await symlink(join(root, 'secret.md'), join(path, 'notes.md'));
      } catch {
        return;
      }

      await expect(resource?.read({ skill: skill!, callId: 'c1' })).rejects.toThrow(/symbolic link/);
    });

    it('does not descend into a linked directory', async () => {
      const path = await writeSkill('summarize', 'summarize');
      await mkdir(join(root, 'elsewhere'), { recursive: true });
      await writeFile(join(root, 'elsewhere/secret.md'), 'top secret', 'utf8');
      try {
        await symlink(join(root, 'elsewhere'), join(path, 'linked'), 'dir');
      } catch {
        return;
      }

      const [skill] = await directorySkillsSource({ paths: [path] }).getSkills(context());

      expect(await skill?.getResource?.('linked/secret.md')).toBeUndefined();
    });
  });

  describe('failures', () => {
    it('reports a skill it cannot parse and keeps the others', async () => {
      await writeSkill('skills/good', 'good');
      const broken = join(root, 'skills/broken');
      await mkdir(broken, { recursive: true });
      await writeFile(join(broken, 'SKILL.md'), 'no frontmatter here', 'utf8');

      const skills = await directorySkillsSource({ paths: [join(root, 'skills')] }).getSkills(context());

      expect(skills.map((skill) => skill.frontmatter.name)).toEqual(['good']);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.origin).toBe(broken);
    });

    it('reports a directory that does not exist rather than throwing', async () => {
      const skills = await directorySkillsSource({ paths: [join(root, 'missing')] }).getSkills(context());

      expect(skills).toEqual([]);
      expect(failures).toHaveLength(1);
    });
  });

  describe('scripts', () => {
    it('discovers none without a runner', async () => {
      const path = await writeSkill('summarize', 'summarize');
      await writeFile(join(path, 'run.py'), 'print(1)', 'utf8');

      const [skill] = await directorySkillsSource({ paths: [path] }).getSkills(context());

      expect(await skill?.getScript?.('run.py')).toBeUndefined();
      expect(await skill?.getContent()).toContain('<available_scripts />');
    });

    it('hands a discovered script to the runner with the model arguments', async () => {
      const path = await writeSkill('summarize', 'summarize');
      await writeFile(join(path, 'run.py'), 'print(1)', 'utf8');
      const seen: Array<{ name: string; skillName: string; args: unknown }> = [];

      const [skill] = await directorySkillsSource({
        paths: [path],
        scriptRunner: (script, args) => {
          seen.push({ name: script.name, skillName: script.skillName, args });
          return 'ran';
        },
      }).getSkills(context());

      const script = await skill?.getScript?.('run.py');
      expect(await script?.run({ length: 24 }, { skill: skill!, callId: 'c1' })).toBe('ran');
      expect(seen).toEqual([{ name: 'run.py', skillName: 'summarize', args: { length: 24 } }]);
    });
  });

  it('composes with cacheSkills, walking the filesystem once', async () => {
    const path = await writeSkill('summarize', 'summarize');
    const cached = cacheSkills(directorySkillsSource({ paths: [path] }));

    const first = await cached.getSkills(context());
    await rm(path, { recursive: true, force: true });
    const second = await cached.getSkills(context());

    expect(second).toBe(first);
  });
});
