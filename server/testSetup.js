// Imported first by every test file: the tests use their own in-memory database, never data/smart_e_mobility.sqlite.
process.env.SMART_EMOBILITY_DB = ':memory:';
process.env.NODE_ENV = 'test';
