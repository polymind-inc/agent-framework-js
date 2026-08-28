import { definePackageTests } from '../../scripts/vitest-config.ts';

const config = definePackageTests();
// The suite must not inherit the machine's deployment environment; see src/test-setup.ts.
config.test = { ...config.test, setupFiles: ['./src/test-setup.ts'] };
export default config;
