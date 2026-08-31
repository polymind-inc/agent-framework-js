import type { ContextProvider, ProviderRunContext } from '../context/context-provider.js';
import { ConfigurationError } from '../errors.js';
import type { ApprovalMode, Tool, ToolContext } from '../tools/tool.js';
import { tool } from '../tools/tool.js';
import type { Skill, SkillAccessOptions, SkillInvocationContext, SkillScriptArguments } from './skill.js';
import { xmlEscape } from './skill.js';
import type { SkillLoadFailure, SkillsSource, SkillsSourceContext } from './source.js';
import { cacheSkills, deduplicateSkills, inMemorySkillsSource } from './source.js';

/** The names of the three tools {@link skillsProvider} contributes. */
export const SKILL_TOOL_NAMES = {
  loadSkill: 'load_skill',
  readSkillResource: 'read_skill_resource',
  runSkillScript: 'run_skill_script',
} as const;

/** How much approval each skill tool requires. */
export interface SkillApprovalModes {
  /** Defaults to `'always_require'`. */
  loadSkill?: ApprovalMode;
  /** Defaults to `'always_require'`. */
  readSkillResource?: ApprovalMode;
  /** Defaults to `'always_require'`. */
  runSkillScript?: ApprovalMode;
}

/** Configuration for {@link skillsProvider}. */
export interface SkillsProviderConfig {
  /** Defaults to `'agent_skills'`. */
  sourceId?: string;
  /**
   * Replaces the prompt that advertises the skills.
   *
   * Must contain `{skills}`, where the `<skill>` listing is substituted. `{resource_instructions}`
   * and `{runner_instructions}` are optional and receive the built-in guidance for reading
   * resources and running scripts; leaving them out drops that guidance without unregistering the
   * tools.
   */
  instructionTemplate?: string;
  /** Per-tool approval. Every tool requires approval by default. */
  approvals?: SkillApprovalModes;
  /** Called for each skill a source could not load. Discovery continues regardless. */
  onSkillError?: (failure: SkillLoadFailure) => void;
}

const DEFAULT_SOURCE_ID = 'agent_skills';

const DEFAULT_INSTRUCTION_TEMPLATE = `You have access to skills containing domain-specific knowledge and capabilities.
Each skill provides specialized instructions, reference documents, and assets for specific tasks.

<available_skills>
{skills}
</available_skills>

When a task aligns with a skill's domain, follow these steps in exact order:
- Use \`load_skill\` to retrieve the skill's instructions.
- Follow the provided guidance.
{resource_instructions}
{runner_instructions}
Only load what is needed, when it is needed.`;

const RESOURCE_INSTRUCTIONS =
  '- Use `read_skill_resource` to read any referenced resources, using the name exactly as listed\n' +
  '   (e.g. `"style-guide"` not `"style-guide.md"`, `"references/FAQ.md"` not `"FAQ.md"`).\n';

const SCRIPT_INSTRUCTIONS =
  '- Use `run_skill_script` to run referenced scripts, using the name exactly as listed.\n' +
  '- Pass named script arguments inside `args` as a JSON object, including for inline scripts' +
  ' (e.g. `args: {"length": 24}`), not as top-level tool parameters.\n' +
  '- For file-based scripts that document CLI-style positional arguments, pass `args` as an array of strings' +
  ' (e.g. `args: ["input.docx", "--output", "result.idx"]`).\n';

/**
 * Advertises skills to the model and gives it the tools to pull them in.
 *
 * Skills are disclosed progressively. Every run, the provider asks its source for the available
 * skills and puts only their names and descriptions in the system prompt — roughly a hundred tokens
 * each — then registers three tools the model calls when a task actually needs one:
 * `load_skill` returns a skill's body, `read_skill_resource` returns a named piece of supplementary
 * content, and `run_skill_script` runs one of its scripts. A run whose source returns no skills gets
 * neither the prompt nor the tools.
 *
 * ```ts
 * const agent = new Agent({
 *   client,
 *   instructions: 'You are a support assistant.',
 *   contextProviders: [skillsProvider([escalationPolicy, refundRules])],
 * });
 * ```
 *
 * A bare skill or array of skills is wrapped in a cached, deduplicating in-memory source. A
 * {@link SkillsSource} you pass yourself is used exactly as given — caching a source that varies by
 * agent or tenant would replay one run's skills for another — so compose {@link cacheSkills} and
 * {@link deduplicateSkills} around it when you want them.
 *
 * ## Security considerations
 *
 * - **Skill content is model context.** Names, descriptions and bodies are injected verbatim. A
 *   source that serves someone else's content is an indirect prompt-injection path; a source that
 *   serves scripts is a code-execution path. Connect only sources you trust.
 * - **Every tool requires approval by default**, so a skill operation surfaces on
 *   `response.userInputRequests` before it runs. `approvals` is the only way to lift that default:
 *   the function-calling loop rewrites the round into approval requests before any middleware
 *   runs, so a `toolApprovalMiddleware` rule with `decision: 'allow'` cannot bypass a tool that
 *   itself requires approval. To gate a relaxed tool by policy instead, compose the two:
 *
 *   ```ts
 *   skillsProvider(skills, { approvals: { runSkillScript: 'never_require' } });
 *   toolApprovalMiddleware([{ tools: SKILL_TOOL_NAMES.runSkillScript, decision: 'require' }]);
 *   ```
 *
 *   Approval decisions go by tool name. Do not register another tool under these names.
 *
 * @throws {ConfigurationError} When `instructionTemplate` has no `{skills}` placeholder.
 */
