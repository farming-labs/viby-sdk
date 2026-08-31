---
title: "Health and diagnostics"
description: "Expose product readiness and inspect a Viby host without mutating provider resources."
---

# Health and diagnostics

Viby provides two complementary diagnostics surfaces: `viby.health.check()` for application
readiness endpoints and `viby doctor` for operators. Both return credential-free messages. Neither
calls a model, creates a sandbox, starts a preview, or changes a provider connection.

## Application readiness

Every client exposes `health.check()`:

```ts
const report = await viby.health.check();

return Response.json(report, {
  status: report.ok ? 200 : 503,
});
```

The database probe actively verifies that the selected persistence adapter is ready. Generation,
sandbox, preview, browser, environment, and integration checks describe the configured capability
surface without invoking those providers. Unconfigured optional capabilities are `skipped`, not
failures.

The report status is `healthy`, `degraded`, or `unhealthy`. A failed critical probe makes `ok`
false. Warnings produce a degraded report that remains ready.

## Product-owned probes

Add queues, private gateways, or other product dependencies through the provider-neutral probe
contract:

```ts
const viby = createViby({
  framework: "farmjs",
  model,
  health: {
    timeoutMs: 2_000,
    checks: [{
      id: "generation-queue",
      label: "Generation queue",
      async check(signal) {
        const ready = await queue.isReady({ signal });
        return ready
          ? { status: "pass", message: "Queue workers are available." }
          : { status: "fail", message: "No queue workers are available." };
      },
    }],
  },
});
```

Probe exceptions are replaced with generic guidance so connection strings, tokens, and provider
payloads cannot enter a readiness response. Write detailed failures to application-owned logs
inside the probe when needed. Set `critical: false` for an optional dependency; exceptions and
timeouts then produce a warning.

## Operator diagnostics

Run the read-only host inspection before serving traffic or while diagnosing a deployment:

```bash
npx viby doctor
npx viby doctor --json
```

The command checks the Node.js runtime, `DATABASE_URL` connectivity and pending migrations, and
whether `VIBY_SECRET_KEY` is available for encrypted default stores. It never applies migrations,
prints credential values, creates missing tables, or changes external resources. A missing secret
key is a warning because custom secret stores and products without provider credentials may not
need it. Pending migrations are a failure with an explicit `npx viby db migrate` action.

The human output is intended for terminals. `--json` returns the same typed health-report shape for
CI, deployment checks, or support tooling. The command exits non-zero only when the report is
unhealthy.

## Ownership boundary

Health reports describe one configured SDK process. They are not a hosted Viby control plane and
do not prove that optional provider credentials have every requested permission. Use the
environment-gated live provider suites for destructive end-to-end verification against disposable
resources.
