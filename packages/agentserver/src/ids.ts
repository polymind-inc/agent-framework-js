/**
 * Response and item id generation for the Responses container protocol.
 *
 * An id is `{prefix}_{partitionKey}{entropy}`. The partition key is what co-locates a
 * conversation in Foundry storage, so a new id derived from an existing one has to *inherit* it —
 * without that, a follow-up response lands in a different partition and the platform's own id
 * validation rejects it. Mirrors Python `_id_generator.py`.
 */

const PARTITION_KEY_HEX_LENGTH = 16;
const PARTITION_KEY_SUFFIX = '00';
const PARTITION_KEY_TOTAL_LENGTH = PARTITION_KEY_HEX_LENGTH + PARTITION_KEY_SUFFIX.length;
const ENTROPY_LENGTH = 32;
const BODY_LENGTH = PARTITION_KEY_TOTAL_LENGTH + ENTROPY_LENGTH;
/** Ids minted before the partition key moved to the front are still accepted. */
const LEGACY_BODY_LENGTH = 48;
const LEGACY_PARTITION_KEY_LENGTH = 16;

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Known id prefixes. `caresp` is a response; the rest are output items. */
export const ID_PREFIX = {
  response: 'caresp',
  message: 'msg',
  functionCall: 'fc',
  functionCallOutput: 'fco',
  reasoning: 'rs',
  fileSearchCall: 'fs',
  webSearchCall: 'ws',
  codeInterpreterCall: 'ci',
  imageGenerationCall: 'ig',
  mcpCall: 'mcp',
  mcpListTools: 'mcpl',
  mcpApprovalRequest: 'mcpr',
  customToolCall: 'ctc',
  customToolCallOutput: 'ctco',
  computerCall: 'cu',
  oauthConsentRequest: 'oacr',
} as const;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Lowercase hex encoding. Package-internal — not part of the public API. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

function generatePartitionKey(): string {
  return `${toHex(randomBytes(8))}${PARTITION_KEY_SUFFIX}`;
}

function generateEntropy(): string {
  let out = '';
  while (out.length < ENTROPY_LENGTH) {
    for (const byte of randomBytes(ENTROPY_LENGTH)) {
      // Rejection sampling keeps the distribution uniform over the alphabet.
      if (byte < 248) {
        out += ALPHANUMERIC[byte % ALPHANUMERIC.length];
        if (out.length === ENTROPY_LENGTH) {
          break;
        }
      }
    }
  }
  return out;
}

/** The partition key embedded in `id`, or `undefined` when it is not a well-formed id. */
export function partitionKeyOf(id: string | undefined): string | undefined {
  if (id === undefined || id === '') {
    return undefined;
  }
  const delimiter = id.indexOf('_');
  if (delimiter < 0) {
    return undefined;
  }
  const body = id.slice(delimiter + 1);
  if (body.length === BODY_LENGTH) {
    return body.slice(0, PARTITION_KEY_TOTAL_LENGTH);
  }
  if (body.length === LEGACY_BODY_LENGTH) {
    // Legacy ids carry the partition key at the end, and 16 chars rather than 18.
    return `${body.slice(-LEGACY_PARTITION_KEY_LENGTH)}${PARTITION_KEY_SUFFIX}`;
  }
  return undefined;
}

/**
 * Mints an id, inheriting the partition key of `partitionKeyHint` when it has one.
 *
 * @param prefix - One of {@link ID_PREFIX}.
 * @param partitionKeyHint - An id from the same conversation, typically `previous_response_id`
 * or the conversation id.
 */
export function newId(prefix: string, partitionKeyHint?: string): string {
  if (prefix === '') {
    throw new Error('An id prefix is required.');
  }
  return `${prefix}_${partitionKeyOf(partitionKeyHint) ?? generatePartitionKey()}${generateEntropy()}`;
}

/** Mints a response id (`caresp_…`). */
export function newResponseId(partitionKeyHint?: string): string {
  return newId(ID_PREFIX.response, partitionKeyHint);
}

/** Why an id was rejected, or `undefined` when it is well-formed. */
export function invalidIdReason(
  id: string | undefined,
  allowedPrefixes?: readonly string[],
): string | undefined {
  if (id === undefined || id === '') {
    return 'ID must not be null or empty.';
  }
  const delimiter = id.indexOf('_');
  if (delimiter < 0) {
    return `ID '${id}' has no '_' delimiter.`;
  }
  if (delimiter === 0) {
    return 'ID has an empty prefix.';
  }
  const body = id.slice(delimiter + 1);
  if (body.length !== BODY_LENGTH && body.length !== LEGACY_BODY_LENGTH) {
    return `ID '${id}' has unexpected body length ${body.length} (expected ${BODY_LENGTH} or ${LEGACY_BODY_LENGTH}).`;
  }
  const prefix = id.slice(0, delimiter);
  if (allowedPrefixes !== undefined && !allowedPrefixes.includes(prefix)) {
    return `ID prefix '${prefix}' is not in the allowed set [${allowedPrefixes.join(', ')}].`;
  }
  return undefined;
}

/** Whether `id` is a well-formed id, optionally of one of `allowedPrefixes`. */
export function isValidId(id: string | undefined, allowedPrefixes?: readonly string[]): boolean {
  return invalidIdReason(id, allowedPrefixes) === undefined;
}
