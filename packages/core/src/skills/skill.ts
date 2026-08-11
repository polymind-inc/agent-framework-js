import type { AgentSession } from '../agent/session.js';
import { ConfigurationError, ToolInvocationError } from '../errors.js';
import type { JsonSchema, SchemaInput } from '../tools/json-schema.js';
import { resolveJsonSchema } from '../tools/json-schema.js';
import { formatSchemaIssues, isStandardSchema } from '../tools/standard-schema.js';
import type { ToolInputOf } from '../tools/tool.js';
import type { SkillFrontmatter } from './frontmatter.js';
import { parseSkillMarkdown, skillFrontmatter } from './frontmatter.js';

/** What a skill's resource or script sees when the model reaches for it. */
export interface SkillInvocationContext {
  /** The skill the resource or script belongs to. */
  readonly skill: Skill;
  /** The `callId` of the model's call to `read_skill_resource` / `run_skill_script`. */
  readonly callId: string;
  readonly signal?: AbortSignal;
  /** The session of the run, when the skill was reached through an agent. */
  readonly session?: AgentSession;
}

/**
 * Supplementary content a skill offers on demand — a reference table, a checklist, an asset.
 *
 * A resource takes no model-supplied arguments: the model asks for it by name and gets what the
 * skill decides to give it. Anything the model needs to parameterize belongs in a
 * {@link SkillScript} instead.
 */
export interface SkillResource {
  readonly name: string;
  readonly description?: string;
  /** Returns the content. A string reaches the model as-is; anything else is JSON-encoded. */
  read(ctx: SkillInvocationContext): unknown | Promise<unknown>;
}

/**
 * The arguments a model passes to a script.
 *
 * Two shapes, because scripts come in two flavours: named parameters for a function, and a
 * positional argv for anything shaped like a command line.
 */
export type SkillScriptArguments = Record<string, unknown> | readonly string[] | undefined;

/** An action a skill can perform, invoked through the `run_skill_script` tool. */
export interface SkillScript {
  readonly name: string;
  readonly description?: string;
  /** Advertised to the model inside the skill body so it knows the argument shape. */
  readonly parametersSchema?: JsonSchema;
  run(args: SkillScriptArguments, ctx: SkillInvocationContext): unknown | Promise<unknown>;
}

/**
 * A unit of domain knowledge an agent can pull into context on demand.
 *
 * Only {@link SkillFrontmatter} — a name and a description — is advertised up front. The body,
 * resources and scripts are fetched when the model asks for them, which is what keeps a large
 * catalogue affordable. Implement this interface directly to serve skills from somewhere the
 * built-in factories do not cover.
 *
 * ## Security considerations
 *
 * A skill's body is injected verbatim into the model's context, and its scripts run with whatever
 * authority the process has. A skill obtained from outside your codebase — over MCP, from a
 * registry, from a user upload — is untrusted input in the shape of instructions.
 */
export interface Skill {
  readonly frontmatter: SkillFrontmatter;
  /** The full body the `load_skill` tool returns. */
  getContent(options?: SkillAccessOptions): string | Promise<string>;
  /** Resolves a resource by name. Names are matched case-insensitively by the built-in skills. */
  getResource?(
    name: string,
    options?: SkillAccessOptions,
  ): SkillResource | undefined | Promise<SkillResource | undefined>;
  /** Resolves a script by name. */
  getScript?(
    name: string,
    options?: SkillAccessOptions,
  ): SkillScript | undefined | Promise<SkillScript | undefined>;
}

/**
 * What a {@link Skill} accessor receives alongside its arguments.
 *
 * A skill that lives somewhere remote does I/O in `getContent` and `getResource`, and the signal
 * is how a cancelled run reaches that I/O. The built-in in-memory skills accept and ignore it.
 */
export interface SkillAccessOptions {
  readonly signal?: AbortSignal;
}

/** What {@link skillResource} accepts. Supply exactly one of `content` or `read`. */
export interface SkillResourceConfig {
  name: string;
  description?: string;
  /** A fixed value, returned on every read. */
  content?: unknown;
  /** Computes the value per read, for anything that has to be fetched or is time-sensitive. */
  read?: (ctx: SkillInvocationContext) => unknown | Promise<unknown>;
}

/**
 * Declares a skill resource.
 *
 * ```ts
 * skillResource({ name: 'conversion-table', content: 'kg=2.205lb, m=3.281ft' })
 * skillResource({ name: 'open-incidents', read: async () => await incidents.list() })
 * ```
 *
 * @throws {ConfigurationError} When neither or both of `content` and `read` are given.
 */
