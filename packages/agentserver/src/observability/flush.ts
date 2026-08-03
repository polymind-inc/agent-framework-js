/**
 * The per-turn telemetry flush seam.
 *
 * A hosted sandbox may be frozen the moment the HTTP response is out, before a
 * `BatchSpanProcessor` timer ever fires — so the server flushes after every turn (the reference's
 * `flush_spans`, called at the end of each request and each stream). This module is the
 * indirection that lets `server.ts` do that without depending on any OTel SDK package: setup
 * registers the real flusher, and an unconfigured process pays one `undefined` check.
 */

let flusher: (() => Promise<void>) | undefined;

/** Registers the process-wide flusher. `undefined` clears it. */
export function setTelemetryFlusher(fn: (() => Promise<void>) | undefined): void {
  flusher = fn;
}

/**
 * Flushes buffered telemetry, when a flusher is registered.
 *
 * Never throws: a telemetry outage must not fail the turn it was recording.
 */
export async function flushTelemetry(): Promise<void> {
  if (flusher === undefined) {
    return;
  }
  try {
    await flusher();
  } catch {
    // Telemetry is an observer; the request it observed still succeeded.
  }
}
