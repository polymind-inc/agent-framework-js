import type {
  CreateResponseRequest,
  JsonObject,
  OutputItem,
  ResponseUsage,
} from '@polymind-inc/agent-framework-agentserver';
import type { ChatOptions, Content, Message, UsageDetails } from '@polymind-inc/agent-framework-core';
import { unknownContent, uriContent } from '@polymind-inc/agent-framework-core';
// The `./internal` entry shares the wire mappers without evaluating the OpenAI SDK, which the
// hosting adapter never needs — replay must stay cheap to load inside the hosted container.
import {
  codeInterpreterCallContents,
  mcpCallContents,
  searchCallContents,
} from '@polymind-inc/agent-framework-openai/internal';

/**
 * The label the framework declares itself under when it surfaces an approval as MCP's.
 *
 * Also the marker that separates "an approval this container raised" from "an approval a hosted
 * MCP server raised", which decide opposite things: the first is executed here, the second is
 * relayed to the model provider untouched.
 */
export const AGENT_FRAMEWORK_SERVER_LABEL = 'agent_framework';

/**
 * Encodes a tool result for `function_call_output.output`.
 *
 * The Responses spec says `output` is a **JSON string**, so the value is stringified twice: once
 * to get the inner text, once to quote it. Both halves matter:
 *
 * - a structured result (an array, an object) sent unquoted is rejected outright by strict
 *   clients — "requires an element of type 'String'";
 * - a result that merely *looks* like JSON (`"42"`, `'{"k":1}'`) sent unquoted silently changes
 *   type on the wire, arriving as a number or an object.
 *
 * Mirrors .NET `OutputConverter.EncodeFunctionResultAsJsonStringPayload`.
 */
export function encodeFunctionOutput(result: unknown): string {
  let inner: string;
  if (result === undefined || result === null) {
    inner = '';
  } else if (typeof result === 'string') {
    inner = result;
  } else {
    inner = JSON.stringify(result) ?? '';
  }
  return JSON.stringify(inner);
}

/**
 * Decodes `function_call_output.output` back to the tool result.
 *
 * Symmetric with {@link encodeFunctionOutput}. A payload that is not a JSON string is passed
 * through unchanged, which tolerates producers that emitted a raw JSON value.
 */
export function decodeFunctionOutput(output: unknown): string {
  if (typeof output !== 'string' || output === '') {
    return output === undefined || output === null ? '' : String(output);
  }
  try {
    const parsed: unknown = JSON.parse(output);
    return typeof parsed === 'string' ? parsed : output;
  } catch {
    return output;
  }
}

/**
 * Converts one message content part to a framework {@link Content}.
 *
 * Beyond text, the input shapes carry images and files (`input_image` / `input_file`), which the
 * model must see on replay: dropping them silently would have the agent answer as though the
 * caller sent only the words (Python converts the same shapes in `_message_content_to_content`).
 */
