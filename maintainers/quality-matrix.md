# Quality and evaluation

`npm run test:quality` is the deterministic generated-project gate. It complements unit, PostgreSQL, sandbox, and reference-application tests by exercising complete output folders instead of isolated records.

The current matrix covers three framework identifiers:

- `farm`;
- `tanstack-start`;
- a custom `custom-web-runtime` value.

Every row runs the same provider-neutral lifecycle:

1. create a scoped chat and generate a complete source tree from a prompt, host instruction, metadata, and immutable reference attachment;
2. validate source size/checksum integrity, package scripts, accessible interaction states, responsive styles, and the absence of placeholder markers;
3. materialize the generated folder, run its own `check` and `build` scripts, start its preview server, and verify the HTTP response;
4. verify byte-for-byte ZIP download parity;
5. iterate from the exact version through immutable source changes and repeat the folder, runtime, preview, and ZIP gates;
6. persist passing design-evaluation criteria against both versions and verify version isolation.

The fixtures intentionally use dependency-free generated projects. This keeps the gate deterministic and tests the SDK boundary without claiming that one core test can validate every framework compiler. Framework-specific adapters or skills can add rows with their own install and build recipes later without changing the matrix runner's lifecycle.
