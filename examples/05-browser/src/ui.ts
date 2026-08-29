/** Small DOM and storage helpers shared by every page of this example. */

export function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) {
    throw new Error(`Missing element: ${selector}`);
  }
  return found;
}

export type BubbleKind = 'user' | 'assistant' | 'error';

export function bubble(log: HTMLElement, kind: BubbleKind, text = ''): HTMLElement {
  const el = document.createElement('div');
  el.className = `bubble ${kind}`;
  el.textContent = text;
  log.append(el);
  el.scrollIntoView({ block: 'end' });
  return el;
}

/**
 * An assistant bubble that appears on the first streamed chunk and grows by mutating a single
 * text node, so a long response stays one DOM node instead of one per chunk.
 */
export function streamingBubble(log: HTMLElement): {
  append(chunk: string): void;
  text(): string;
  remove(): void;
} {
  let el: HTMLElement | undefined;
  let node: Text | undefined;
  return {
    append(chunk: string): void {
      if (el === undefined || node === undefined) {
        el = bubble(log, 'assistant');
        node = document.createTextNode('');
        el.append(node);
      }
      node.appendData(chunk);
      el.scrollIntoView({ block: 'end' });
    },
    text: (): string => node?.data ?? '',
    remove: (): void => el?.remove(),
  };
}

export function chip(log: HTMLElement, text: string): void {
  const el = document.createElement('div');
  el.className = 'chip';
  el.textContent = text;
  log.append(el);
  el.scrollIntoView({ block: 'end' });
}

export function loadJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private windows, quota); the page works without persistence.
  }
}

export function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable; there is then nothing to remove.
  }
}

export interface Settings {
  apiKey: string;
  baseURL: string;
  model: string;
}

/** Read the API key / base URL / model row every page shares; throws until a key is entered. */
export function readSettings(defaultModel: string): Settings {
  const apiKeyInput = element<HTMLInputElement>('#api-key');
  const apiKey = apiKeyInput.value.trim();
  if (apiKey === '') {
    apiKeyInput.focus();
    throw new Error('Enter an API key first.');
  }
  return {
    apiKey,
    baseURL: element<HTMLInputElement>('#base-url').value.trim(),
    model: element<HTMLInputElement>('#model').value.trim() || defaultModel,
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
