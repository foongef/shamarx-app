import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  testEnvironment: 'node',
  testRegex: '.e2e-spec.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@app/prisma$': '<rootDir>/libs/prisma/src',
    '^@app/prisma/(.*)$': '<rootDir>/libs/prisma/src/$1',
    '^@app/common$': '<rootDir>/libs/common/src',
    '^@app/common/(.*)$': '<rootDir>/libs/common/src/$1',
    '^@app/redis$': '<rootDir>/libs/redis/src',
    '^@app/redis/(.*)$': '<rootDir>/libs/redis/src/$1',
  },
};

export default config;
