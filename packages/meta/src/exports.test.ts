import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as sourceA2a from '@polymind-inc/agent-framework-a2a';
import * as sourceAgentserver from '@polymind-inc/agent-framework-agentserver';
import * as sourceAgentserverNode from '@polymind-inc/agent-framework-agentserver/node';
import * as sourceAgentserverObservability from '@polymind-inc/agent-framework-agentserver/observability';
import * as sourceAnthropic from '@polymind-inc/agent-framework-anthropic';
import * as sourceCore from '@polymind-inc/agent-framework-core';
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
import * as metaOpenai from './openai.js';
import * as metaTesting from './testing.js';

describe('every entry re-exports its package exactly', () => {
  const entries: ReadonlyArray<[subpath: string, meta: object, source: object]> = [
    ['.', metaRoot, sourceCore],
    ['./testing', metaTesting, sourceTesting],
    ['./openai', metaOpenai, sourceOpenai],
    ['./anthropic', metaAnthropic, sourceAnthropic],
    ['./mcp', metaMcp, sourceMcp],
    ['./a2a', metaA2a, sourceA2a],
    ['./foundry', metaFoundry, sourceFoundry],
    ['./foundry/hosting', metaFoundryHosting, sourceFoundryHosting],
    ['./agentserver', metaAgentserver, sourceAgentserver],
    ['./agentserver/node', metaAgentserverNode, sourceAgentserverNode],
    ['./agentserver/observability', metaAgentserverObservability, sourceAgentserverObservability],
  ];

  for (const [subpath, meta, source] of entries) {
    it(subpath, () => {
      expect(Object.keys(meta).sort()).toEqual(Object.keys(source).sort());
    });
  }
});

describe('the exports map mirrors every dependency subpath', () => {
  type Manifest = { exports: Record<string, unknown> };

  const readManifest = (relative: string): Manifest =>
    JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')) as Manifest;

  // Package directory and the subpath prefix its entries are mirrored under; the core sits at
  // the root, so its prefix is empty.
  const dependencies: ReadonlyArray<[dir: string, prefix: string]> = [
    ['core', ''],
    ['openai', '/openai'],
    ['anthropic', '/anthropic'],
    ['mcp', '/mcp'],
    ['a2a', '/a2a'],
    ['foundry', '/foundry'],
    ['agentserver', '/agentserver'],
  ];

  it('mirrors each subpath, with none missing and none dangling', () => {
    const expected = new Set(['./package.json']);
    for (const [dir, prefix] of dependencies) {
      for (const subpath of Object.keys(readManifest(`../../${dir}/package.json`).exports)) {
        if (subpath === './package.json') continue;
        expected.add(`.${prefix}${subpath.slice(1)}`);
      }
    }

    const actual = Object.keys(readManifest('../package.json').exports);
    expect(actual.sort()).toEqual([...expected].sort());
  });
});
