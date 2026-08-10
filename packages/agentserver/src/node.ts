import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { port as configuredPort, gracefulShutdownSeconds, UnsupportedOtlpProtocolError } from './config.js';
import { writeWebResponse } from './node-internals.js';
import { flushTelemetry } from './observability/flush.js';
import type { HostObservabilityOptions } from './observability/setup.js';
import { raceTimeout } from './wait.js';

/**
 * What {@link serve} needs from a protocol server: a `fetch` handler to answer requests, and a
 * `drain` to call on shutdown. `ResponsesServer` and `InvocationsServer` both qualify.
 */
export interface ProtocolServer {
  readonly fetch: (request: Request) => Promise<Response>;
  drain(): Promise<void>;
}

/** Options for {@link serve}. */
export interface ServeOptions {
  /** Defaults to `PORT`, or 8088. */
  port?: number;
  /**
   * Defaults to `0.0.0.0`.
   *
   * Binding to `127.0.0.1` inside a container makes the readiness probe unreachable, and every
   * invocation then fails with `session_not_ready` — which is why the default is the wildcard.
   */
  host?: string;
  /** Install SIGTERM/SIGINT handlers that drain in-flight responses. Default `true`. */
  handleSignals?: boolean;
  /**
   * OTel host setup, run before the listener binds.
   *
   * The default mirrors the reference hosts, which configure observability unconditionally at
   * startup: `setupHostObservability()` reads the platform's env vars and turns on Azure Monitor
   * and/or OTLP export when they call for it, and stays harmlessly inert when they don't. Pass
   * `false` to skip SDK-managed setup entirely (the reference's `configure_observability=None`),
   * or options to forward to it. A setup failure is a warning, not a refusal to serve.
   */
  observability?: boolean | HostObservabilityOptions;
}

/** A running server. */
export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  /** Stops accepting requests, drains, then closes. */
  close(): Promise<void>;
}

/** Converts a Node request into a Web `Request`. */
function toWebRequest(req: IncomingMessage, host: string, signal: AbortSignal): Request {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      headers.append(name, entry);
    }
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method ?? 'GET',
    headers,
    signal,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  } as RequestInit);
}

/**
 * Serves a {@link ProtocolServer} over `node:http`.
 *
 * Binds `0.0.0.0:${PORT:-8088}` — the container contract's requirement. Observability is
 * configured first, so the very first turn's spans have somewhere to go; see
 * {@link ServeOptions.observability}.
 */
export async function serve(app: ProtocolServer, options: ServeOptions = {}): Promise<RunningServer> {
  if (options.observability !== false) {
    try {
      // Imported here, not at the top: a `serve` that opted out never loads the SDK packages.
      const { setupHostObservability } = await import('./observability/setup.js');
      await setupHostObservability(typeof options.observability === 'object' ? options.observability : {});
    } catch (error) {
      if (error instanceof UnsupportedOtlpProtocolError) {
        // A misconfiguration fails startup (the reference re-raises its `ValueError` the same
        // way): a typo that silently exported nothing would defeat the point of this layer.
        throw error;
      }
      // Everything else is an outage, and the reference hosts swallow those: a telemetry
      // failure must not keep the container from serving.
      console.warn('[agentserver] observability setup failed; continuing without telemetry export:', error);
    }
  }

  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? configuredPort();

  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      // The client going away aborts the handler, which is what stops work nobody will read.
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      try {
        // Called through `app`, never detached: `ProtocolServer` is structural, and a server
        // implementing `fetch` as an ordinary method would lose its instance state otherwise.
        await writeWebResponse(await app.fetch(toWebRequest(req, host, abort.signal)), res);
      } catch {
        // The protocol layer answers its own errors; reaching here means the socket itself broke.
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end();
      }
    })();
  });

  return new Promise<RunningServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;

      let stop: (() => void) | undefined;
      let closePromise: Promise<void> | undefined;
      const close = (): Promise<void> => {
        if (closePromise !== undefined) {
          return closePromise;
        }
        if (stop !== undefined) {
          process.removeListener('SIGTERM', stop);
          process.removeListener('SIGINT', stop);
          stop = undefined;
        }
        closePromise = (async (): Promise<void> => {
          const deadline = Date.now() + gracefulShutdownSeconds() * 1000;
          const drained = app.drain();
          await new Promise<void>((done) => {
            const timer = setTimeout(() => {
              server.closeAllConnections?.();
              done();
            }, gracefulShutdownSeconds() * 1000);
            timer.unref?.();
            server.close(() => {
              clearTimeout(timer);
              done();
            });
          });
          // Detached background runs are not connections, so `server.close` never waits for them.
          // Give them what is left of the grace period to persist their terminal state — the
          // Python shutdown handler holds the process for its background records the same way.
          await raceTimeout(drained, Math.max(0, deadline - Date.now()));
          // Whatever the drained turns recorded leaves with the process, not with the batch timer.
          await flushTelemetry();
        })();
        return closePromise;
      };

      if (options.handleSignals !== false) {
        stop = (): void => {
          void close().then(() => process.exit(0));
        };
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);
      }

      resolve({ server, port: boundPort, close });
    });
  });
}
