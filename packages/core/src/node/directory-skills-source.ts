import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Skill, SkillResource, SkillScript, SkillScriptArguments } from '../skills/skill.js';
import { markdownSkill, skillResource } from '../skills/skill.js';
import type { SkillsSource, SkillsSourceContext } from '../skills/source.js';

/** The document that makes a directory a skill. */
const SKILL_FILE = 'SKILL.md';

/** Files served as resources unless the caller narrows it. */
const DEFAULT_RESOURCE_EXTENSIONS = ['.md', '.json', '.yaml', '.yml', '.csv', '.xml', '.txt'] as const;
/** Files served as scripts, when a runner is supplied. */
const DEFAULT_SCRIPT_EXTENSIONS = ['.py'] as const;
/** `1` is the skill root alone; `2` adds one level of subdirectories. */
const DEFAULT_SEARCH_DEPTH = 2;

/** A file-based script, handed to the caller's runner with the arguments the model supplied. */
export interface DirectorySkillScript {
  /** The name the model uses, relative to the skill directory (`scripts/convert.py`). */
  readonly name: string;
  /** The absolute path of the script file, already checked to be inside the skill directory. */
  readonly path: string;
  /** The skill that owns it. */
  readonly skillName: string;
}

/**
 * Runs a script a skill directory contains.
 *
 * ## Security considerations
 *
 * This is a code-execution seam, and the arguments come from the model. Nothing in the framework
 * runs a discovered file: a source without a runner discovers no scripts at all, so executing one
 * is always something the application opted into and implemented itself.
 */
export type DirectorySkillScriptRunner = (
  script: DirectorySkillScript,
  args: SkillScriptArguments,
) => unknown | Promise<unknown>;

/** Options for {@link directorySkillsSource}. */
export interface DirectorySkillsSourceConfig {
  /**
   * Directories to load skills from.
   *
   * Each may be a skill directory — one holding a `SKILL.md` — or a parent whose immediate
   * children are skill directories.
   */
  paths: readonly string[];
  /**
   * Extensions served as resources. Defaults to `.md`, `.json`, `.yaml`, `.yml`, `.csv`, `.xml`
   * and `.txt`; an empty list discovers none.
   */
  resourceExtensions?: readonly string[];
  /** Extensions served as scripts, used only when `scriptRunner` is given. Defaults to `.py`. */
  scriptExtensions?: readonly string[];
  /**
   * How deep to look inside a skill directory for resources and scripts. Defaults to `2` — the
   * root plus one level of subdirectories, as in Python.
   */
  searchDepth?: number;
  /** Decides which discovered resources are served, by skill name and relative path. */
  resourceFilter?: (skillName: string, relativePath: string) => boolean;
  /** Decides which discovered scripts are served, by skill name and relative path. */
  scriptFilter?: (skillName: string, relativePath: string) => boolean;
  /** Runs a discovered script. Without one, no scripts are discovered. */
  scriptRunner?: DirectorySkillScriptRunner;
}

/**
 * Serves the skills held in one or more directories.
 *
 * A skill is a directory with a `SKILL.md` in it; its sibling files become the resources the model
 * can pull in with `read_skill_resource`, named by their path relative to the skill directory
 * (`references/pricing.md`). Pass the directories themselves, or a parent holding several:
 *
 * ```ts
 * const agent = new Agent({
 *   client,
 *   contextProviders: [skillsProvider(cacheSkills(directorySkillsSource({ paths: ['./skills'] })))],
 * });
 * ```
 *
 * Discovery walks the filesystem on every run, so wrap it in `cacheSkills` unless the catalogue is
 * expected to change between runs. A skill that cannot be read is reported through
 * `reportSkillError` and the others still load.
 *
 * ## Security considerations
 *
 * - **A read never escapes the skill directory.** Resources are discovered up front and served by
 *   name, so a path from the model never reaches the filesystem; the resolved path is checked
 *   against the skill directory as well, and any symbolic link or reparse point along the way is
 *   refused rather than followed. .NET and Python refuse links the same way — resolving them first
 *   and then checking the prefix would accept a link that happens to point back inside, which is a
 *   weaker guarantee than either.
 * - **Skill content is model context.** A `SKILL.md` body is injected verbatim and its resources
 *   are read on the model's say-so, so a directory anyone else can write to is a prompt-injection
 *   channel. Load skills from directories you control.
 * - **Scripts are not run.** Discovery only lists them, and only when the application supplies a
 *   {@link DirectorySkillScriptRunner} that decides how — and whether — to execute one.
 */
export function directorySkillsSource(config: DirectorySkillsSourceConfig): SkillsSource {
  const paths = [...config.paths];
  const resourceExtensions = normalizeExtensions(config.resourceExtensions ?? DEFAULT_RESOURCE_EXTENSIONS);
  const scriptExtensions = normalizeExtensions(config.scriptExtensions ?? DEFAULT_SCRIPT_EXTENSIONS);
  const searchDepth = Math.max(1, config.searchDepth ?? DEFAULT_SEARCH_DEPTH);

  return {
    getSkills: async (ctx: SkillsSourceContext): Promise<readonly Skill[]> => {
      const skills: Skill[] = [];
      for (const path of paths) {
        const directory = resolve(path);
        let candidates: string[];
        try {
          candidates = await skillDirectories(directory);
        } catch (error) {
          ctx.signal?.throwIfAborted();
          ctx.reportSkillError({ origin: directory, error });
          continue;
        }
        for (const candidate of candidates) {
          ctx.signal?.throwIfAborted();
          try {
            skills.push(
              await loadSkill(candidate, {
                resourceExtensions,
                scriptExtensions,
                searchDepth,
                ...(config.resourceFilter === undefined ? {} : { resourceFilter: config.resourceFilter }),
                ...(config.scriptFilter === undefined ? {} : { scriptFilter: config.scriptFilter }),
                ...(config.scriptRunner === undefined ? {} : { scriptRunner: config.scriptRunner }),
              }),
            );
          } catch (error) {
            // One unreadable skill — bad frontmatter, a permission problem — must not cost the run
            // the skills that did load, or fail a run that never needed this one.
            ctx.signal?.throwIfAborted();
            ctx.reportSkillError({ origin: candidate, error });
          }
        }
      }
      return skills;
    },
  };
}

