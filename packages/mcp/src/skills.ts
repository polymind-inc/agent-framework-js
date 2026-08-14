import type { ReadResourceResult } from '@modelcontextprotocol/client';
import { ProtocolError, ResourceNotFoundError } from '@modelcontextprotocol/client';
import type {
  Content,
  Skill,
  SkillAccessOptions,
  SkillFrontmatter,
  SkillInvocationContext,
  SkillResource,
  SkillsSource,
  SkillsSourceContext,
} from '@polymind-inc/agent-framework-core';
import { AgentFrameworkError, dataContent, skillFrontmatter } from '@polymind-inc/agent-framework-core';

/**
 * The one capability skill discovery needs from a connection.
 *
 * {@link McpConnection} satisfies it as-is. Taking the narrower shape lets a caller interpose —
 * the Foundry toolbox wraps its connection to retype the gateway's consent refusals — without
 * this module knowing anything about it.
 */
export interface McpResourceReader {
  readResource(uri: string, options?: { signal?: AbortSignal }): Promise<ReadResourceResult>;
}

/** The well-known resource an MCP server publishes its skill catalogue at. */
const INDEX_URI = 'skill://index.json';

/** The only index entry type this source builds skills from. */
const SKILL_MD_TYPE = 'skill-md';

/** The suffix a skill's entry URL ends with; stripping it yields the skill's namespace root. */
const SKILL_MD_SUFFIX = 'SKILL.md';

/** Configuration for {@link mcpSkillsSource}. */
export interface McpSkillsSourceConfig {
  /** The catalogue resource to read. Defaults to `skill://index.json`. */
  indexUri?: string;
  /** Names this source in the failures it reports. Defaults to the index URI. */
  origin?: string;
}

/** One entry of the discovery document, before any of it has been validated. */
interface SkillIndexEntry {
  name?: unknown;
  type?: unknown;
  description?: unknown;
  url?: unknown;
}

/**
 * Discovers Agent Skills served over MCP.
 *
 * The source reads the server's `skill://index.json` and turns every `skill-md` entry into a skill.
 * Nothing else is fetched during discovery: a catalogue of fifty skills costs one round trip, and a
 * skill's `SKILL.md` body — along with any resource it references — is read only once the model
 * asks for it.
 *
 * ```ts
 * const connection = new McpConnection({ url });
 * const agent = new Agent({
 *   client,
 *   contextProviders: [skillsProvider(mcpSkillsSource(connection))],
 * });
 * ```
 *
 * A server that publishes no index — or publishes one that is empty or unparseable — contributes no
 * skills, so pointing this at a server that has none is harmless. A server that answers the index
 * request with a *failure*, such as an authorization error, is a different matter and surfaces to
 * the caller; an agent quietly running without the skills it was configured with is worse than one
 * that reports why it cannot.
 *
 * Entries this source cannot use — a `type` it does not implement, a missing field, a name the
 * specification rejects — are skipped individually and reported through the provider's
 * `onSkillError`. `archive` entries fall in that category: unpacking one needs ZIP and TAR readers
 * that neither this package nor the core is willing to depend on.
 *
 * ## Security considerations
 *
 * Everything this source produces is written by the MCP server: skill names, descriptions, bodies
 * and resource content all land in the model's context verbatim. A hostile or compromised server
 * can use them to steer the agent — the classic indirect prompt injection — so connect only to
 * servers you trust, and treat the agent's authority as the server's.
 */
export function mcpSkillsSource(
  connection: McpResourceReader,
  config: McpSkillsSourceConfig = {},
): SkillsSource {
  const indexUri = config.indexUri ?? INDEX_URI;
  const origin = config.origin ?? indexUri;

  return {
    getSkills: async (ctx: SkillsSourceContext): Promise<readonly Skill[]> => {
      const entries = await readIndex(connection, indexUri, ctx);
      const skills: Skill[] = [];
      for (const entry of entries) {
        const skill = buildSkill(connection, entry, origin, ctx);
        if (skill !== undefined) {
          skills.push(skill);
        }
      }
      return skills;
    },
  };
}

