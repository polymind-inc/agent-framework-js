import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSession } from '../agent/session.js';
import type { SkillLoadFailure, SkillsSourceContext } from '../skills/source.js';
import { directorySkillsSource } from './directory-skills-source.js';

// Discovery checks `SKILL.md` with lstat and the load reads it afterwards, so there is a window in
// which the file can be swapped for a symbolic link. The window cannot be held open from outside,
// so this lstat double lies exactly once — reporting the on-disk link as a plain file, the state
// discovery would have seen before the swap — and tells the truth from then on.
const gate = vi.hoisted(() => {
  const state: { lieOnceAbout: string | undefined } = { lieOnceAbout: undefined };
  return state;
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      const stats = await actual.lstat(path);
      if (gate.lieOnceAbout !== undefined && String(path) === gate.lieOnceAbout) {
        gate.lieOnceAbout = undefined;
        return { ...stats, isFile: () => true, isSymbolicLink: () => false };
      }
      return stats;
    },
  };
});

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'af-dir-skills-race-'));
  failures.length = 0;
  gate.lieOnceAbout = undefined;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('directorySkillsSource discovery-to-read window', () => {
  it('refuses a SKILL.md that has become a link by the time it is read', async () => {
    await writeFile(join(root, 'secret.md'), '---\nname: secret\ndescription: Outside.\n---\n', 'utf8');
    const skillDir = join(root, 'skill');
    await mkdir(skillDir);
    const skillFile = join(skillDir, 'SKILL.md');
    try {
      await symlink(join(root, 'secret.md'), skillFile);
    } catch {
      // Creating a link needs a privilege the runner may not have; nothing to exercise then.
      return;
    }
    gate.lieOnceAbout = skillFile;

    const skills = await directorySkillsSource({ paths: [skillDir] }).getSkills(context());

    // The load is refused rather than following the link to content outside the directory; the
    // failure is reported and costs only this skill.
    expect(skills).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.origin).toBe(skillDir);
  });
});
