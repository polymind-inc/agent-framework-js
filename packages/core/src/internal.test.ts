import { describe, expect, it } from 'vitest';
import * as root from './index.js';
import * as internal from './internal.js';

// Assembling a request payload against a provider SDK is a `ChatClient` implementation detail, not
// part of the programming model — none of the reference implementations publishes a free-function
// counterpart. These live on `/internal` so the supported surface does not promise them.
const REQUEST_ASSEMBLY_HELPERS = ['arrayToStream', 'setIfDefined', 'topLevelMediaType', 'withoutUndefined'];

describe('the internal contract', () => {
  it('carries the provider request-assembly helpers', () => {
    expect(Object.keys(internal)).toEqual(expect.arrayContaining(REQUEST_ASSEMBLY_HELPERS));
  });

  it('keeps them off the root entry', () => {
    expect(REQUEST_ASSEMBLY_HELPERS.filter((name) => name in root)).toEqual([]);
  });

  it('shares nothing with the supported root entry', () => {
    // An `/internal` export is unsupported and may change in any release; a root export is a
    // promise. A symbol on both entries makes that promise ambiguous, so the two sets stay
    // disjoint by construction rather than by review.
    expect(Object.keys(internal).filter((name) => name in root)).toEqual([]);
  });
});
