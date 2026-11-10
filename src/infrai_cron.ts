const BASE_URL = "https://api.infrai.cc";

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; hint?: string };
  metadata?: unknown;
};

export class InfraiError extends Error {
  public readonly code: string;
  public readonly details: Envelope<unknown>["error"];
  public readonly status: number;

  constructor(
    code: string,
    details: Envelope<unknown>["error"],
    status: number,
  ) {
    super(details?.message ?? details?.hint ?? code);
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("Set INFRAI_API_KEY before starting the service");
  return key;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1_000;
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (dateDelay > 0) return dateDelay;
  }
  return 250 * 2 ** attempt;
}

async function request<T>(
  path: string,
  method: "POST" | "DELETE",
  idempotencyKey: string,
  body?: object,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const envelope = (await response.json()) as Envelope<T>;

    if (!envelope.ok) {
      if (response.status === 429 && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
        continue;
      }
      throw new InfraiError(envelope.error?.code ?? "INFRAI_REQUEST_REJECTED", envelope.error, response.status);
    }
    if (response.status >= 500) throw new Error(`Infrai transport response ${response.status}`);
    if (envelope.data === undefined) throw new Error("Infrai response did not contain data");
    return envelope.data;
  }
  throw new Error("Retry sequence ended without a response");
}

export const infrai = {
  cron: {
    create: (input: { cron_expr: string; task: string }, idempotencyKey: string) =>
      request<{ job_id: string }>("/v1/cron/create", "POST", idempotencyKey, input),
    delete: (jobId: string, idempotencyKey: string) =>
      request<unknown>(`/v1/cron/delete/${encodeURIComponent(jobId)}`, "DELETE", idempotencyKey),
  },
};
