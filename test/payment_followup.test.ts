import assert from "node:assert/strict";
import test from "node:test";
import { decideFollowup, paymentEventSchema } from "../src/payment_followup.js";
import { server, schedulePaymentFollowup } from "../src/fintech_followup_service.js";
import { infrai } from "../src/infrai_cron.js";

test("failed deletion is retried before completion becomes idempotent", async () => {
  const originalCreate = infrai.cron.create;
  const originalDelete = infrai.cron.delete;
  const originalUrl = process.env.PUBLIC_BASE_URL;
  let deletions = 0;
  infrai.cron.create = async () => ({ job_id: "test-job" });
  infrai.cron.delete = async () => {
    if (++deletions === 1) throw new Error("deletion failed");
    return {};
  };
  process.env.PUBLIC_BASE_URL = "https://example.invalid";
  try {
    const scheduled = await schedulePaymentFollowup({
      paymentId: "retry-test", event: "payment_pending", amountMinor: 100,
      currency: "USD", accountCountry: "US", paymentCountry: "US",
      requestedDelayHours: 6, occurredAt: "2026-09-06T08:00:00.000Z",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const callback = `http://127.0.0.1:${address.port}/callbacks/payment-followup?actionId=${scheduled.actionId}`;
    assert.equal((await fetch(callback, { method: "POST" })).status, 500);
    assert.equal(deletions, 1);
    assert.equal((await fetch(callback, { method: "POST" })).status, 200);
    assert.equal(deletions, 2);
    assert.equal((await fetch(callback, { method: "POST" })).status, 200);
    assert.equal(deletions, 2);
  } finally {
    infrai.cron.create = originalCreate;
    infrai.cron.delete = originalDelete;
    if (originalUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = originalUrl;
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("country mismatch becomes a review hold with at least 24 hours of audit lead time", () => {
  const event = paymentEventSchema.parse({
    paymentId: "pay_risk_7",
    event: "payment_pending",
    amountMinor: 8900,
    currency: "EUR",
    accountCountry: "DE",
    paymentCountry: "FR",
    requestedDelayHours: 3,
    occurredAt: "2026-09-06T08:00:00.000Z",
  });
  const result = decideFollowup(event, new Date("2026-09-06T09:00:00.000Z"));

  assert.equal(result.action, "hold_for_review");
  assert.equal(result.risk, "elevated");
  assert.equal(result.delayHours, 24);
  assert.equal(result.executeAt, "2026-09-07T09:00:00.000Z");
  assert.equal(result.audit.paymentId, "pay_risk_7");
});
