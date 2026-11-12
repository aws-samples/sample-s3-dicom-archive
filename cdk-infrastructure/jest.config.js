/**
 * Jest config for the CDK infrastructure package.
 *
 * Two kinds of tests live here and both must run under `npm test`:
 *   - Lambda unit tests written in plain JS (lib/.../*.test.js), which mock the
 *     shared layer at /opt/nodejs and call the handler directly.
 *   - CDK construct/template assertion tests written in TS (lib/.../*.test.ts),
 *     which synthesize a stack and assert on the CloudFormation template.
 *
 * ts-jest transforms the .ts tests; .js tests run untransformed. node_modules
 * and the synth output (cdk.out) are excluded so vendored copies of handlers
 * under cdk.out are never collected as tests.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/lib', '<rootDir>/bin'],
  testMatch: ['**/*.test.js', '**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
  },
  testPathIgnorePatterns: ['/node_modules/', '/cdk.out/'],
  modulePathIgnorePatterns: ['/cdk.out/'],
};