export function skillResource(config: SkillResourceConfig): SkillResource {
  const hasContent = 'content' in config && config.content !== undefined;
  const hasRead = config.read !== undefined;
  if (hasContent === hasRead) {
    throw new ConfigurationError(
      `Skill resource '${config.name}' must declare exactly one of 'content' or 'read'.`,
    );
  }
  const { read } = config;
  const { content } = config;
  return {
    name: config.name,
    ...(config.description === undefined ? {} : { description: config.description }),
    read: read === undefined ? () => content : (ctx: SkillInvocationContext) => read(ctx),
  };
}

/** What {@link skillScript} accepts. */
export interface SkillScriptConfig<TParams extends SchemaInput, TOutput> {
  name: string;
  description?: string;
  /** A Standard Schema (Zod, Valibot, ArkType, …) or a raw JSON Schema object. */
  parameters: TParams;
  run: (args: ToolInputOf<TParams>, ctx: SkillInvocationContext) => TOutput | Promise<TOutput>;
}

/**
 * Declares a skill script with a typed parameter schema.
 *
 * ```ts
 * skillScript({
 *   name: 'convert',
 *   description: 'Converts a value between units',
 *   parameters: z.object({ value: z.number(), factor: z.number() }),
 *   run: ({ value, factor }) => value * factor,
 * });
 * ```
 *
 * The schema is both advertised to the model — it appears inside the skill body — and enforced:
 * arguments are validated against a Standard Schema before `run` sees them, so the callback
 * receives the schema's parsed output. A script that takes a positional argv, or none at all, can
 * implement {@link SkillScript} directly instead.
 *
 * @throws {SchemaResolutionError} When `parameters` cannot be converted to a JSON Schema.
 */
export function skillScript<TParams extends SchemaInput, TOutput = unknown>(
  config: SkillScriptConfig<TParams, TOutput>,
): SkillScript {
  const parametersSchema = resolveJsonSchema(config.parameters);
  const { parameters, run } = config;
  return {
    name: config.name,
    ...(config.description === undefined ? {} : { description: config.description }),
    parametersSchema,
    run: async (args: SkillScriptArguments, ctx: SkillInvocationContext): Promise<unknown> => {
      return await run(await validateScriptArguments(config.name, parameters, args), ctx);
    },
  };
}

/**
 * Validates the model's arguments against a script's schema.
 *
 * Rejection is a {@link ToolInvocationError}, which the function-calling loop turns into a result
 * the model reads — so a mistyped argument is something the model can correct rather than a failed
 * run.
 */
async function validateScriptArguments<TParams extends SchemaInput>(
  name: string,
  parameters: TParams,
  args: SkillScriptArguments,
): Promise<ToolInputOf<TParams>> {
  if (!isStandardSchema(parameters)) {
    return (args ?? {}) as ToolInputOf<TParams>;
  }
  const result = await parameters['~standard'].validate(args ?? {});
  if (result.issues !== undefined) {
    throw new ToolInvocationError(name, `Invalid arguments: ${formatSchemaIssues(result.issues)}`);
  }
  return result.value as ToolInputOf<TParams>;
}

/** What {@link inlineSkill} accepts. */
export interface InlineSkillConfig {
  name: string;
  description: string;
  /** The guidance the model reads once it loads the skill. */
  instructions: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  metadata?: Record<string, string>;
  resources?: readonly SkillResource[];
  scripts?: readonly SkillScript[];
}

/**
 * Declares a skill in code.
 *
 * ```ts
 * const unitConverter = inlineSkill({
 *   name: 'unit-converter',
 *   description: 'Converts between metric and imperial units.',
 *   instructions: 'Read the conversion-table resource, then run the convert script.',
 *   resources: [skillResource({ name: 'conversion-table', content: 'kg=2.205lb' })],
 *   scripts: [convertScript],
 * });
 * ```
 *
 * The body is synthesized: the instructions plus a listing of the resources and scripts the skill
 * offers, so the model learns their exact names instead of guessing them.
 *
 * @throws {ConfigurationError} When the name or description breaks a specification limit.
 */