export function skillsProvider(
  source: SkillsSource | readonly Skill[] | Skill,
  config: SkillsProviderConfig = {},
): ContextProvider {
  const template = config.instructionTemplate ?? DEFAULT_INSTRUCTION_TEMPLATE;
  if (!template.includes('{skills}')) {
    throw new ConfigurationError("instructionTemplate must contain a '{skills}' placeholder.");
  }
  const resolved = resolveSource(source);
  const sourceId = config.sourceId ?? DEFAULT_SOURCE_ID;

  return {
    sourceId,
    beforeRun: async (ctx: ProviderRunContext): Promise<void> => {
      const skills = await resolved.getSkills(sourceContext(ctx, config.onSkillError));
      if (skills.length === 0) {
        return;
      }
      ctx.extendInstructions(renderInstructions(template, skills));
      ctx.extendTools(skillTools(skills, config.approvals ?? {}));
    },
  };
}

/**
 * Normalizes the three accepted shapes into one source.
 *
 * Skills handed in directly are context-independent, so caching and deduplicating them is always
 * safe and always wanted. A caller-supplied source is left alone for the opposite reason: it may
 * answer differently per run, and a shared cache in front of it would leak one run's skills into
 * the next.
 */
function resolveSource(source: SkillsSource | readonly Skill[] | Skill): SkillsSource {
  if (Array.isArray(source)) {
    return deduplicateSkills(cacheSkills(inMemorySkillsSource(source as readonly Skill[])));
  }
  if ('getSkills' in source) {
    return source as SkillsSource;
  }
  return deduplicateSkills(cacheSkills(inMemorySkillsSource([source as Skill])));
}

function sourceContext(
  ctx: ProviderRunContext,
  onSkillError: ((failure: SkillLoadFailure) => void) | undefined,
): SkillsSourceContext {
  return {
    agent: ctx.agent,
    session: ctx.session,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    reportSkillError: (failure: SkillLoadFailure) => onSkillError?.(failure),
  };
}

/** Renders the prompt that lists the available skills, sorted by name so the output is stable. */
function renderInstructions(template: string, skills: readonly Skill[]): string {
  // Code-unit comparison rather than localeCompare, so the order matches the reference
  // implementations and never varies with the host locale. Returning 0 on equal names keeps the
  // sort stable for a source that serves duplicates.
  const listing = [...skills]
    .sort((left, right) => compareNames(left.frontmatter.name, right.frontmatter.name))
    .flatMap((skill) => [
      '  <skill>',
      `    <name>${xmlEscape(skill.frontmatter.name)}</name>`,
      `    <description>${xmlEscape(skill.frontmatter.description)}</description>`,
      '  </skill>',
    ])
    .join('\n');

  return template
    .replaceAll('{skills}', listing)
    .replaceAll('{resource_instructions}', RESOURCE_INSTRUCTIONS)
    .replaceAll('{runner_instructions}', SCRIPT_INSTRUCTIONS);
}

/**
 * Builds the three tools, bound to the skills discovered for this run.
 *
 * All three are always registered, including `run_skill_script` for a catalogue that happens to
 * have no scripts: a skill's scripts are resolved by name on demand — a source serving skills over
 * the network cannot enumerate them without fetching every skill — so there is nothing to test the
 * question against at registration time.
 */
