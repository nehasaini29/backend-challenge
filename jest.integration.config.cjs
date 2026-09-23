module.exports = {
  ...require('./jest.config.cjs'),
  testMatch: ['**/tests/**/*.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 30000,
};