export function inlineSkill(config: InlineSkillConfig): Skill {
  const frontmatter = skillFrontmatter(config);
  const resources = config.resources ?? [];
  const scripts = config.scripts ?? [];
  const content = [
    `<name>${xmlEscape(frontmatter.name)}</name>`,
    `<description>${xmlEscape(frontmatter.description)}</description>`,
    '',
    '<instructions>',
    config.instructions,
    '</instructions>',
    '',
    resourcesBlock(resources),
    '',
    scriptsBlock(scripts),
  ].join('\n');

  return skillFrom(frontmatter, content, resources, scripts);
}

/** What {@link markdownSkill} accepts. */
export interface MarkdownSkillConfig {
  /** A `SKILL.md` document: YAML frontmatter followed by the body. */
  markdown: string;
  resources?: readonly SkillResource[];
  scripts?: readonly SkillScript[];
}

/**
 * Builds a skill from a `SKILL.md` document.
 *
 * This is the bridge from skills authored as files to skills an agent can use. The core does not
 * walk directories — it has no filesystem — so the caller reads the file and attaches whatever
 * sibling files should be reachable as resources:
 *
 * ```ts
 * const skill = markdownSkill({
 *   markdown: await readFile(join(dir, 'SKILL.md'), 'utf8'),
 *   resources: [
 *     skillResource({
 *       name: 'references/pricing.md',
 *       read: () => readFile(join(dir, 'references/pricing.md'), 'utf8'),
 *     }),
 *   ],
 * });
 * ```
 *
 * The document is kept verbatim and a listing of the resources and scripts is appended, so the
 * model sees names it can actually pass to `read_skill_resource` and `run_skill_script`.
 *
 * ## Security considerations
 *
 * Resource names come from the model. A `read` callback that joins the name onto a directory path
 * must reject absolute paths and `..` segments itself — nothing between the model and the callback
 * does it for you.
 *
 * @throws {ConfigurationError} When the document has no frontmatter block, or its metadata breaks a
 * specification limit.
 */
export function markdownSkill(config: MarkdownSkillConfig): Skill {
  const { frontmatter } = parseSkillMarkdown(config.markdown);
  const resources = config.resources ?? [];
  const scripts = config.scripts ?? [];
  const content = `${config.markdown}\n\n${resourcesBlock(resources)}\n\n${scriptsBlock(scripts)}`;
  return skillFrom(frontmatter, content, resources, scripts);
}

function skillFrom(
  frontmatter: SkillFrontmatter,
  content: string,
  resources: readonly SkillResource[],
  scripts: readonly SkillScript[],
): Skill {
  return {
    frontmatter,
    getContent: () => content,
    getResource: (name: string) => byName(resources, name),
    getScript: (name: string) => byName(scripts, name),
  };
}

function byName<T extends { readonly name: string }>(items: readonly T[], name: string): T | undefined {
  const wanted = name.toLowerCase();
  return items.find((item) => item.name.toLowerCase() === wanted);
}

/**
 * Renders the resources a skill offers.
 *
 * An empty collection still produces an element — `<available_resources />` — because a model shown
 * nothing at all invents resource names, while a model shown an explicitly empty list does not.
 */
export function resourcesBlock(resources: readonly SkillResource[]): string {
  if (resources.length === 0) {
    return '<available_resources />';
  }
  const entries = resources.map((resource) => `  <resource ${attributes(resource)}/>`).join('\n');
  return `<available_resources>\n${entries}\n</available_resources>`;
}

/** Renders the scripts a skill offers, with each script's parameter schema when it declares one. */
export function scriptsBlock(scripts: readonly SkillScript[]): string {
  if (scripts.length === 0) {
    return '<available_scripts />';
  }
  const entries = scripts.map(scriptElement).join('\n');
  return `<available_scripts>\n${entries}\n</available_scripts>`;
}

function scriptElement(script: SkillScript): string {
  if (script.parametersSchema === undefined) {
    return `  <script ${attributes(script)}/>`;
  }
  const schema = xmlEscape(JSON.stringify(script.parametersSchema), false);
  return `  <script ${attributes(script)}>\n    <parameters_schema>${schema}</parameters_schema>\n  </script>`;
}

function attributes(item: { readonly name: string; readonly description?: string }): string {
  const name = `name="${xmlEscape(item.name)}"`;
  return item.description === undefined ? name : `${name} description="${xmlEscape(item.description)}"`;
}

/** Escapes text for XML. Quotes are escaped too unless the text sits between element tags. */
export function xmlEscape(text: string, quote = true): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return quote ? escaped.replace(/"/g, '&quot;').replace(/'/g, '&#x27;') : escaped;
}
