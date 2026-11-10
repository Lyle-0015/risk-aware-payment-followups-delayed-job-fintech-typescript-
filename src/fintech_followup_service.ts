import { createServer, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { ZodError } from "zod";
import { infrai, InfraiError } from "./infrai_cron.js";
import { cronAt, decideFollowup, paymentEventSchema, type FollowupDecision } from "./payment_followup.js";

const actions = new Map<string, FollowupDecision & { jobId: string; state: "scheduled" | "completed" }>();

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readJson(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function schedulePaymentFollowup(body: unknown, now = new Date()): Promise<FollowupDecision & { jobId: string }> {
  const event = paymentEventSchema.parse(body);
  const decision = decideFollowup(event, now);
  const publicUrl = process.env.PUBLIC_BASE_URL;
  if (!publicUrl) throw new Error("Set PUBLIC_BASE_URL to this service's public HTTPS origin");

  const task = new URL("/callbacks/payment-followup", publicUrl);
  task.searchParams.set("actionId", decision.actionId);
  const scheduled = await infrai.cron.create(
    { cron_expr: cronAt(new Date(decision.executeAt)), task: task.toString() },
    `payment-followup:${decision.actionId}`,
  );
  actions.set(decision.actionId, { ...decision, jobId: scheduled.job_id, state: "scheduled" });
  return { ...decision, jobId: scheduled.job_id };
}

async function completeFollowup(actionId: string): Promise<FollowupDecision> {
  const record = actions.get(actionId);
  if (!record) throw new Error("Unknown payment follow-up");
  if (record.state === "completed") return record;

  await infrai.cron.delete(record.jobId, `payment-followup-complete:${actionId}`);
  const completed = { ...record, state: "completed" as const };
  actions.set(actionId, completed);
  console.log(JSON.stringify({ type: "payment_followup_completed", actionId, action: completed.action, audit: completed.audit }));
  return completed;
}

export const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST" && url.pathname === "/payment-events") {
      const result = await schedulePaymentFollowup(await readJson(request));
      json(response, 202, { state: "scheduled", ...result });
      return;
    }
    if (request.method === "POST" && url.pathname === "/callbacks/payment-followup") {
      const actionId = url.searchParams.get("actionId");
      if (!actionId) return json(response, 400, { error: "actionId is required" });
      json(response, 200, { state: "completed", action: await completeFollowup(actionId) });
      return;
    }
    json(response, 404, { error: "route not found" });
  } catch (error) {
    if (error instanceof ZodError) return json(response, 400, { error: "invalid payment event", issues: error.issues });
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      return json(response, status, { error: error.code, message: error.message });
    }
    json(response, 500, { error: error instanceof Error ? error.message : "unexpected error" });
  }
});

const example = {
  paymentId: "pay_demo_1042",
  event: "payment_failed",
  amountMinor: 24500,
  currency: "USD",
  accountCountry: "US",
  paymentCountry: "US",
  requestedDelayHours: 6,
  occurredAt: "2026-09-06T08:00:00.000Z",
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--example")) {
    schedulePaymentFollowup(example).then((result) => console.log(JSON.stringify(result, null, 2)));
  } else {
    const port = Number(process.env.PORT ?? 3000);
    server.listen(port, () => console.log(`Payment follow-up service listening on http://localhost:${port}`));
  }
}