function skillTools(skills: readonly Skill[], approvals: SkillApprovalModes): Tool[] {
  const loadSkill = tool({
    name: SKILL_TOOL_NAMES.loadSkill,
    description: 'Loads the full instructions for a specific skill.',
    approvalMode: approvals.loadSkill ?? 'always_require',
    parameters: {
      type: 'object' as const,
      properties: {
        skill_name: { type: 'string', description: 'The name of the skill to load.' },
      },
      required: ['skill_name'],
    },
    execute: async (input: Record<string, unknown>, toolCtx: ToolContext): Promise<string> => {
      const skillName = asName(input.skill_name);
      if (skillName === undefined) {
        return emptyNameError('Skill');
      }
      const skill = findSkill(skills, skillName);
      if (skill === undefined) {
        return skillNotFoundError(skillName);
      }
      return await skill.getContent(accessOptions(toolCtx));
    },
  });

  const readSkillResource = tool({
    name: SKILL_TOOL_NAMES.readSkillResource,
    description: 'Reads a resource associated with a skill, such as references, assets, or dynamic data.',
    approvalMode: approvals.readSkillResource ?? 'always_require',
    parameters: {
      type: 'object' as const,
      properties: {
        skill_name: { type: 'string', description: 'The name of the skill.' },
        resource_name: { type: 'string', description: 'The name of the resource.' },
      },
      required: ['skill_name', 'resource_name'],
    },
    execute: async (input: Record<string, unknown>, toolCtx: ToolContext): Promise<unknown> => {
      const skillName = asName(input.skill_name);
      if (skillName === undefined) {
        return emptyNameError('Skill');
      }
      const resourceName = asName(input.resource_name);
      if (resourceName === undefined) {
        return emptyNameError('Resource');
      }
      const skill = findSkill(skills, skillName);
      if (skill === undefined) {
        return skillNotFoundError(skillName);
      }
      const resource = await skill.getResource?.(resourceName, accessOptions(toolCtx));
      if (resource === undefined) {
        return `Error: Resource '${resourceName}' not found in skill '${skillName}'.`;
      }
      // A read that throws is left to the function-calling loop, which decides how much of the
      // failure the model is allowed to see. Resources take no model-supplied arguments, so a
      // generic error message here would tell the model nothing it could act on.
      return await resource.read(invocationContext(skill, toolCtx));
    },
  });

  const runSkillScript = tool({
    name: SKILL_TOOL_NAMES.runSkillScript,
    description: 'Runs a script associated with a skill.',
    approvalMode: approvals.runSkillScript ?? 'always_require',
    parameters: {
      type: 'object' as const,
      properties: {
        skill_name: { type: 'string', description: 'The name of the skill.' },
        script_name: {
          type: 'string',
          description:
            'The name of the script to run as listed in the skill, preserving any directory ' +
            'prefix exactly as shown. Do not add or remove path prefixes.',
        },
        args: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: true,
              description: 'Named arguments as key-value pairs (e.g. {"length": 24, "uppercase": true}).',
            },
            {
              type: 'array',
              items: { type: 'string' },
              description:
                'Positional CLI arguments as a string array (e.g. ["input.docx", "--output", "result.idx"]).',
            },
            { type: 'null' },
          ],
          // Advertised only: omitting `args` is a supported call, and saying so keeps the model
          // from inventing a placeholder for a script that takes nothing. The tool never
          // substitutes the value — a script still sees `undefined` for an omitted argument.
          default: null,
          description:
            'Arguments to pass to the script. Use an array of strings for CLI-style positional ' +
            'arguments (e.g. ["input.docx", "--output", "result.idx"]), or an object for named ' +
            'parameters (e.g. {"length": 24, "uppercase": true}). How these values are mapped to ' +
            'the underlying script is determined by the script implementation or configured runner.',
        },
      },
      required: ['skill_name', 'script_name'],
    },
    execute: async (input: Record<string, unknown>, toolCtx: ToolContext): Promise<unknown> => {
      const skillName = asName(input.skill_name);
      if (skillName === undefined) {
        return emptyNameError('Skill');
      }
      const scriptName = asName(input.script_name);
      if (scriptName === undefined) {
        return emptyNameError('Script');
      }
      const skill = findSkill(skills, skillName);
      if (skill === undefined) {
        return skillNotFoundError(skillName);
      }
      const script = await skill.getScript?.(scriptName, accessOptions(toolCtx));
      if (script === undefined) {
        return `Error: Script '${scriptName}' not found in skill '${skillName}'.`;
      }
      // The cast is wider than the truth: the schema's null branch means a model can send an
      // explicit `null`, which reaches the script even though the declared type excludes it. The
      // test driving all three shapes through this call pins that. Reconciling the two — widening
      // the type or folding `null` into `undefined` — changes the published surface or what a
      // script observes, so it is decided separately rather than here.
      return await script.run(input.args as SkillScriptArguments, invocationContext(skill, toolCtx));
    },
  });

  return [loadSkill, readSkillResource, runSkillScript];
}

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function accessOptions(toolCtx: ToolContext): SkillAccessOptions | undefined {
  return toolCtx.signal === undefined ? undefined : { signal: toolCtx.signal };
}

function invocationContext(skill: Skill, toolCtx: ToolContext): SkillInvocationContext {
  return {
    skill,
    callId: toolCtx.callId,
    ...(toolCtx.signal === undefined ? {} : { signal: toolCtx.signal }),
    ...(toolCtx.session === undefined ? {} : { session: toolCtx.session }),
  };
}

// The refusal strings are shared across the three skill tools so the wording — which the model
// reads and acts on — cannot drift between them.
function emptyNameError(what: 'Skill' | 'Resource' | 'Script'): string {
  return `Error: ${what} name cannot be empty.`;
}

function skillNotFoundError(name: string): string {
  return `Error: Skill '${name}' not found.`;
}

/** Returns the name exactly as sent, or `undefined` when it is missing or blank. */
function asName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value;
}

function findSkill(skills: readonly Skill[], name: string): Skill | undefined {
  const wanted = name.toLowerCase();
  return skills.find((skill) => skill.frontmatter.name.toLowerCase() === wanted);
}
