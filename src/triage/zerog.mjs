/* ============================================================================
   The first read, from somewhere neither side controls.
   ----------------------------------------------------------------------------
   The question that kills this entire idea is "who decides what's slop?"
   If we decide, nobody stakes a rupee. If the maintainer alone decides, they are
   judging a case where the fine is at stake. So the first opinion comes from a
   model running inside a sealed enclave.

   WHAT WE CAN PROVE, AND WHAT WE CANNOT — probed live 2026-11-06.

   CAN: the router publishes, per model, the providers serving it
   (GET /v1/providers?model=), each record carrying trust_mode, verifiability,
   tee_type and tee_verifier. glm-5.3 has TWO providers:

     0xD179F452...E503  0G Foundation  trust_mode "private"   TeeML / TDX / dstack
     0x00000000...8044  baidu          trust_mode "standard"  no verifiability

   Every completion returns x_0g_trace.provider — the ADDRESS that served it. So
   we can check, after the fact, that the request was served by the enclave
   provider and not the ordinary one. That check is verifyProvider() below, and
   it is a real verification rather than a self-report.

   CANNOT: fetch the provider's signature over the response. The documented path
   GET {provider_url}/v1/proxy/signature/{chatID} belongs to the direct-SDK flow.
   Through the Router it is unreachable — the Router never exposes provider URLs
   (no url field on any provider record), and eight candidate router-side paths
   all return 404 for a live chatID. See arkiv/friction.md.
   So we do NOT claim a verified provider signature. We claim what we checked.

   The enclave gives a FIRST OPINION, never a sentence. A human always signs the
   outcome. We never slash on an unreviewed machine verdict.
   ========================================================================= */

const BASE = process.env.ZEROG_BASE_URL || "https://router-api.0g.ai/v1";
const KEY = process.env.ZEROG_API_KEY;

/* glm-5.3: TeeML, and its 0G Foundation provider is TDX + dstack in private
   trust mode. Two providers, so one outage is not a dead demo.

   We previously pinned 0gm-1.0-35b-a3b (TeeML/TDX, 262k ctx). It has exactly ONE
   provider, and that provider returned 502 "fetch provider quote: EOF" all
   through 6 Nov. A single-provider model is a single point of failure, which is
   why it is now the fallback rather than the default. */
export const TRIAGE_MODEL = process.env.ZEROG_MODEL || "glm-5.3";
export const FALLBACK_MODEL = "0gm-1.0-35b-a3b";

/* glm-5.3 is a reasoning model: it spends tokens thinking before it answers.
   A real triage call burned 485 reasoning tokens before emitting 265 of JSON.
   max_tokens below ~1500 returns an EMPTY string, not a short answer. */
const MAX_TOKENS = Number(process.env.ZEROG_MAX_TOKENS || 4000);

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

/* Which addresses serving this model actually run it inside an enclave.
   A provider qualifies only if the router says all three: private trust mode,
   TeeML verifiability, and a named TEE type. */
