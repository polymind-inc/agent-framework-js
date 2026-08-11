import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../errors.js';
import { parseSkillMarkdown, skillFrontmatter } from './frontmatter.js';

describe('skillFrontmatter', () => {
  it('accepts a name and description within the specification limits', () => {
    const frontmatter = skillFrontmatter({ name: 'unit-converter', description: 'Converts units.' });
    expect(frontmatter).toEqual({ name: 'unit-converter', description: 'Converts units.' });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['Unit-Converter', 'uppercase'],
    ['-leading', 'a leading hyphen'],
    ['trailing-', 'a trailing hyphen'],
    ['double--hyphen', 'consecutive hyphens'],
    ['under_score', 'an underscore'],
    ['a'.repeat(65), 'over 64 characters'],
  ])('rejects %j (%s)', (name) => {
    expect(() => skillFrontmatter({ name, description: 'x' })).toThrow(ConfigurationError);
  });

  it('accepts digits and single hyphens', () => {
    expect(skillFrontmatter({ name: 'iso-8601-dates', description: 'x' }).name).toBe('iso-8601-dates');
  });

  it('rejects an empty description and one over the limit', () => {
    expect(() => skillFrontmatter({ name: 'a', description: '  ' })).toThrow(/description cannot be empty/);
    expect(() => skillFrontmatter({ name: 'a', description: 'x'.repeat(1025) })).toThrow(
      /1024 characters or fewer/,
    );
  });

  it('rejects a compatibility string over the limit', () => {
    expect(() => skillFrontmatter({ name: 'a', description: 'x', compatibility: 'y'.repeat(501) })).toThrow(
      /compatibility/,
    );
  });

  // The wording is shared with the reference implementations, so a developer moving between the
  // TypeScript and Python frameworks meets the same message for the same mistake.
  it.each([
    [
      { name: 'Bad Name', description: 'x' },
      "Invalid skill name 'Bad Name': Must be 64 characters or fewer, using only lowercase " +
        'letters, numbers, and hyphens, and must not start or end with a hyphen or contain ' +
        'consecutive hyphens.',
    ],
    [{ name: 'a', description: '' }, 'Skill description cannot be empty.'],
    [
      { name: 'a', description: 'x'.repeat(1025) },
      "Skill 'a' has an invalid description: Must be 1024 characters or fewer.",
    ],
    [
      { name: 'a', description: 'x', compatibility: 'y'.repeat(501) },
      'Skill compatibility must be 500 characters or fewer.',
    ],
  ])('reports %o with the same wording as the reference implementations', (config, message) => {
    expect(() => skillFrontmatter(config)).toThrow(message);
  });

  it("copies the metadata so a later mutation of the caller's object cannot reach the skill", () => {
    const metadata = { owner: 'platform' };
    const frontmatter = skillFrontmatter({ name: 'a', description: 'x', metadata });
    metadata.owner = 'someone-else';
    expect(frontmatter.metadata).toEqual({ owner: 'platform' });
  });
});

describe('parseSkillMarkdown', () => {
  it('reads every specification field and returns the body', () => {
    const parsed = parseSkillMarkdown(
      [
        '---',
        'name: unit-converter',
        'description: Converts between metric and imperial units.',
        'license: MIT',
        'compatibility: any',
        'allowed-tools: read_file write_file',
        'metadata:',
        '  owner: platform',
        '  tier: "2"',
        '---',
        '# Unit converter',
        '',
        'Use the table.',
      ].join('\n'),
    );

    expect(parsed.frontmatter).toEqual({
      name: 'unit-converter',
      description: 'Converts between metric and imperial units.',
      license: 'MIT',
      compatibility: 'any',
      allowedTools: 'read_file write_file',
      metadata: { owner: 'platform', tier: '2' },
    });
    expect(parsed.body).toBe('# Unit converter\n\nUse the table.');
  });

  it('does not mistake an indented metadata entry for a top-level field', () => {
    const parsed = parseSkillMarkdown(
      ['---', 'name: a', 'description: real', 'metadata:', '  description: nested', '---', 'body'].join('\n'),
    );
    expect(parsed.frontmatter.description).toBe('real');
    expect(parsed.frontmatter.metadata).toEqual({ description: 'nested' });
  });

  it('strips the quotes from a quoted value', () => {
    const parsed = parseSkillMarkdown(
      ['---', 'name: a', 'description: "Uses a: colon"', '---', 'body'].join('\n'),
    );
    expect(parsed.frontmatter.description).toBe('Uses a: colon');
  });

  it('reads a literal block scalar, keeping the line breaks and clipping to one trailing newline', () => {
    const parsed = parseSkillMarkdown(
      ['---', 'name: a', 'description: |', '  first', '  second', '', '---', 'body'].join('\n'),
    );
    expect(parsed.frontmatter.description).toBe('first\nsecond\n');
  });

  it('folds a folded block scalar onto one line with no trailing newline', () => {
    const parsed = parseSkillMarkdown(
      ['---', 'name: a', 'description: >', '  first', '  second', '---', 'body'].join('\n'),
    );
    expect(parsed.frontmatter.description).toBe('first second');
  });

  it.each([
    ['|-', 'first\nsecond'],
    ['|+', 'first\nsecond\n'],
  ])('honours the %s chomping indicator', (indicator, expected) => {
    const parsed = parseSkillMarkdown(
      ['---', 'name: a', `description: ${indicator}`, '  first', '  second', '---', 'body'].join('\n'),
    );
    expect(parsed.frontmatter.description).toBe(expected);
  });

  it('lets the last occurrence of a duplicated key win, as the reference parser does', () => {
    const parsed = parseSkillMarkdown(
      ['---', 'name: a', 'description: first', 'description: second', '---', 'body'].join('\n'),
    );
    expect(parsed.frontmatter.description).toBe('second');
  });

  it('tolerates a UTF-8 BOM and CRLF line endings', () => {
    const parsed = parseSkillMarkdown(`﻿---\r\nname: a\r\ndescription: works\r\n---\r\nbody\r\n`);
    expect(parsed.frontmatter.description).toBe('works');
    expect(parsed.body).toBe('body\r\n');
  });

  it('trims surrounding spaces and tabs from an unquoted value', () => {
    const parsed = parseSkillMarkdown('---\nname: a\ndescription: \t padded \t \n---\nbody');
    expect(parsed.frontmatter.description).toBe('padded');
  });

  it('parses a pathological header in linear time', () => {
    // A key-like CRLF line holding tens of thousands of tabs made the previous entry pattern
    // backtrack polynomially: `.` cannot match the `\r`, so the lazy value and the trailing
    // whitespace run re-scanned the tab run against each other. The document is caller-supplied
    // input, so parsing must stay linear.
    const hostile = `---\nname: a\n-:${'\t'.repeat(50_000)}\r\ndescription: x\n---\nbody`;
    const startedAt = performance.now();
    const parsed = parseSkillMarkdown(hostile);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(parsed.frontmatter).toEqual({ name: 'a', description: 'x' });
  });

  it('refuses a document with no frontmatter block', () => {
    expect(() => parseSkillMarkdown('# Just markdown')).toThrow(ConfigurationError);
  });

  it('refuses a document whose frontmatter breaks a specification limit', () => {
    expect(() => parseSkillMarkdown('---\nname: Bad Name\ndescription: x\n---\nbody')).toThrow(
      /Invalid skill name/,
    );
  });
});
