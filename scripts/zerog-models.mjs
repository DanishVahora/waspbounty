/* Resolve which 0G models actually run inside a TEE.
   The docs never list this — they only say TeeML exists. The live catalog is
   the only source of truth, and GET /v1/models needs no auth.

   P0-8. Answers: which model id do we point the triage at? */

const BASE = process.env.ZEROG_BASE_URL || "https://router-api.0g.ai/v1";
const KEY = process.env.ZEROG_API_KEY;

const get = async (path) => {
  const r = await fetch(BASE + path, {
    headers: KEY ? { Authorization: `Bearer ${KEY}` } : {},
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json();
};

console.log("0G Router catalog");
console.log("  base:", BASE);
console.log("  auth:", KEY ? "sk- key present" : "none (public catalog)");
console.log("");

try {
  const models = await get("/models");
  const list = models.data || models.models || [];
  console.log("  models returned:", list.length);

  /* find the capability flag that marks a TEE model, whatever it is called */
  const sample = list[0] || {};
  const flagKeys = Object.keys(sample).filter((k) => /tee|trust|private|secure|verif|enclave/i.test(k));
  console.log("  capability-ish fields on a model card:", flagKeys.join(", ") || "(none obvious)");
  console.log("  all fields:", Object.keys(sample).join(", "));
  console.log("");

  const isTee = (m) => JSON.stringify(m).match(/tee|teeml|enclave/i);
  const tee = list.filter(isTee);
  const chat = list.filter((m) => !/image|video|audio|voice|embed|rerank|tts|whisper/i.test(m.id || ""));

  console.log("  TEE-flagged models:", tee.length);
  for (const m of tee.slice(0, 25)) {
    console.log("    ·", m.id, "|", JSON.stringify(m).match(/"(tee[^"]*|[^"]*tee)"\s*:\s*[^,}]+/i)?.[0] || "");
  }
  console.log("");
  console.log("  chat-capable ids (first 25 of " + chat.length + "):");
  for (const m of chat.slice(0, 25)) console.log("    ·", m.id);

  /* If the catalog does not carry the flag, providers do. */
  const probe = tee[0]?.id || chat.find((m) => /glm|0gm|qwen|llama/i.test(m.id))?.id;
  if (probe) {
    console.log("");
    console.log("  probing providers for:", probe);
    try {
      const p = await get(`/providers?model=${encodeURIComponent(probe)}`);
      const provs = p.data || p.providers || [];
      console.log("  providers:", provs.length);
      for (const pr of provs.slice(0, 6)) {
        console.log("    ·", JSON.stringify(pr).slice(0, 220));
      }
    } catch (e) {
      console.log("  providers lookup failed:", String(e.message).slice(0, 160));
    }
  }
} catch (e) {
  console.error("FAILED:", String(e.message).slice(0, 300));
  process.exit(1);
}
