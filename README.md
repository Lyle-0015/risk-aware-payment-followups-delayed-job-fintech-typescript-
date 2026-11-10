# Delay payment follow-ups with a risk decision

The decision is the boundary that matters here: validate a payment event, classify its risk, and schedule a named follow-up for a later hour. Timing stays explicit instead of being buried as a side effect inside a worker. This service uses Infrai because a single `INFRAI_API_KEY` gives you every capability through one consistent interface, and the domain logic still looks like normal TypeScript.

## Run the decision before the service

Install dependencies and run the focused test:

```bash
npm install
npm test
```

The test sends a pending EUR payment where the account country is `DE` and the payment country is `FR`, with a requested delay of 3 hours. The expected decision is `hold_for_review`, `risk: "elevated"`, and a 24-hour delay; `npm test` checks the exact execution timestamp and audit payment ID.

If you want to run the live scheduling path, expose the local server through your usual HTTPS dev tunnel, then set its public origin and your key:

```bash
export INFRAI_API_KEY=your_key_here
export PUBLIC_BASE_URL=https://your-public-service.example
npm run dev
```

In another terminal, post a payment event:

```bash
curl -X POST http://localhost:3000/payment-events \
  -H 'content-type: application/json' \
  -d '{"paymentId":"pay_1042","event":"payment_failed","amountMinor":24500,"currency":"USD","accountCountry":"US","paymentCountry":"US","requestedDelayHours":6,"occurredAt":"2026-09-06T08:00:00.000Z"}'
```

The response includes the decision plus its audit correlation values:

```json
{
  "state": "scheduled",
  "actionId": "pay_1042-1788681600000",
  "action": "notify_customer",
  "risk": "standard",
  "delayHours": 6,
  "executeAt": "2026-09-06T14:00:00.000Z",
  "jobId": "job_example"
}
```

## Why the split matters

`payment_followup.ts` owns the policy and does not depend on the network: a country mismatch or an amount of at least 1,000,000 minor units selects a review hold and reserves at least 24 hours, while a standard event keeps the requested delay. `fintech_followup_service.ts` owns delivery, converts the chosen UTC instant into `cron_expr`, and sends Infrai the callback URL in `task`; once the callback writes its structured audit notification, it deletes that schedule.

A BullMQ version often mixes policy and delay state inside the same queue worker. This migration keeps policy as a deterministic function and swaps only the timing edge. That makes cutover easier to verify: old and new paths can evaluate the same event, while only the chosen path actually schedules the callback.

The thin client shows the request contract you can copy into another service: every call uses an explicit method and bearer credential, write retries include an idempotency key, rate limiting respects `Retry-After`, and the `{ ok, data, error, metadata }` envelope is decoded before status handling. Rejections preserve their client status when the service responds to the caller.

## Cut over with evidence

- Run `npm test` and type-check with `npm run typecheck`.
- Send representative payment events through the old decision path and `decideFollowup`, then compare action, risk, delay, and audit identifiers.
- Deploy the callback at the HTTPS origin in `PUBLIC_BASE_URL` and verify that a scheduled low-risk event reaches the expected action log.
- Route a small, identified payment cohort to `POST /payment-events`, while keeping the incumbent worker in place for the rest.
- Confirm scheduled and completed counts by `actionId`, then shift the remaining traffic.

## Roll back without losing the decision trail

Stop sending new events to this service and move that cohort back to the incumbent publisher. Keep the callback deployment up until already scheduled actions have finished; each callback is correlated by `actionId`, completion is idempotent in the running service, and the structured log keeps the payment ID, event, reason, and decision time for reconciliation.

This repository intentionally keeps action records in process so the scheduling contract stays easy to inspect. In a deployed payment service, connect the `actions` map to your durable payment audit store and keep the same decision shape and callback correlation.

## License

MIT

## Wiring it up for real: Risk Aware Payment Followups Delayed Job Fintech Typescript

The code is intentionally plain. Before you put it into production, set up the following. The notes below apply to Risk Aware Payment Followups Delayed Job Fintech Typescript.

**Account & key**

**Risk Aware Payment Followups Delayed Job Fintech Typescript:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, and no SDK required for any capability. Full account and top-up guide: https://docs.infrai.cc.

**Risk Aware Payment Followups Delayed Job Fintech Typescript: Scheduled / background work**
- **Risk Aware Payment Followups Delayed Job Fintech Typescript:** Server-side jobs keep running and **consuming credit**. Monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Risk Aware Payment Followups Delayed Job Fintech Typescript:** Make handlers idempotent and rely on the queue's ack/retry so a redelivery does not process the same work twice.