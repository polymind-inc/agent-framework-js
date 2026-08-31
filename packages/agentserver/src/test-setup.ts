/**
 * Clears the deployment environment before each test file runs.
 *
 * The server reads its hosted mode, request limits and telemetry wiring from process env, so a
 * variable leaking in from the machine running the tests would silently change what the suite
 * asserts. A test that exercises an environment-driven path sets — and restores — the variable
 * itself.
 *
 * `AGENTSERVER_STATE_ROOT` goes with the rest, but does not stay unset: `scripts/test-state-root.ts`
 * runs after this file and points it at a throwaway directory, so a server built without an
 * explicit store cannot write into the developer's home.
 */
const PLATFORM_ENV_PREFIXES = ['FOUNDRY_', 'AGENTSERVER_', 'OTEL_EXPORTER_', 'APPLICATIONINSIGHTS_'];

for (const name of Object.keys(process.env)) {
  if (PLATFORM_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    delete process.env[name];
  }
}
