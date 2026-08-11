import type { AgentSession } from '../agent/session.js';
import type { ProviderAgentInfo } from '../context/context-provider.js';
import type { Skill } from './skill.js';

/** A skill that could not be loaded, reported without failing the rest of discovery. */
export interface SkillLoadFailure {
  /** The skill the failure is scoped to, when it is scoped to one. */
  readonly skill?: string;
  /** Where the failure came from, for diagnostics — an index URL, a directory, a server label. */
  readonly origin?: string;
  readonly error: unknown;
}

/** What a source learns about the run asking it for skills. */
export interface SkillsSourceContext {
  readonly agent: ProviderAgentInfo;
  readonly session: AgentSession;
  readonly signal?: AbortSignal;
  /**
   * Reports a skill that could not be loaded.
   *
   * Discovery continues: one unreadable skill must not take the others down with it, and it must
   * not fail a run that never needed it. The provider forwards these to its `onSkillError`.
   */
  reportSkillError(failure: SkillLoadFailure): void;
}

/**
 * Where skills come from.
 *
 * Implement this to serve skills from anywhere — a database, a package registry, a REST catalogue.
 * The context carries the run, so a source may return different skills per agent or per tenant;
 * whatever it returns is what the model is told about for that run.
 *
 * ## Security considerations
 *
 * A source decides what instructions enter the model's context. An external source is a trust
 * boundary: see {@link Skill}.
 */
export interface SkillsSource {
  getSkills(ctx: SkillsSourceContext): Promise<readonly Skill[]>;
}

/** Serves a fixed set of skills. */
export function inMemorySkillsSource(skills: readonly Skill[]): SkillsSource {
  const held = [...skills];
  return { getSkills: async () => held };
}

/**
 * Serves the skills of several sources as one.
 *
 * Sources are queried concurrently and their results concatenated in declaration order. A source
 * that throws contributes nothing and is reported through `reportSkillError`, so one unreachable
 * server does not hide the skills of the others.
 */
export function aggregateSkills(sources: readonly SkillsSource[]): SkillsSource {
  const held = [...sources];
  return {
    getSkills: async (ctx: SkillsSourceContext) => {
      const results = await Promise.all(
        held.map(async (source) => {
          try {
            return await source.getSkills(ctx);
          } catch (error) {
            ctx.signal?.throwIfAborted();
            ctx.reportSkillError({ error });
            return [];
          }
        }),
      );
      return results.flat();
    },
  };
}

/** Serves only the skills a predicate accepts. */
export function filterSkills(
  source: SkillsSource,
  predicate: (skill: Skill, ctx: SkillsSourceContext) => boolean,
): SkillsSource {
  return {
    getSkills: async (ctx: SkillsSourceContext) =>
      (await source.getSkills(ctx)).filter((skill) => predicate(skill, ctx)),
  };
}

/** Options for {@link deduplicateSkills}. */
export interface DeduplicateSkillsOptions {
  /** Called for each skill dropped as a duplicate, with the name that won. */
  onDuplicate?: (name: string) => void;
}

/**
 * Drops skills whose name a previous skill already claimed.
 *
 * Names are compared case-insensitively and the first occurrence wins, so ordering the sources
 * puts the more specific catalogue in front of the general one.
 */
export function deduplicateSkills(
  source: SkillsSource,
  options: DeduplicateSkillsOptions = {},
): SkillsSource {
  return {
    getSkills: async (ctx: SkillsSourceContext) => {
      const seen = new Set<string>();
      const kept: Skill[] = [];
      for (const skill of await source.getSkills(ctx)) {
        const key = skill.frontmatter.name.toLowerCase();
        if (seen.has(key)) {
          options.onDuplicate?.(skill.frontmatter.name);
          continue;
        }
        seen.add(key);
        kept.push(skill);
      }
      return kept;
    },
  };
}

/** Options for {@link cacheSkills}. */
export interface CacheSkillsOptions {
  /** How long a cached list stays fresh. Omit to cache for the lifetime of the source. */
  refreshIntervalMs?: number;
  /**
   * Partitions the cache.
   *
   * Required whenever the wrapped source returns different skills for different runs. Without it a
   * single list is shared by every run, so the first caller's skills would be replayed for
   * everyone — which across tenants is a disclosure, not a stale read.
   */
  isolationKey?: (ctx: SkillsSourceContext) => string;
}

interface CacheEntry {
  skills: Promise<readonly Skill[]>;
  loadedAt: number;
}

/**
 * Caches the wrapped source's skills.
 *
 * Discovery is often the expensive part — a directory walk, a round trip to an MCP server — and it
 * happens on every run. Concurrent runs share one in-flight load rather than starting one each; a
 * load that fails is not cached, so the next run retries.
 */
export function cacheSkills(source: SkillsSource, options: CacheSkillsOptions = {}): SkillsSource {
  const entries = new Map<string, CacheEntry>();
  return {
    getSkills: async (ctx: SkillsSourceContext) => {
      const key = options.isolationKey?.(ctx) ?? '';
      const cached = entries.get(key);
      if (cached !== undefined && isFresh(cached, options.refreshIntervalMs)) {
        return await cached.skills;
      }
      const entry: CacheEntry = { skills: source.getSkills(ctx), loadedAt: Date.now() };
      entries.set(key, entry);
      try {
        return await entry.skills;
      } catch (error) {
        // A failed load is not an answer. Evicting it — but only if it is still the entry we
        // installed — lets the next run try again without discarding a newer, successful load.
        if (entries.get(key) === entry) {
          entries.delete(key);
        }
        throw error;
      }
    },
  };
}

function isFresh(entry: CacheEntry, refreshIntervalMs: number | undefined): boolean {
  return refreshIntervalMs === undefined || Date.now() - entry.loadedAt < refreshIntervalMs;
}
