import type { Content } from '@polymind-inc/agent-framework-core';
import { unknownContent } from '@polymind-inc/agent-framework-core';

/** One entry of an MCP `CallToolResult.content`, kept loose so unmodelled blocks pass through. */
export type McpContentBlock = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Converts one MCP content block into framework content.
 *
 * The mapping follows the MCP content model:
 *
 * - `text` → `text`;
 * - `image` / `audio` → `data`, as the `data:` URI the framework carries binary in;
 * - `resource_link` → `uri`;
 * - `resource` → the embedded contents, inline text or blob;
 * - anything else → `unknown`, so a block from a newer protocol revision round-trips instead of
 *   being silently dropped.
 */
export function fromMcpContent(block: McpContentBlock): Content {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: str(block.text), rawRepresentation: block };
    case 'image':
    case 'audio': {
      const mediaType = str(block.mimeType);
      return {
        type: 'data',
        uri: `data:${mediaType};base64,${str(block.data)}`,
        mediaType,
        rawRepresentation: block,
      };
    }
    case 'resource_link': {
      const mediaType = str(block.mimeType);
      const name = str(block.name);
      return {
        type: 'uri',
        uri: str(block.uri),
        ...(mediaType === '' ? {} : { mediaType }),
        ...(name === '' ? {} : { name }),
        rawRepresentation: block,
      };
    }
    case 'resource': {
      const resource = block.resource;
      if (typeof resource !== 'object' || resource === null) {
        return unknownContent(block);
      }
      const embedded = resource as Record<string, unknown>;
      const mediaType = str(embedded.mimeType);
      if (typeof embedded.text === 'string') {
        return { type: 'text', text: embedded.text, rawRepresentation: block };
      }
      const blob = embedded.blob;
      if (typeof blob === 'string') {
        // `BlobResourceContents.mimeType` is optional, and an absent one would otherwise produce
        // the meaningless `data:;base64,...`. Python substitutes a default here and only here
        // (`_mcp.py`: `mime = item.resource.mimeType or "application/octet-stream"`), using it for
        // both the URI and the media type; `ImageContent`/`AudioContent` declare `mimeType` as
        // required and `ResourceLink` forwards `None`, so neither gets a default (do not make
        // this client more permissive than the reference implementation).
        const blobMediaType = mediaType === '' ? 'application/octet-stream' : mediaType;
        // The MCP schema says `blob` is base64, but a server that hands back a full data URI
        // must not have a second `data:` prefix stapled on — the reference implementation
        // guards the same way, and only here (`_mcp.py`, `BlobResourceContents` branch).
        return {
          type: 'data',
          uri: blob.startsWith('data:') ? blob : `data:${blobMediaType};base64,${blob}`,
          mediaType: blobMediaType,
          rawRepresentation: block,
        };
      }
      // An embedded resource with neither `text` nor `blob` — what a newer protocol revision's
      // resource contents look like. Same helper as every other unmodelled block, so the
      // serialized shape stays flat and round-trips.
      return unknownContent(block);
    }
    default:
      return unknownContent(block);
  }
}

/**
 * The `additionalProperties` an MCP result's `_meta` envelope contributes, or `undefined`.
 *
 * A server may attach `_meta` to a tool result — Information Flow Control labels, for instance.
 * The reference implementation copies it onto every content item it produced from that result
 * (`_parse_tool_result_from_mcp` in Python's `_mcp.py`, `additional_properties["_meta"]`) so that
 * downstream layers can derive per-item security labels; the key is deliberately generic, so any
 * server's `_meta` keys — current or future — survive to be interpreted higher up.
 *
 * An absent or empty envelope contributes nothing, matching Python's `if meta:` guard: an ordinary
 * result must not grow an empty `additionalProperties` that then round-trips through every
 * serialized session.
 */
export function mcpMetaProperties(
  meta: unknown,
): { additionalProperties: Record<string, unknown> } | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return undefined;
  }
  const entries = { ...(meta as Record<string, unknown>) };
  return Object.keys(entries).length === 0 ? undefined : { additionalProperties: { _meta: entries } };
}

/**
 * Converts an MCP tool result's content list.
 *
 * `meta` is the result's `_meta` envelope; see {@link mcpMetaProperties} for how it is carried.
 */
export function fromMcpContents(blocks: readonly unknown[] | undefined, meta?: unknown): Content[] {
  const stamp = mcpMetaProperties(meta);
  const contents: Content[] = [];
  for (const block of blocks ?? []) {
    if (typeof block === 'object' && block !== null) {
      contents.push(fromMcpContent(block as McpContentBlock));
    }
  }
  return stamp === undefined ? contents : contents.map((content) => ({ ...content, ...stamp }));
}
