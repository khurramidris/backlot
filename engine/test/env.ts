// Imported first by tests: ESM evaluates imports in order, so this runs before src/config.ts reads the environment.
process.env.MOCK_PROVIDERS ??= '1';
process.env.ALLOW_DEV_TOKENS ??= '1';
