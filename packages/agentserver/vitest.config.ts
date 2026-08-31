import { definePackageTests } from '../../scripts/vitest-config.ts';

// The suite must not inherit the machine's deployment environment; see src/test-setup.ts.
export default definePackageTests({ setupFiles: ['./src/test-setup.ts'] });