function partToContent(part: JsonObject): Content | undefined {
  switch (part?.type) {
    case 'input_text':
    case 'output_text':
    case 'summary_text':
      return typeof part.text === 'string'
        ? { type: 'text', text: part.text, rawRepresentation: part }
        : undefined;
    case 'refusal':
      return typeof part.refusal === 'string'
        ? { type: 'text', text: part.refusal, rawRepresentation: part }
        : undefined;
    case 'input_image': {
      const url = part.image_url;
      if (typeof url === 'string' && url !== '') {
        // A data URI carries its own media type; a plain URL only says "an image".
        const content = url.startsWith('data:') ? uriContent(url) : uriContent(url, 'image/*');
        return { ...content, rawRepresentation: part };
      }
      const fileId = part.file_id;
      return typeof fileId === 'string' && fileId !== ''
        ? { type: 'hosted_file', fileId, rawRepresentation: part }
        : undefined;
    }
    case 'input_file': {
      const fileUrl = part.file_url;
      if (typeof fileUrl === 'string' && fileUrl !== '') {
        return { ...uriContent(fileUrl), rawRepresentation: part };
      }
      const fileId = part.file_id;
      if (typeof fileId === 'string' && fileId !== '') {
        const filename = part.filename;
        return {
          type: 'hosted_file',
          fileId,
          rawRepresentation: part,
          ...(typeof filename === 'string' && filename !== '' ? { additionalProperties: { filename } } : {}),
        };
      }
      const fileData = part.file_data;
      if (typeof fileData === 'string' && fileData !== '') {
        return fileData.startsWith('data:')
          ? { ...uriContent(fileData), rawRepresentation: part }
          : {
              type: 'data',
              uri: `data:application/octet-stream;base64,${fileData}`,
              mediaType: 'application/octet-stream',
              rawRepresentation: part,
            };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Converts a message item's `content` — a string, or a list of parts — into contents. */
function contentsOfMessage(parts: unknown, item: OutputItem): Content[] {
  if (typeof parts === 'string') {
    return [{ type: 'text', text: parts, rawRepresentation: item }];
  }
  const contents: Content[] = [];
  if (Array.isArray(parts)) {
    for (const part of parts as JsonObject[]) {
      const content = partToContent(part);
      if (content !== undefined) {
        contents.push(content);
      }
    }
  }
  // A message whose parts are all unrepresentable is still a message: replay it as its text
  // (possibly empty) rather than silently deleting the turn from the transcript.
  return contents.length > 0
    ? contents
    : [{ type: 'text', text: textOfContentParts(parts), rawRepresentation: item }];
}

function textOfContentParts(parts: unknown): string {
  if (typeof parts === 'string') {
    return parts;
  }
  if (!Array.isArray(parts)) {
    return '';
  }
  let text = '';
  for (const part of parts as JsonObject[]) {
    const value = part?.text ?? part?.refusal;
    if (typeof value === 'string') {
      text += value;
    }
  }
  return text;
}

function parseArguments(raw: unknown): Record<string, unknown> | string {
  if (typeof raw !== 'string') {
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : '';
  }
  return raw;
}

/**
 * Converts one Responses input or output item into a framework message.
 *
 * Returns `undefined` only for items that are deliberately not replayed because another mechanism
 * already carries their meaning: this container's own approval requests (`ApprovalStorage`),
 * approval decisions (`approvalResponseTarget`), and item references (which point at service-held
 * items this container cannot dereference). Every other item is converted — an item type this
 * build does not model is preserved as unknown content rather than deleted from the transcript,
 * so replaying a stored response never silently loses what the model said or did.
 */
export function itemToMessage(item: OutputItem): Message | undefined {
  switch (item.type) {
    case 'message': {
      const role = typeof item.role === 'string' ? item.role : 'user';
      const contents = contentsOfMessage(item.content, item);
      return { role, contents, ...(typeof item.id === 'string' ? { messageId: item.id } : {}) };
    }

    case 'output_message': {
      // An assistant turn under its dedicated wire type; the parts are the same message shapes.
      const contents = contentsOfMessage(item.content, item);
      return {
        role: typeof item.role === 'string' ? item.role : 'assistant',
        contents,
        ...(typeof item.id === 'string' ? { messageId: item.id } : {}),
      };
    }

    case 'function_call':
      return {
        role: 'assistant',
        contents: [
          {
            type: 'function_call',
            callId: typeof item.call_id === 'string' ? item.call_id : (item.id ?? ''),
            name: typeof item.name === 'string' ? item.name : '',
            arguments: parseArguments(item.arguments),
            rawRepresentation: item,
          },
        ],
      };

    case 'function_call_output':
      return {
        role: 'tool',
        contents: [
          {
            type: 'function_result',
            callId: typeof item.call_id === 'string' ? item.call_id : '',
            result: decodeFunctionOutput(item.output),
            rawRepresentation: item,
          },
        ],
      };

    case 'reasoning': {
      const encrypted = item.encrypted_content;
      const content: Content = {
        type: 'text_reasoning',
        text: textOfContentParts(item.summary ?? item.content),
        rawRepresentation: item,
      };
      if (typeof item.id === 'string') content.id = item.id;
      if (typeof encrypted === 'string') content.protectedData = encrypted;
      return { role: 'assistant', contents: [content] };
    }

    case 'mcp_call':
      // A provider-run MCP call from an earlier turn. Restored so the model keeps seeing what the
      // tool was asked and what it returned; dropping it would have the model re-call the tool or
      // contradict its own transcript. The openai package's mapper is the single implementation,
      // so the provider-bound re-send path treats a replayed call and a live one identically.
      return { role: 'assistant', contents: mcpCallContents(item) };

    case 'mcp_approval_request': {
      const serverLabel = typeof item.server_label === 'string' ? item.server_label : '';
      if (serverLabel === '' || serverLabel === AGENT_FRAMEWORK_SERVER_LABEL) {
        // This container's *own* approval request, echoed back to it. It is deliberately not
        // replayed: the item carries no call id, so rebuilding a `function_call` from it means
        // inventing one, and the reconstructed request would then compete with the record the
        // human was actually shown. The authoritative copy lives in `ApprovalStorage`, keyed by
        // this item's id.
        return undefined;
      }
      // A genuinely hosted (provider-side) MCP approval. `server_label` is what marks it as one,
      // so core passes it through to the API instead of trying to execute it locally.
      const id = typeof item.id === 'string' ? item.id : '';
      return {
        role: 'assistant',
        contents: [
          {
            type: 'function_approval_request',
            id,
            userInputRequest: true,
            functionCall: {
              type: 'function_call',
              callId: id,
              name: typeof item.name === 'string' ? item.name : '',
              arguments: parseArguments(item.arguments),
              additionalProperties: { server_label: serverLabel },
            },
            rawRepresentation: item,
          },
        ],
      };
    }

    case 'oauth_consent_request': {
      // A consent request from an earlier turn. Replayed as
      // the core consent content so `userInputRequests` keeps surfacing it until the user acts
      // (Python `_output_item_to_message`: `Content.from_oauth_consent_request`).
      const consentLink = typeof item.consent_link === 'string' ? item.consent_link : '';
      return {
        role: 'assistant',
        contents: [
          { type: 'oauth_consent_request', consentLink, userInputRequest: true, rawRepresentation: item },
        ],
      };
    }

    case 'image_generation_call':
      // Replayed as the *call* only, keyed by the item id — the base64 result is not carried
      // back into the transcript (Python `from_image_generation_tool_call(image_id=ig.id)`).
      return {
        role: 'assistant',
        contents: [
          {
            type: 'image_generation_tool_call',
            ...(typeof item.id === 'string' ? { imageId: item.id } : {}),
            rawRepresentation: item,
          },
        ],
      };

    case 'shell_call': {
      const action = item.action as { commands?: unknown } | undefined;
      const commands = Array.isArray(action?.commands)
        ? action.commands.filter((command): command is string => typeof command === 'string')
        : [];
      return {
        role: 'assistant',
        contents: [
          {
            type: 'shell_tool_call',
            callId: typeof item.call_id === 'string' ? item.call_id : (item.id ?? ''),
            commands,
            ...(typeof item.status === 'string' ? { status: item.status } : {}),
            rawRepresentation: item,
          },
        ],
      };
    }

    case 'shell_call_output': {
      const entries = Array.isArray(item.output) ? (item.output as JsonObject[]) : [];
      const outputs: Content[] = entries.map((entry) => {
        const exitCode = (entry?.outcome as { exit_code?: unknown } | undefined)?.exit_code;
        return {
          type: 'shell_command_output',
          stdout: typeof entry?.stdout === 'string' ? entry.stdout : '',
          stderr: typeof entry?.stderr === 'string' ? entry.stderr : '',
          ...(typeof exitCode === 'number' ? { exitCode } : {}),
          rawRepresentation: entry,
        };
      });
      const maxOutputLength = item.max_output_length;
      return {
        role: 'tool',
        contents: [
          {
            type: 'shell_tool_result',
            callId: typeof item.call_id === 'string' ? item.call_id : '',
            outputs,
            ...(typeof maxOutputLength === 'number' ? { maxOutputLength } : {}),
            rawRepresentation: item,
          },
        ],
      };
    }

    case 'custom_tool_call_output': {
      // Hosted-MCP results are persisted as `custom_tool_call_output` (see `OutputBuilder.push`);
      // a call id carrying the `mcp_` prefix routes back to a hosted-MCP result content, anything
      // else replays as an ordinary function result (Python `_item_to_message`, issue #5546).
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      const raw = item.output;
      const output = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw);
      if (callId.startsWith('mcp_')) {
        return {
          role: 'tool',
          contents: [
            {
              type: 'mcp_server_tool_result',
              callId,
              output: [{ type: 'text', text: output, rawRepresentation: item }],
              rawRepresentation: item,
            },
          ],
        };
      }
      return {
        role: 'tool',
        contents: [{ type: 'function_result', callId, result: output, rawRepresentation: item }],
      };
    }

    case 'web_search_call':
    case 'file_search_call':
      // Both halves of a provider-run search live on one item; the openai package's mapper is
      // the single implementation, like `mcp_call`.
      return { role: 'assistant', contents: searchCallContents(item) };

    case 'code_interpreter_call':
      return { role: 'assistant', contents: codeInterpreterCallContents(item) };

    case 'local_shell_call': {
      // The exec action's field is `command` (a list), unlike `shell_call`'s `commands`.
      const action = item.action as { command?: unknown } | undefined;
      const commands = Array.isArray(action?.command)
        ? action.command.filter((command): command is string => typeof command === 'string')
        : [];
      return {
        role: 'assistant',
        contents: [
          {
            type: 'shell_tool_call',
            callId: typeof item.call_id === 'string' ? item.call_id : (item.id ?? ''),
            commands,
            ...(typeof item.status === 'string' ? { status: item.status } : {}),
            rawRepresentation: item,
          },
        ],
      };
    }

    case 'local_shell_call_output':
      // The wire item carries no `call_id`; its own id is the correlation key (Python replays
      // `call_id=lsco.id` the same way).
      return {
        role: 'tool',
        contents: [
          {
            type: 'shell_tool_result',
            callId: typeof item.id === 'string' ? item.id : '',
            outputs: [
              {
                type: 'shell_command_output',
                stdout: typeof item.output === 'string' ? item.output : '',
                stderr: '',
                rawRepresentation: item,
              },
            ],
            rawRepresentation: item,
          },
        ],
      };

    case 'computer_call':
      // Reported for information only, under a well-known name — this container cannot re-drive
      // a computer-use session, but the model must keep seeing what it did. The action stays a
      // structured object: stringifying it would make the arguments unparseable on the next hop.
      return {
        role: 'assistant',
        contents: [
          {
            type: 'function_call',
            callId: typeof item.call_id === 'string' ? item.call_id : (item.id ?? ''),
            name: 'computer_use',
            arguments: parseArguments(item.action),
            informationalOnly: true,
            rawRepresentation: item,
          },
        ],
      };

    case 'computer_call_output':
      return {
        role: 'tool',
        contents: [
          {
            type: 'function_result',
            callId: typeof item.call_id === 'string' ? item.call_id : '',
            // The screenshot payload stays structured for the same reason the call's action does.
            result: item.output ?? '',
            rawRepresentation: item,
          },
        ],
      };

    case 'custom_tool_call':
      return {
        role: 'assistant',
        contents: [
          {
            type: 'function_call',
            callId: typeof item.call_id === 'string' ? item.call_id : (item.id ?? ''),
            name: typeof item.name === 'string' ? item.name : '',
            arguments: parseArguments(item.input),
            informationalOnly: true,
            rawRepresentation: item,
          },
        ],
      };

    case 'apply_patch_call':
      return {
        role: 'assistant',
        contents: [
          {
            type: 'function_call',
            callId: typeof item.call_id === 'string' ? item.call_id : (item.id ?? ''),
            name: 'apply_patch',
            arguments: parseArguments(item.operation),
            informationalOnly: true,
            rawRepresentation: item,
          },
        ],
      };

    case 'apply_patch_call_output':
      return {
        role: 'tool',
        contents: [
          {
            type: 'function_result',
            callId: typeof item.call_id === 'string' ? item.call_id : '',
            result: typeof item.output === 'string' ? item.output : '',
            rawRepresentation: item,
          },
        ],
      };

    case 'structured_outputs': {
      // Replayed as its JSON text, which is exactly what the model produced.
      const output = item.output;
      const text = typeof output === 'string' ? output : (JSON.stringify(output) ?? '');
      return { role: 'assistant', contents: [{ type: 'text', text, rawRepresentation: item }] };
    }

    case 'mcp_approval_response':
      // Consumed out of band: `approvalResponseTarget` binds the decision to the stored request.
      // Replaying it as content too would answer the same approval twice.
      return undefined;

    case 'item_reference':
      // A pointer to a service-held item this container cannot dereference (.NET drops it the
      // same way).
      return undefined;

    default:
      // An item type this build does not model is preserved verbatim rather than dropped — the
      // transcript survives a round trip through a newer producer, and the model keeps whatever
      // the framework can represent of it.
      return { role: 'assistant', contents: [unknownContent(item)] };
  }
}

/**
 * Converts accumulated framework usage into the wire `usage` object.
 *
 * Field mapping mirrors .NET `OutputConverter.ConvertUsage` — the priority reference for usage
 * accumulation (Python hosting does not carry usage at all): input/output/total counts plus the
 * cached-input and reasoning-output detail counters.
 */
export function usageToResponseUsage(details: UsageDetails): ResponseUsage {
  return {
    input_tokens: details.inputTokenCount ?? 0,
    output_tokens: details.outputTokenCount ?? 0,
    total_tokens: details.totalTokenCount ?? 0,
    input_tokens_details: { cached_tokens: details.cacheReadInputTokenCount ?? 0 },
    output_tokens_details: { reasoning_tokens: details.reasoningOutputTokenCount ?? 0 },
  };
}

/** Converts a request's `input` (a string, or a list of items) into messages. */
export function inputToMessages(input: unknown): Message[] {
  if (typeof input === 'string') {
    return input === '' ? [] : [{ role: 'user', contents: [{ type: 'text', text: input }] }];
  }
  if (!Array.isArray(input)) {
    return [];
  }
  const messages: Message[] = [];
  for (const item of input as OutputItem[]) {
    const message = itemToMessage(item);
    if (message !== undefined) {
      messages.push(message);
    }
  }
  return messages;
}

/** What {@link requestToChatOptions} produces: portable options plus the one provider knob. */
export type HostedChatOptions = Partial<ChatOptions> & { parallelToolCalls?: boolean };

/**
 * The only request fields that become {@link ChatOptions}.
 *
 * Four, deliberately. `model` in particular is **ignored**: a hosted agent brings its own model,
 * and honouring the caller's would let a request redirect the agent to a different deployment.
 *
 * `parallel_tool_calls` becomes a **named option**, not an `additionalProperties` entry.
 * `additionalProperties` is copied onto the provider request verbatim, so the camelCase key would
 * reach the wire as `parallelToolCalls` — an unknown parameter the Responses API rejects with a
 * 400, failing the whole turn just because the caller set the flag.
 */
export function requestToChatOptions(request: CreateResponseRequest): HostedChatOptions {
  const options: HostedChatOptions = {};
  if (typeof request.temperature === 'number') options.temperature = request.temperature;
  if (typeof request.top_p === 'number') options.topP = request.top_p;
  if (typeof request.max_output_tokens === 'number') options.maxTokens = request.max_output_tokens;
  if (typeof request.parallel_tool_calls === 'boolean') {
    options.parallelToolCalls = request.parallel_tool_calls;
  }
  return options;
}

/** Resolves an `mcp_approval_response` item to the id of the request it answers. */
export function approvalResponseTarget(item: OutputItem): { id: string; approved: boolean } | undefined {
  if (item.type !== 'mcp_approval_response') {
    return undefined;
  }
  const id = item.approval_request_id;
  return typeof id === 'string' ? { id, approved: item.approve === true } : undefined;
}
