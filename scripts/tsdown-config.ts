import { defineConfig } from 'tsdown';

export interface PackageBuildOptions {
  entry: string[];
  platform: 'neutral' | 'node';
  neverBundle: string[];
}

/** Shared build defaults for every publishable package. */
export function definePackageBuild({ entry, platform, neverBundle }: PackageBuildOptions) {
  return defineConfig({
    entry,
    format: ['esm'],
    platform,
    dts: { oxc: true, sourcemap: false },
    clean: true,
    treeshake: true,
    target: 'es2024',
    sourcemap: true,
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    deps: { neverBundle },
  });
}
