/* ============================================================================
   The first read, from somewhere neither side controls.
   ----------------------------------------------------------------------------
   The question that kills this entire idea is "who decides what's slop?"
   If we decide, nobody stakes a rupee. If the maintainer alone decides, they are
   judging a case where the fine is at stake. So the first opinion comes from a
   model running inside a sealed enclave, and it signs its own verdict.

   THE CLAIM WE ARE ALLOWED TO MAKE, AND WHY IT IS NARROW:
   Resolved from the live catalog (GET /v1/models, no auth), 2026-11-05:
     · verifiability "TeeML"  -> tee_type TDX, tee_verifier dstack.
                                 The MODEL runs inside the enclave.
     · verifiability "TeeTLS" -> transport only. The model does NOT.
   67 of 124 models are tee_attested, but many are TeeTLS. We pin a TeeML model
   and refuse to fall back to a TeeTLS one, because "the AI read it inside a
   sealed chip" is only true in the first case.

   The enclave gives a FIRST OPINION, never a sentence. A human always signs the
   outcome. We never slash on an unreviewed machine verdict.
   ========================================================================= */

const BASE = process.env.ZEROG_BASE_URL || "https://router-api.0g.ai/v1";
const KEY = process.env.ZEROG_API_KEY;

/* TeeML + TDX, 262k context, cheapest TEE model on the router, 0G's own. */
export const TRIAGE_MODEL = process.env.ZEROG_MODEL || "0gm-1.0-35b-a3b";
export const FALLBACK_MODEL = "glm-5.3"; // also TeeML + TDX, 2 providers

const SYSTEM = `You triage security reports for an open source project.

You are deciding ONE thing: is this report a good-faith attempt to describe a real
issue, or is it fabricated — invented function names, invented file paths, a
plausible-sounding narrative with nothing behind it?

Three calls, and the middle one matters most:
- "valid"      the report describes something real and reproducible
- "plausible"  good faith, but you cannot confirm it; it may simply be wrong
- "fabricated" it cites code that does not exist, or contradicts itself

BEING WRONG IS NOT FABRICATION. Most honest security reports are wrong. Only call
"fabricated" when the report asserts specifics that cannot be true. If you are
unsure, the answer is "plausible".

Answer as JSON: {"call": "...", "confidence": 0.0-1.0, "summary": "<=140 chars",
"reasoning": "<=600 chars", "checks": ["what you would verify next"]}`;

export class TriageError extends Error {}

/* Confirm the model really is TeeML before we send anything or claim anything. */
export async function assertTeeML(model = TRIAGE_MODEL) {
  const r = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new TriageError(`model catalog unavailable: HTTP ${r.status}`);
  const card = (await r.json()).data?.find((m) => m.id === model);
  if (!card) throw new TriageError(`model ${model} is not in the catalog`);
  if (card.verifiability !== "TeeML") {
    throw new TriageError(
      `${model} is "${card.verifiability}", not TeeML — the model would not run inside the enclave, so refusing to use it for a verdict`,
    );
  }
  return {
    model: card.id,
    verifiability: card.verifiability,
    teeType: card.tee_type,
    teeVerifier: card.tee_verifier,
    providers: card.provider_count,
    contextLength: card.context_length,
  };
}

/* The triage call itself.
   `X-0G-Provider-Trust-Mode: private` routes only to TeeML providers and returns
   503 rather than silently downgrading — that no-silent-downgrade property is
   what makes the claim safe to state out loud. */
export async function triage(report, { model = TRIAGE_MODEL, trustMode = "private" } = {}) {
  if (!KEY) throw new TriageError("ZEROG_API_KEY missing — get one at pc.0g.ai (mainnet key, starts sk-)");

  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Repository: ${report.repo}\nClaimed severity: ${report.severity}\nTitle: ${report.title}\n\n${report.body}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 900,
    response_format: { type: "json_object" },
  };

  const started = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "X-0G-Provider-Trust-Mode": trustMode,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (res.status === 503) {
    throw new TriageError(
      "no TEE provider free right now (503). The router refused to downgrade, which is the behaviour we want — retry rather than relax trust mode.",
    );
  }
  if (res.status === 402) throw new TriageError("0G balance empty (402) — top up at pc.0g.ai");
  if (!res.ok) throw new TriageError(`0G router: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();

  /* The load-bearing identifier. Canonical order per 0G's own docs. */
  const requestId = res.headers.get("ZG-Res-Key") ?? data.id;
  const trace = data.x_0g_trace ?? {};

  let parsed;
  try {
    parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
  } catch {
    throw new TriageError("model did not return parseable JSON");
  }

  const call = ["valid", "plausible", "fabricated"].includes(parsed.call) ? parsed.call : "plausible";

  return {
    call,
    confidence: Number(parsed.confidence) || 0,
    summary: String(parsed.summary ?? "").slice(0, 140),
    reasoning: String(parsed.reasoning ?? "").slice(0, 600),
    checks: Array.isArray(parsed.checks) ? parsed.checks.slice(0, 5) : [],

    /* the receipt */
    requestId,
    model: data.model ?? model,
    provider: trace.provider ?? null,
    teeVerified: trace.tee_verified ?? null,   // router self-report only
    trustMode,
    latencyMs: Date.now() - started,
    usage: data.usage ?? null,

    /* never let a machine call be mistaken for a decision */
    decidedBy: "enclave-first-opinion",
    binding: false,
  };
}

/* Fetch the provider's signature over this response so a third party can check
   it against the on-chain teeSignerAddress.

   HONEST STATUS: the Router docs do not document this path; it comes from a live
   probe. If it 404s we degrade to request-ID-only and say so on screen, rather
   than claiming a verification we did not perform. */
export async function fetchSignature({ requestId, model, providerUrl }) {
  if (!providerUrl) return { available: false, reason: "no provider url in x_0g_trace" };
  try {
    const url = `${providerUrl.replace(/\/$/, "")}/v1/proxy/signature/${encodeURIComponent(requestId)}?model=${encodeURIComponent(model)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return { available: false, reason: `HTTP ${r.status}` };
    const j = await r.json();
    return { available: true, signature: j.signature ?? j.sig ?? null, raw: j };
  } catch (e) {
    return { available: false, reason: String(e.message).slice(0, 140) };
  }
}
