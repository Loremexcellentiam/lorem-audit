// jest.config.js
'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js'],
  collectCoverageFrom: [
    'audit.js',
    'reporter.js',
    'constants.js',
    'checks/**/*.js',
  ],
  coverageThreshold: {
    global: {
      lines: 60,
    },
  },
  testTimeout: 60000, // 60s — some checks spin up servers
};
