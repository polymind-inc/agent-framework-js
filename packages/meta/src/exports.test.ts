import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as sourceA2a from '@polymind-inc/agent-framework-a2a';
import * as sourceAgentserver from '@polymind-inc/agent-framework-agentserver';
import * as sourceAgentserverNode from '@polymind-inc/agent-framework-agentserver/node';
import * as sourceAgentserverObservability from '@polymind-inc/agent-framework-agentserver/observability';
import * as sourceAnthropic from '@polymind-inc/agent-framework-anthropic';
import * as sourceCore from '@polymind-inc/agent-framework-core';
import * as sourceNode from '@polymind-inc/agent-framework-core/node';
import * as sourceTesting from '@polymind-inc/agent-framework-core/testing';
import * as sourceFoundry from '@polymind-inc/agent-framework-foundry';
import * as sourceFoundryHosting from '@polymind-inc/agent-framework-foundry/hosting';
import * as sourceMcp from '@polymind-inc/agent-framework-mcp';
import * as sourceOpenai from '@polymind-inc/agent-framework-openai';
import { describe, expect, it } from 'vitest';
import * as metaA2a from './a2a.js';
import * as metaAgentserverNode from './agentserver/node.js';
import * as metaAgentserverObservability from './agentserver/observability.js';
import * as metaAgentserver from './agentserver.js';
import * as metaAnthropic from './anthropic.js';
import * as metaFoundryHosting from './foundry/hosting.js';
import * as metaFoundry from './foundry.js';
import * as metaRoot from './index.js';
import * as metaMcp from './mcp.js';
import * as metaNode from './node.js';
import * as metaOpenai from './openai.js';
import * as metaTesting from './testing.js';

type ExportEntry = readonly [subpath: string, meta: object, source: object];

interface MirroredPackage {
  readonly dir: string;
  readonly prefix: string;
  readonly entries: readonly ExportEntry[];
}

// This is the single inventory for both runtime re-exports and package.json subpaths. Keeping the
// two checks on one descriptor means adding a package cannot update one surface while forgetting
// the other.
const mirroredPackages = [
  {
    dir: 'core',
    prefix: '',
    entries: [
      ['.', metaRoot, sourceCore],
      ['./testing', metaTesting, sourceTesting],
      ['./node', metaNode, sourceNode],
    ],
  },
  { dir: 'openai', prefix: '/openai', entries: [['./openai', metaOpenai, sourceOpenai]] },
  { dir: 'anthropic', prefix: '/anthropic', entries: [['./anthropic', metaAnthropic, sourceAnthropic]] },
  { dir: 'mcp', prefix: '/mcp', entries: [['./mcp', metaMcp, sourceMcp]] },
  { dir: 'a2a', prefix: '/a2a', entries: [['./a2a', metaA2a, sourceA2a]] },
  {
    dir: 'foundry',
    prefix: '/foundry',
    entries: [
      ['./foundry', metaFoundry, sourceFoundry],
      ['./foundry/hosting', metaFoundryHosting, sourceFoundryHosting],
    ],
  },
  {
    dir: 'agentserver',
    prefix: '/agentserver',
    entries: [
      ['./agentserver', metaAgentserver, sourceAgentserver],
      ['./agentserver/node', metaAgentserverNode, sourceAgentserverNode],
      ['./agentserver/observability', metaAgentserverObservability, sourceAgentserverObservability],
    ],
  },
] satisfies readonly MirroredPackage[];

describe('every entry re-exports its package exactly', () => {
  for (const mirrored of mirroredPackages) {
    for (const [subpath, meta, source] of mirrored.entries) {
      it(subpath, () => {
        expect(Object.keys(meta).sort()).toEqual(Object.keys(source).sort());
      });
    }
  }
});

describe('the exports map mirrors every dependency subpath', () => {
  type Manifest = { exports: Record<string, unknown> };

  const readManifest = (relative: string): Manifest =>
    JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')) as Manifest;

  it('mirrors each subpath, with none missing and none dangling', () => {
    const expected = new Set(['./package.json']);
    const expectedEntries = new Set<string>();
    for (const { dir, prefix } of mirroredPackages) {
      for (const subpath of Object.keys(readManifest(`../../${dir}/package.json`).exports)) {
        if (subpath === './package.json') continue;
        // `./internal` entries are contracts between the framework's own packages, not part of
        // the supported surface — the umbrella package deliberately does not re-export them.
        if (subpath === './internal' || subpath.endsWith('/internal')) continue;
        const mirroredSubpath = `.${prefix}${subpath.slice(1)}`;
        expected.add(mirroredSubpath);
        expectedEntries.add(mirroredSubpath);
      }
    }

    const declaredEntries = mirroredPackages.flatMap(({ entries }) => entries.map(([subpath]) => subpath));
    expect(declaredEntries.sort()).toEqual([...expectedEntries].sort());

    const actual = Object.keys(readManifest('../package.json').exports);
    expect(actual.sort()).toEqual([...expected].sort());
  });
});