export async function teeProvidersFor(model = TRIAGE_MODEL) {
  const r = await fetch(`${BASE}/providers?model=${encodeURIComponent(model)}`, {
    headers: KEY ? { Authorization: `Bearer ${KEY}` } : {},
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new TriageError(`provider registry unavailable: HTTP ${r.status}`);
  const all = (await r.json()).data ?? [];
  const isTee = (p) => p.trust_mode === "private" && p.verifiability === "TeeML" && Boolean(p.tee_type);
  return {
    tee: all.filter(isTee).map((p) => ({
      address: String(p.address).toLowerCase(),
      name: p.provider_name,
      teeType: p.tee_type,
      teeVerifier: p.tee_verifier,
      healthy: p.is_healthy,
      uptime: p.uptime,
      latencyMs: p.latency,
    })),
    /* named so the demo can show what the header is protecting us FROM */
    nonTee: all.filter((p) => !isTee(p)).map((p) => ({
      address: String(p.address).toLowerCase(),
      name: p.provider_name,
      trustMode: p.trust_mode,
    })),
  };
}

/* Confirm the model really is TeeML, and that an enclave provider is actually
   serving it, before we send anything or claim anything. */
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

  const { tee, nonTee } = await teeProvidersFor(model);
  if (tee.length === 0) {
    throw new TriageError(
      `${model} is TeeML in the catalogue but no provider is serving it in private trust mode — refusing to claim an enclave we cannot reach`,
    );
  }

  return {
    model: card.id,
    verifiability: card.verifiability,
    teeType: tee[0].teeType ?? card.tee_type ?? null,
    teeVerifier: tee[0].teeVerifier ?? card.tee_verifier ?? null,
    providers: card.provider_count,
    contextLength: card.context_length,
    teeProviders: tee,
    nonTeeProviders: nonTee,
  };
}

/* Did an enclave actually serve this response? Checks the address the router
   reported against the enclave providers it publishes for the model. */
export function verifyProvider(providerAddress, teeList) {
  if (!providerAddress) return { verified: false, reason: "no provider address in x_0g_trace" };
  const got = String(providerAddress).toLowerCase();
  const hit = (teeList ?? []).find((p) => p.address === got);
  if (!hit) {
    return {
      verified: false,
      reason: `served by ${providerAddress}, which is not a TEE provider for this model`,
    };
  }
  return { verified: true, provider: hit };
}

/* The triage call itself.
   `X-0G-Provider-Trust-Mode: private` routes only to TeeML providers and fails
   rather than silently downgrading — that no-silent-downgrade property is what
   makes the claim safe to state out loud. We then check the address that
   answered, so the claim does not rest on the router's good manners alone. */
export async function triage(report, { model = TRIAGE_MODEL, trustMode = "private" } = {}) {
  if (!KEY) throw new TriageError("ZEROG_API_KEY missing — get one at pc.0g.ai (mainnet key, starts sk-)");

  /* who is allowed to answer this, fetched before we ask */
  let teeList = [];
  try {
    teeList = (await teeProvidersFor(model)).tee;
  } catch {
    /* registry down: proceed, but we will not be able to verify the provider */
  }

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
    max_tokens: MAX_TOKENS,
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
    signal: AbortSignal.timeout(600000),
  });

  if (res.status === 503) {
    throw new TriageError(
      "no TEE provider free right now (503). The router refused to downgrade, which is the behaviour we want — retry rather than relax trust mode.",
    );
  }
  if (res.status === 502) {
    throw new TriageError(
      `the enclave provider for ${model} is not answering (502 upstream). The router did not quietly route around it to a non-TEE provider, which is the behaviour we want.`,
    );
  }
  if (res.status === 402) throw new TriageError("0G balance empty (402) — top up at pc.0g.ai");
  if (!res.ok) throw new TriageError(`0G router: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();

  /* The load-bearing identifier. Canonical order per 0G's own docs. */
  const requestId = res.headers.get("ZG-Res-Key") ?? data.id;
  const trace = data.x_0g_trace ?? {};
  const provider = trace.provider ?? null;
  const check = verifyProvider(provider, teeList);

  const raw = data.choices?.[0]?.message?.content ?? "";
  if (!raw.trim()) {
    throw new TriageError(
      `${model} returned an empty completion — it is a reasoning model and spent its whole budget thinking. Raise ZEROG_MAX_TOKENS above ${MAX_TOKENS}.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
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
    traceRequestId: trace.request_id ?? null,
    model: data.model ?? model,
    provider,
    providerVerified: check.verified,
    providerName: check.verified ? check.provider.name : null,
    teeType: check.verified ? check.provider.teeType : null,
    teeVerifier: check.verified ? check.provider.teeVerifier : null,
    providerCheckReason: check.verified ? null : check.reason,
    trustMode,
    latencyMs: Date.now() - started,
    usage: data.usage ?? null,
    costUsd: trace.billing?.total_cost_usd_micro
      ? Number(trace.billing.total_cost_usd_micro) / 1_000_000
      : null,

    /* never let a machine call be mistaken for a decision */
    decidedBy: "enclave-first-opinion",
    binding: false,
  };
}

/* Provider signature retrieval — DEAD THROUGH THE ROUTER, kept deliberately.

   GET {provider_url}/v1/proxy/signature/{chatID} is real, but it belongs to the
   direct-SDK flow where you hold the provider's URL. The Router never gives you
   one: no provider record carries a url field, and every router-side candidate
   (/v1/proxy/signature/{id}, /v1/signature/{id}, /v1/verify/{id},
   /v1/attestation/{id}, /v1/requests/{id}, ...) returns 404 for a live chatID.

   We keep this function so the honest answer lives in the code rather than in a
   footnote, and so the UI can say "signature: not available via Router" instead
   of implying a check we never ran. verifyProvider() is what we actually use. */
export async function fetchSignature({ requestId, model, providerUrl }) {
  if (!providerUrl) {
    return {
      available: false,
      reason:
        "the Router does not expose provider URLs, so the direct-SDK signature path is unreachable. Provider identity is verified by address instead — see verifyProvider().",
    };
  }
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