/**
 * Reads and parses the discovery document.
 *
 * "The server has no skills" and "the server refused to answer" are deliberately different
 * outcomes: the first is an empty list, the second is an exception.
 */
async function readIndex(
  connection: McpResourceReader,
  indexUri: string,
  ctx: SkillsSourceContext,
): Promise<SkillIndexEntry[]> {
  let result: ReadResourceResult;
  try {
    result = await connection.readResource(
      indexUri,
      ctx.signal === undefined ? undefined : { signal: ctx.signal },
    );
  } catch (error) {
    if (isResourceMissing(error)) {
      return [];
    }
    throw error;
  }

  const text = joinText(result);
  if (text === '') {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    ctx.reportSkillError({ origin: indexUri, error });
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) {
    ctx.reportSkillError({
      origin: indexUri,
      error: new AgentFrameworkError(`${indexUri} must contain a JSON object.`),
    });
    return [];
  }
  const skills = (parsed as { skills?: unknown }).skills;
  return Array.isArray(skills) ? (skills.filter(isRecord) as SkillIndexEntry[]) : [];
}

function isRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Builds one skill, or reports why the entry was skipped and returns `undefined`. */
function buildSkill(
  connection: McpResourceReader,
  entry: SkillIndexEntry,
  origin: string,
  ctx: SkillsSourceContext,
): Skill | undefined {
  const named = typeof entry.name === 'string' ? entry.name : undefined;
  const type = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
  const skip = (reason: string): undefined => {
    ctx.reportSkillError({
      ...(named === undefined ? {} : { skill: named }),
      origin,
      error: new AgentFrameworkError(reason),
    });
    return undefined;
  };

  if (type !== SKILL_MD_TYPE) {
    return skip(
      `Skipping skill index entry '${named ?? '(unnamed)'}': unsupported type '${entry.type ?? '(none)'}'.`,
    );
  }
  if (typeof entry.url !== 'string' || entry.url.trim() === '') {
    return skip(`Skipping skill index entry '${named ?? '(unnamed)'}': missing 'url'.`);
  }

  let frontmatter: SkillFrontmatter;
  try {
    frontmatter = skillFrontmatter({
      name: named ?? '',
      description: typeof entry.description === 'string' ? entry.description : '',
    });
  } catch (error) {
    return skip(
      `Skipping skill index entry '${named ?? '(unnamed)'}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return mcpSkill(connection, frontmatter, entry.url);
}

/** A skill whose body and resources live on the MCP server. */
function mcpSkill(connection: McpResourceReader, frontmatter: SkillFrontmatter, url: string): Skill {
  const root = skillRootUri(url);
  // The body does not change for the lifetime of the discovered skill, so a model that loads the
  // same skill twice in a conversation pays for one round trip.
  let content: string | undefined;

  return {
    frontmatter,
    getContent: async (options?: SkillAccessOptions): Promise<string> => {
      if (content !== undefined) {
        return content;
      }
      const result = await connection.readResource(url, options);
      const text = joinText(result);
      if (text === '') {
        throw new AgentFrameworkError(
          `The MCP server returned no text content for the SKILL.md resource '${url}'.`,
        );
      }
      content = text;
      return text;
    },
    getResource: async (name: string, options?: SkillAccessOptions): Promise<SkillResource | undefined> => {
      const relative = safeResourceName(name);
      if (relative === undefined) {
        return undefined;
      }
      const uri = root + relative;
      let result: ReadResourceResult;
      try {
        result = await connection.readResource(uri, options);
      } catch (error) {
        if (isResourceMissing(error)) {
          return undefined;
        }
        throw error;
      }
      return {
        name,
        read: (ctx: SkillInvocationContext): string | Content[] | null => {
          ctx.signal?.throwIfAborted();
          return resourceContent(result);
        },
      };
    },
  };
}

/**
 * Strips the trailing `SKILL.md` so sibling resources resolve against the skill's own namespace.
 *
 * A URL that does not end in `SKILL.md` is treated as the namespace itself.
 */
function skillRootUri(url: string): string {
  if (url.endsWith(SKILL_MD_SUFFIX)) {
    return url.slice(0, -SKILL_MD_SUFFIX.length);
  }
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Normalizes a resource name, refusing the shapes that would leave the skill's namespace.
 *
 * The server resolves the URI and is the authority on what it will serve, but a name the model
 * composed should not be forwarded when it is visibly an escape attempt: an absolute path, an
 * embedded scheme, or a `..` segment.
 */
function safeResourceName(name: string): string | undefined {
  const normalized = name.replaceAll('\\', '/');
  // A downstream server or URI library may decode once or more before resolving the path. Run the
  // same checks over every decoded stage so `%2e%2e` and double-encoded variants cannot become
  // traversal only after they cross this trust boundary — but the decoding is inspection only:
  // the name the server listed is the name it serves, so on success the request goes out with the
  // original name, not a decoded one.
  let stage = normalized;
  for (let depth = 0; depth < 4; depth++) {
    if (stage.startsWith('/') || stage.includes('://') || stage.split('/').includes('..')) {
      return undefined;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(stage).replaceAll('\\', '/');
    } catch {
      // Not valid percent-encoding, so no downstream decoder can unwrap it further either: the
      // stages checked so far are all there are.
      return normalized;
    }
    if (decoded === stage) return normalized;
    stage = decoded;
  }
  return undefined;
}

/** The text of every text block in a read result, joined; `''` when there is none. */
function joinText(result: ReadResourceResult): string {
  const texts: string[] = [];
  for (const entry of result.contents) {
    if ('text' in entry && typeof entry.text === 'string') {
      texts.push(entry.text);
    }
  }
  return texts.join('\n');
}

/**
 * Turns a read result into something a tool can return, ordered as the reference implementations
 * order it: the first binary block wins, text is the answer only when there is no binary content,
 * and a result with neither is `null`.
 *
 * The binary block comes back as data content rather than a base64 blob in a string, so an image
 * or a PDF reaches the model as an attachment it can actually read.
 */
function resourceContent(result: ReadResourceResult): string | Content[] | null {
  for (const entry of result.contents) {
    if ('blob' in entry && typeof entry.blob === 'string') {
      return [dataContent(stripDataUri(entry.blob), blobMediaType(entry.blob, entry.mimeType))];
    }
  }
  const text = joinText(result);
  return text === '' ? null : text;
}

/** Some servers send a whole `data:` URI where the protocol asks for bare base64. */
function stripDataUri(blob: string): string {
  return blob.startsWith('data:') ? (blob.split(',', 2)[1] ?? '') : blob;
}

/**
 * The media type of a blob: the protocol's `mimeType` field when the server filled it in, the type
 * inside a `data:` URI when it sent one of those instead, and the generic fallback otherwise.
 */
function blobMediaType(blob: string, mimeType: string | undefined): string {
  if (mimeType !== undefined) {
    return mimeType;
  }
  const match = /^data:([^;,]+)[;,]/.exec(blob);
  return match?.[1] ?? 'application/octet-stream';
}

/** The code older servers answered a missing resource with, before the SDK settled on the typed error. */
const LEGACY_RESOURCE_NOT_FOUND = -32002;

/** The JSON-RPC code for a method the server does not implement. */
const METHOD_NOT_FOUND = -32601;

/**
 * Whether an error means "there is nothing at that URI", as opposed to a real failure.
 *
 * The SDK reconstructs {@link ResourceNotFoundError} for the codes a missing resource is reported
 * with, and the check is brand-matched so it survives a separately bundled copy of the SDK. Two
 * cases sit outside it: a server that does not implement `resources/read` at all, which for skill
 * discovery is indistinguishable from a server with no skills, and an older server that answered
 * `-32002` without echoing the URI, which the SDK leaves as a plain protocol error.
 *
 * Everything else — invalid params, an authorization rejection, a crashing handler — is a failure.
 * Reading those as "no skills" would turn a misconfigured server into an agent that silently lost
 * the instructions it was configured with.
 */
function isResourceMissing(error: unknown): boolean {
  if (error instanceof ResourceNotFoundError) {
    return true;
  }
  if (!(error instanceof ProtocolError)) {
    return false;
  }
  return error.code === METHOD_NOT_FOUND || error.code === LEGACY_RESOURCE_NOT_FOUND;
}
