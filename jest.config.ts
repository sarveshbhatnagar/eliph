export default {
  projects: [
    { displayName: 'core', testMatch: ['<rootDir>/packages/core/tests/**/*.test.ts'], preset: 'ts-jest', testEnvironment: 'node' },
    { displayName: 'server', testMatch: ['<rootDir>/packages/server/tests/**/*.test.ts'], preset: 'ts-jest', testEnvironment: 'node' },
    { displayName: 'mcp', testMatch: ['<rootDir>/packages/mcp/tests/**/*.test.ts'], preset: 'ts-jest', testEnvironment: 'node' },
  ],
}
