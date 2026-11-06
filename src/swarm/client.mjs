/* ============================================================================
   Swarm — where the report body actually lives.
   ----------------------------------------------------------------------------
   THE SPLIT, AND WHY IT IS THIS WAY ROUND

   Arkiv holds the facts you need to QUERY: repo, severity, state, who reported
   it, when the disclosure clock runs out. Those are indexed columns, they are
   public by design, and the whole disclosure board is built by filtering them.

   Swarm holds the one thing that must NOT be public and cannot be indexed
   anyway: the vulnerability report itself. An unfixed heap overflow in curl,
   readable by anyone, is not a disclosure system — it is an exploit feed.

   So: the body is encrypted locally, the ciphertext goes to Swarm, and the
   Arkiv entity carries only the 64-hex reference in `swarmRef`.

   WHY WE ENCRYPT OURSELVES RATHER THAN USING swarm-encrypt
   Swarm can encrypt for you, but then the reference it returns is 128 hex
   characters instead of 64 — and the second half IS the decryption key. Arkiv
   entities are public. Storing that reference in one would publish the key next
   to the pointer, which is worse than not encrypting at all, because it looks
   safe. Arkiv's own prize page warns about exactly this.

   We therefore encrypt with AES-256-GCM, upload the ciphertext with
   swarm-encrypt OFF, and store the plain 64-hex reference. Anyone may fetch the
   blob; without the case key it is noise. The key never touches Arkiv.
   ========================================================================= */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/* A Bee node's API. There is no public upload gateway: gateway.ethswarm.org
   answers GET /bzz/<ref> and returns 405 for POST, verified 2026-11-06. */
const BEE = (process.env.SWARM_BEE_URL || "http://localhost:1633").replace(/\/$/, "");
const BATCH = process.env.SWARM_POSTAGE_BATCH || "";

/* Reads can go through any public gateway, which is what makes the reference
   something a judge can open in a browser without running anything. */
export const PUBLIC_GATEWAY = (process.env.SWARM_GATEWAY || "https://gateway.ethswarm.org").replace(/\/$/, "");
export const publicUrl = (ref) => `${PUBLIC_GATEWAY}/bzz/${ref}/`;

export class SwarmError extends Error {}

export const configured = () => Boolean(BATCH);
export const config = () => ({
  beeUrl: BEE,
  gateway: PUBLIC_GATEWAY,
  batchConfigured: Boolean(BATCH),
  /* never print the whole batch id in logs we might paste somewhere */
  batchId: BATCH ? BATCH.slice(0, 8) + "…" + BATCH.slice(-6) : null,
});

/* ---------- sealing -------------------------------------------------------- */

/* AES-256-GCM. The IV and the auth tag travel WITH the ciphertext, because they
   are not secret and losing them means losing the payload; the key does not. */
export function seal(plaintext, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new SwarmError("seal() needs a 32-byte key — use caseKey()");
  }
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(Buffer.from(plaintext, "utf8")), c.final()]);
  const tag = c.getAuthTag();

  /* v1 | iv(12) | tag(16) | ciphertext */
  const blob = Buffer.concat([Buffer.from([1]), iv, tag, body]);
  return {
    blob,
    digest: createHash("sha256").update(blob).digest("hex"),
    bytes: blob.length,
  };
}

export function unseal(blob, key) {
  const b = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (b.length < 29 || b[0] !== 1) throw new SwarmError("not a v1 sealed blob");
  const iv = b.subarray(1, 13);
  const tag = b.subarray(13, 29);
  const body = b.subarray(29);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  /* throws if the ciphertext was altered — GCM authenticates, which is the
     point: a blob fetched from a public network must prove it is untampered */
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

/* One key per case, derived from a master secret, so disclosing one report
   never discloses the others. Give a maintainer the case key and they can read
   exactly that report and nothing else. */
export function caseKey(caseId, master = process.env.WASP_MASTER_KEY) {
  if (!master) throw new SwarmError("WASP_MASTER_KEY not set — cannot derive a case key");
  return createHash("sha256").update(`wasp:v1:${master}:${caseId}`).digest();
}

/* ---------- the network ---------------------------------------------------- */

/* Upload. swarm-deferred-upload is FALSE on purpose: the default (true) keeps
   the chunks on the local node and pushes them later, which means the reference
   resolves for us and 404s for a judge. For a demo that is the difference
   between working and appearing to work. */
export async function upload(blob, { name = "report.sealed", pin = true } = {}) {
  if (!BATCH) {
    throw new SwarmError(
      "SWARM_POSTAGE_BATCH not set. A batch is required to upload — there is no public upload gateway. Buy one on a Bee node, or ask Swarm/Arkiv for a batch id.",
    );
  }
  const res = await fetch(`${BEE}/bzz?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "swarm-postage-batch-id": BATCH,
      "swarm-deferred-upload": "false",
      ...(pin ? { "swarm-pin": "true" } : {}),
    },
    body: blob,
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new SwarmError(`Bee upload failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  let ref;
  try {
    ref = JSON.parse(text).reference;
  } catch {
    throw new SwarmError(`Bee returned unparseable JSON: ${text.slice(0, 160)}`);
  }
  if (!/^[0-9a-f]{64}$/i.test(ref ?? "")) {
    /* 128 chars means the node encrypted it and the key is in the reference —
       refuse rather than publish that pointer to a public Arkiv entity */
    throw new SwarmError(
      `expected a 64-hex reference, got ${ref?.length} chars. A 128-char reference embeds the decryption key and must never be stored on Arkiv.`,
    );
  }
  return { reference: ref, url: publicUrl(ref), bytes: blob.length };
}

/* Read back. Defaults to the PUBLIC gateway rather than our own node, because
   the claim we want to make is "anyone can fetch this", and testing against
   localhost would never catch an upload that was never pushed to the network. */
export async function download(reference, { via = PUBLIC_GATEWAY } = {}) {
  if (!/^[0-9a-f]{64}$/i.test(reference)) throw new SwarmError("reference must be 64 hex chars");
  const res = await fetch(`${via.replace(/\/$/, "")}/bzz/${reference}/`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new SwarmError(`Swarm read failed: HTTP ${res.status} via ${via}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ---------- health --------------------------------------------------------- */

export async function beeStatus() {
  try {
    const r = await fetch(`${BEE}/health`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { reachable: false, reason: `HTTP ${r.status}` };
    return { reachable: true, ...(await r.json().catch(() => ({}))) };
  } catch (e) {
    return { reachable: false, reason: String(e.message).slice(0, 120) };
  }
}

/* Is the batch actually usable yet? A fresh batch exists on chain minutes
   before other nodes will accept chunks stamped with it, and uploading in that
   window fails in a way that looks like a broken node. */
export async function batchStatus() {
  if (!BATCH) return { configured: false };
  try {
    const r = await fetch(`${BEE}/stamps/${BATCH}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { configured: true, found: false, reason: `HTTP ${r.status}` };
    const b = await r.json();
    return {
      configured: true,
      found: true,
      usable: b.usable === true,
      batchTTL: b.batchTTL,
      depth: b.depth,
      amount: b.amount,
      utilization: b.utilization,
    };
  } catch (e) {
    return { configured: true, found: false, reason: String(e.message).slice(0, 120) };
  }
}
