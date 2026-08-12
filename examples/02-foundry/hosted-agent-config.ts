import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

/** Builds one self-contained hosted-agent bundle from the directory containing its config. */
export function hostedAgentConfig(configUrl: string) {
  return defineConfig({
    cwd: dirname(fileURLToPath(configUrl)),
    entry: ['main.ts'],
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    clean: true,
    treeshake: true,
    sourcemap: true,
    dts: false,
    outputOptions: { codeSplitting: false },
    // This is an application bundle, not a library package. Include every dependency so the
    // runtime image only needs the generated artifact and does not depend on the workspace tree.
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
    outExtensions: () => ({ js: '.mjs' }),
  });
}
