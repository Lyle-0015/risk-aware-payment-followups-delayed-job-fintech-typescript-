import { z } from "zod";

export const paymentEventSchema = z.object({
  paymentId: z.string().min(1),
  event: z.enum(["payment_failed", "payment_pending"]),
  amountMinor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  accountCountry: z.string().regex(/^[A-Z]{2}$/),
  paymentCountry: z.string().regex(/^[A-Z]{2}$/),
  requestedDelayHours: z.number().int().min(1).max(72),
  occurredAt: z.string().datetime(),
});

export type PaymentEvent = z.infer<typeof paymentEventSchema>;
export type FollowupDecision = {
  actionId: string;
  action: "notify_customer" | "hold_for_review";
  risk: "standard" | "elevated";
  delayHours: number;
  executeAt: string;
  audit: {
    paymentId: string;
    event: PaymentEvent["event"];
    reason: string;
    decidedAt: string;
  };
};

export function decideFollowup(event: PaymentEvent, decidedAt: Date): FollowupDecision {
  const elevated = event.amountMinor >= 1_000_000 || event.accountCountry !== event.paymentCountry;
  const delayHours = elevated ? Math.max(event.requestedDelayHours, 24) : event.requestedDelayHours;
  const executeAt = new Date(decidedAt.getTime() + delayHours * 60 * 60 * 1_000);

  return {
    actionId: `${event.paymentId}-${decidedAt.getTime()}`,
    action: elevated ? "hold_for_review" : "notify_customer",
    risk: elevated ? "elevated" : "standard",
    delayHours,
    executeAt: executeAt.toISOString(),
    audit: {
      paymentId: event.paymentId,
      event: event.event,
      reason: elevated ? "large amount or country mismatch" : "standard payment follow-up",
      decidedAt: decidedAt.toISOString(),
    },
  };
}

export function cronAt(date: Date): string {
  return `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`;
}
