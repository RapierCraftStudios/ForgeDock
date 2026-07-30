# OpenCode Native Runtime Smoke Fixture

This fixture is satisfied by the executable acceptance procedure in
[`../OPENCODE-NATIVE-ACCEPTANCE.md`](../OPENCODE-NATIVE-ACCEPTANCE.md) and the
automated lifecycle suite in `bin/tests/opencode-native.test.mjs`.

Required smoke assertions:

- compact `/forge/work-on` and `/forge/orchestrate` entry commands;
- no runtime load of Claude work-on/orchestration control specs;
- one fresh root OpenCode session per phase attempt;
- no background Task dispatch or synthetic completion prompt;
- GitHub/git outcome reconciliation after every session result;
- deterministic dependency scheduling with bounded concurrency;
- explicit pre-dispatch confirmation;
- cancellation with resumable `RUN_INTERRUPTED` state;
- persisted batch resume; and
- unchanged Claude command tree and installer.
