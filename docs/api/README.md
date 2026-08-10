# API contracts

Viby keeps two separate documents so product parity and shipped behavior do not get confused:

- [`v0-core.md`](./v0-core.md) audits the current v0 API v2 beta capabilities and maps each portable concern to Viby without copying hosted assumptions.
- [`v1.md`](./v1.md) is the normative contract for the Viby-native API that applications can use today.

The v0 document is a parity reference, not a promise of wire compatibility. The v1 document is the source of truth for implemented SDK behavior.

For a concise status matrix across core, adapters, integration surfaces, tests, and intentional boundaries, see the [shipped capability inventory](../capabilities.md).
