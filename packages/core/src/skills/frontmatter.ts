import { ConfigurationError } from '../errors.js';

/**
 * The discovery metadata every skill carries, as defined by the Agent Skills specification.
 *
 * `name` and `description` are what the model sees before it decides to load a skill, so they are
 * the two fields the specification constrains: a name is a lowercase slug and a description is a
 * sentence that makes the skill findable.
 */
export interface SkillFrontmatter {
  /** Lowercase letters, digits and single hyphens; at most 64 characters. */
  readonly name: string;
  /** What the skill is for. At most 1024 characters. */
  readonly description: string;
  readonly license?: string;
  /** At most 500 characters. */
  readonly compatibility?: string;
  /** Space-delimited tool names the skill declares as pre-approved. */
  readonly allowedTools?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;

/** Lowercase alphanumerics separated by single hyphens: no leading, trailing or doubled hyphen. */
const VALID_NAME = /^[a-z0-9]([a-z0-9]*-[a-z0-9])*[a-z0-9]*$/;

/** What {@link skillFrontmatter} accepts. */
export interface SkillFrontmatterConfig {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  metadata?: Record<string, string>;
}

/**
 * Validates and freezes a skill's discovery metadata.
 *
 * @throws {ConfigurationError} When the name, description or compatibility breaks a specification
 * limit. Validation happens here rather than at load time so a malformed skill is reported by the
 * code that declared it.
 */
export function skillFrontmatter(config: SkillFrontmatterConfig): SkillFrontmatter {
  const problem = frontmatterProblem(config);
  if (problem !== undefined) {
    throw new ConfigurationError(problem);
  }
  return {
    name: config.name,
    description: config.description,
    ...(config.license === undefined ? {} : { license: config.license }),
    ...(config.compatibility === undefined ? {} : { compatibility: config.compatibility }),
    ...(config.allowedTools === undefined ? {} : { allowedTools: config.allowedTools }),
    // Copied so a caller-owned object cannot be mutated into the skill after the fact.
    ...(config.metadata === undefined ? {} : { metadata: { ...config.metadata } }),
  };
}

/** Describes what is wrong with `config`, or `undefined` when it is valid. */
function frontmatterProblem(config: Partial<SkillFrontmatterConfig>): string | undefined {
  const { name, description, compatibility } = config;
  if (name === undefined || name.trim() === '') {
    return 'Skill name cannot be empty.';
  }
  if (name.length > MAX_NAME_LENGTH || !VALID_NAME.test(name)) {
    return (
      `Invalid skill name '${name}': Must be ${MAX_NAME_LENGTH} characters or fewer, using only ` +
      'lowercase letters, numbers, and hyphens, and must not start or end with a hyphen or contain ' +
      'consecutive hyphens.'
    );
  }
  if (description === undefined || description.trim() === '') {
    return 'Skill description cannot be empty.';
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return `Skill '${name}' has an invalid description: Must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`;
  }
  if (compatibility !== undefined && compatibility.length > MAX_COMPATIBILITY_LENGTH) {
    return `Skill compatibility must be ${MAX_COMPATIBILITY_LENGTH} characters or fewer.`;
  }
  return undefined;
}

/** A parsed `SKILL.md` document. */
export interface ParsedSkillMarkdown {
  readonly frontmatter: SkillFrontmatter;
  /** Everything after the closing `---`, with no leading blank line. */
  readonly body: string;
}

/** The `---`-delimited frontmatter block at the very start of the document, after an optional BOM. */
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Top-level `key: value` lines. Group 2 is a quoted value, group 3 an unquoted one.
 *
 * Anchored at column 0 so indented children — the entries under `metadata:` — are not mistaken for
 * top-level fields. A key with no value (`metadata:` itself) does not match, which is what keeps
 * the block header out of the scalar fields.
 */
const TOP_LEVEL_ENTRY = /^([\w-]+)[ \t]*:[ \t]*(?:["'](.+?)["']|(.+?))[ \t]*$/gm;

/** A `metadata:` key followed by its indented block. */
const METADATA_BLOCK = /^metadata[ \t]*:[ \t]*\r?\n((?:[ \t]+\S.*(?:\r?\n|$))+)/m;

/** `key: value` lines inside an indented block. */
const INDENTED_ENTRY = /^[ \t]+([\w-]+)[ \t]*:[ \t]*(?:["'](.+?)["']|(.+?))[ \t]*$/gm;

/**
 * Parses a `SKILL.md` document into its frontmatter and body.
 *
 * The parser recognizes the subset of YAML the Agent Skills specification uses for frontmatter:
 * top-level scalars (optionally quoted, optionally written as a `|` or `>` block scalar) and a flat
 * `metadata:` block. It is deliberately not a YAML implementation — the core has no runtime
 * dependencies, and a skill header that needs more than this is a skill header that will not
 * round-trip through the other implementations either.
 *
 * ```ts
 * const { frontmatter, body } = parseSkillMarkdown(await readFile('skills/pricing/SKILL.md', 'utf8'));
 * ```
 *
 * ## Security considerations
 *
 * The parsed values go straight into the model's context. A skill file is executable prose: treat
 * one you did not write with the same suspicion as any other untrusted document.
 *
 * @throws {ConfigurationError} When the document has no frontmatter block, or its metadata breaks a
 * specification limit.
 */
export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
  const match = FRONTMATTER.exec(markdown);
  if (match === null) {
    throw new ConfigurationError("SKILL.md does not start with YAML frontmatter delimited by '---' lines.");
  }

  const block = match[1] ?? '';
  const fields = new Map<string, string>();
  for (const entry of block.matchAll(TOP_LEVEL_ENTRY)) {
    const key = (entry[1] ?? '').toLowerCase();
    // A quoted value is taken verbatim; an unquoted one may open a block scalar that continues
    // over the following indented lines. A duplicated key keeps its last value, like the
    // metadata block below.
    fields.set(key, entry[2] ?? blockScalarValue(block, entry));
  }

  const config: Partial<SkillFrontmatterConfig> = {
    ...withValue('name', fields.get('name')),
    ...withValue('description', fields.get('description')),
    ...withValue('license', fields.get('license')),
    ...withValue('compatibility', fields.get('compatibility')),
    ...withValue('allowedTools', fields.get('allowed-tools')),
  };
  const metadata = parseMetadata(block);
  const frontmatter = skillFrontmatter({
    ...(config as SkillFrontmatterConfig),
    ...(metadata === undefined ? {} : { metadata }),
  });

  return { frontmatter, body: markdown.slice(match[0].length) };
}

function withValue(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

function parseMetadata(block: string): Record<string, string> | undefined {
  const match = METADATA_BLOCK.exec(block);
  if (match === null) {
    return undefined;
  }
  const entries: Record<string, string> = {};
  for (const entry of (match[1] ?? '').matchAll(INDENTED_ENTRY)) {
    const key = entry[1];
    if (key !== undefined) {
      entries[key] = entry[2] ?? entry[3] ?? '';
    }
  }
  return entries;
}

/** The characters that open a YAML block scalar. */
const BLOCK_SCALAR_INDICATORS = ['|', '>'];

/**
 * Resolves an unquoted value, reading a block scalar's continuation lines when it opens one.
 *
 * Chomping indicators follow YAML 1.2 §8.1.1.2: `-` strips the final line break, `+` keeps it along
 * with any trailing blank lines, and the default clips (a literal block keeps one trailing newline,
 * a folded block none). Explicit indentation indicators such as `|2` are not supported; the
 * indentation is taken from the shallowest line of the block.
 */
function blockScalarValue(block: string, entry: RegExpExecArray | RegExpMatchArray): string {
  const value = entry[3] ?? '';
  const indicator = value[0];
  if (indicator === undefined || !BLOCK_SCALAR_INDICATORS.includes(indicator)) {
    return value;
  }
  const start = entry.index === undefined ? -1 : block.indexOf('\n', entry.index + entry[0].length);
  if (start < 0) {
    return value;
  }

  const keepTrailing = value[1] === '+';
  const stripTrailing = value[1] === '-';

  const lines: string[] = [];
  for (const line of block.slice(start + 1).split('\n')) {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text.trim() === '') {
      lines.push('');
      continue;
    }
    if (text[0] !== ' ' && text[0] !== '\t') {
      break;
    }
    lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    return '';
  }

  const indent = Math.min(...lines.filter((line) => line !== '').map(indentWidth));
  const dedented = lines.map((line) => (line === '' ? '' : line.slice(indent)));
  const joined = indicator === '|' ? dedented.join('\n') : dedented.filter((line) => line !== '').join(' ');

  if (keepTrailing) {
    return `${joined}\n`;
  }
  if (stripTrailing) {
    return joined;
  }
  return indicator === '|' ? `${joined}\n` : joined;
}

function indentWidth(line: string): number {
  let width = 0;
  while (width < line.length && (line[width] === ' ' || line[width] === '\t')) {
    width += 1;
  }
  return width;
}