interface LoadOptions {
  resourceExtensions: ReadonlySet<string>;
  scriptExtensions: ReadonlySet<string>;
  searchDepth: number;
  resourceFilter?: (skillName: string, relativePath: string) => boolean;
  scriptFilter?: (skillName: string, relativePath: string) => boolean;
  scriptRunner?: DirectorySkillScriptRunner;
}

/** The directory itself when it holds a `SKILL.md`, otherwise its immediate children that do. */
async function skillDirectories(directory: string): Promise<string[]> {
  if (await isReadableFile(join(directory, SKILL_FILE))) {
    return [directory];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    // A linked directory is skipped rather than followed: what it points at is outside the tree
    // the caller named, and the whole guarantee here is that a skill's files are its own.
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const child = join(directory, entry.name);
    if (await isReadableFile(join(child, SKILL_FILE))) {
      found.push(child);
    }
  }
  return found;
}

async function loadSkill(directory: string, options: LoadOptions): Promise<Skill> {
  const markdown = await readFile(join(directory, SKILL_FILE), 'utf8');
  // Parsed first: the skill's name is what the filters see, and a document that does not parse
  // should fail before the directory is walked.
  const named = markdownSkill({ markdown });
  const skillName = named.frontmatter.name;

  const files = await walk(directory, options.searchDepth);
  const resources: SkillResource[] = [];
  const scripts: SkillScript[] = [];

  for (const relativePath of files) {
    if (relativePath === SKILL_FILE) {
      continue;
    }
    const extension = extensionOf(relativePath);
    if (options.resourceExtensions.has(extension)) {
      if (options.resourceFilter?.(skillName, relativePath) === false) {
        continue;
      }
      resources.push(
        skillResource({
          name: relativePath,
          read: () => readWithin(directory, relativePath),
        }),
      );
      continue;
    }
    const runner = options.scriptRunner;
    if (runner !== undefined && options.scriptExtensions.has(extension)) {
      if (options.scriptFilter?.(skillName, relativePath) === false) {
        continue;
      }
      scripts.push({
        name: relativePath,
        run: async (args: SkillScriptArguments) =>
          await runner(
            { name: relativePath, path: await resolveWithin(directory, relativePath), skillName },
            args,
          ),
      });
    }
  }

  return markdownSkill({ markdown, resources, scripts });
}

/** Relative paths of the files under `directory`, to `depth` levels (`1` being the root alone). */
async function walk(directory: string, depth: number): Promise<string[]> {
  const found: string[] = [];
  const visit = async (current: string, remaining: number): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      // A directory entry reports what it *is*, not what it points at, so a link is neither a file
      // nor a directory here: links are left unlisted and undescended without a case of their own.
      if (entry.isFile()) {
        found.push(toPosix(relative(directory, path)));
      } else if (entry.isDirectory() && remaining > 1) {
        await visit(path, remaining - 1);
      }
    }
  };
  await visit(directory, depth);
  return found.sort();
}

/** Reads a discovered file, re-checking that it is still inside the skill directory. */
async function readWithin(directory: string, relativePath: string): Promise<string> {
  return await readFile(await resolveWithin(directory, relativePath), 'utf8');
}

/**
 * Resolves a path inside a skill directory, or refuses.
 *
 * Discovery already decided which files exist, so this is the second lock rather than the first:
 * the name travelled through the model on its way back, and a resource whose path has changed
 * shape — or acquired a link — since it was listed must not be readable.
 */
async function resolveWithin(directory: string, relativePath: string): Promise<string> {
  const normalized = toPosix(relativePath).replace(/^\.\//, '');
  const resolved = resolve(directory, normalized);
  if (!isWithin(directory, resolved)) {
    throw new Error(`Resource '${relativePath}' is outside the skill directory.`);
  }
  await refuseLinks(directory, resolved);
  return resolved;
}

/** Rejects a path with a symbolic link or reparse point anywhere between the directory and it. */
async function refuseLinks(directory: string, path: string): Promise<void> {
  const steps = toPosix(relative(directory, path))
    .split('/')
    .filter((step) => step !== '');
  let current = directory;
  for (const step of steps) {
    current = join(current, step);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      // The path is not named back: what the model may learn about the filesystem stops at the
      // fact that this resource is unavailable.
      throw new Error('A skill resource may not be reached through a symbolic link.');
    }
  }
}

function isWithin(directory: string, path: string): boolean {
  const root = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return path === directory || path.startsWith(root);
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

function normalizeExtensions(extensions: readonly string[]): ReadonlySet<string> {
  return new Set(
    extensions.map((extension) =>
      extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`,
    ),
  );
}
