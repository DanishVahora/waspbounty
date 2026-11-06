/* Swarm preflight and round trip.

   Runs in three stages, and each one tells you exactly what is and is not
   possible with what you currently have:

     1. SEALING      local only. No node, no batch, no network.
     2. READ PATH    the public gateway. No batch needed.
     3. ROUND TRIP   needs SWARM_POSTAGE_BATCH and a reachable Bee node.

   Stage 3 is the only part that needs a postage batch, and it is the only part
   that can cost anything. Stages 1 and 2 prove the integration is correct
   before you spend a token on it.

   Usage:  npm run swarm:check
*/

import {
  seal, unseal, caseKey, upload, download, beeStatus, batchStatus,
  config, publicUrl, configured, SwarmError,
} from "../src/swarm/client.mjs";

const ok = (s) => `  OK    ${s}`;
const no = (s) => `  --    ${s}`;
const bad = (s) => `  FAIL  ${s}`;

const c = config();
console.log("\nSwarm preflight\n");
console.log("  bee node  :", c.beeUrl);
console.log("  gateway   :", c.gateway);
console.log("  batch     :", c.batchId ?? "NOT CONFIGURED");
console.log("");

let failures = 0;

/* ---- 1. sealing, entirely local ---------------------------------------- */
console.log("1. sealing — no network, no batch");
const SAMPLE =
  "A crafted PASV response of 600 bytes causes an unchecked memcpy into a " +
  "fixed 512-byte buffer in lib/ftp.c. Reachable by any client following a " +
  "redirect to an attacker-controlled FTP server.";

let blob, digest;
try {
  process.env.WASP_MASTER_KEY ||= "preflight-only-not-a-real-secret";
  const k = caseKey("wb-preflight");
  const sealed = seal(SAMPLE, k);
  blob = sealed.blob;
  digest = sealed.digest;
  console.log(ok(`sealed ${SAMPLE.length} chars -> ${sealed.bytes} bytes`));
  console.log(no(`sha256 ${digest.slice(0, 32)}…`));

  const back = unseal(blob, k);
  if (back !== SAMPLE) throw new Error("round trip did not match");
  console.log(ok("unsealed and matched the original"));

  /* the important negative: a different case key must NOT open it */
  try {
    unseal(blob, caseKey("wb-some-other-case"));
    console.log(bad("a DIFFERENT case key opened the blob — keys are not isolated"));
    failures++;
  } catch {
    console.log(ok("a different case key cannot open it — per-case isolation holds"));
  }

  /* and tampering must be caught, not silently decrypted to garbage */
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 0xff;
  try {
    unseal(tampered, k);
    console.log(bad("a tampered blob decrypted — GCM auth is not working"));
    failures++;
  } catch {
    console.log(ok("a tampered blob is rejected — the blob authenticates itself"));
  }
} catch (e) {
  console.log(bad(`sealing: ${e.message}`));
  failures++;
}

/* ---- 2. the public read path, no batch needed --------------------------- */
console.log("\n2. read path — the public gateway a judge would use");
try {
  const r = await fetch(`${c.gateway}/health`, { signal: AbortSignal.timeout(15000) });
  console.log(r.ok ? ok(`${c.gateway} reachable (HTTP ${r.status})`) : bad(`gateway HTTP ${r.status}`));
  if (!r.ok) failures++;
} catch (e) {
  console.log(bad(`gateway unreachable: ${e.message}`));
  failures++;
}

/* ---- 3. the round trip, needs a batch ----------------------------------- */
console.log("\n3. round trip — upload, then read back through the PUBLIC gateway");

const bee = await beeStatus();
console.log(bee.reachable ? ok(`bee node reachable: ${c.beeUrl}`) : no(`bee node not reachable (${bee.reason})`));

const batch = await batchStatus();
if (!batch.configured) {
  console.log(no("SWARM_POSTAGE_BATCH not set — skipping"));
  console.log(no("there is no public upload gateway: POST /bzz returns 405"));
  console.log(no("get a batch from a Bee node, or ask Swarm/Arkiv for one"));
} else if (!batch.found) {
  console.log(bad(`batch configured but the node does not know it (${batch.reason})`));
  failures++;
} else if (!batch.usable) {
  console.log(bad(`batch found but NOT usable yet (ttl ${batch.batchTTL}) — wait a few minutes`));
  failures++;
} else {
  console.log(ok(`batch usable · depth ${batch.depth} · ttl ${batch.batchTTL}s · ${batch.utilization}% used`));
  try {
    const up = await upload(blob, { name: "wb-preflight.sealed" });
    console.log(ok(`uploaded -> ${up.reference}`));
    console.log(no(up.url));

    /* read it back through the PUBLIC gateway, not our own node: that is the
       only thing that proves the chunks actually reached the network */
    let got = null;
    for (let i = 1; i <= 5; i++) {
      try {
        got = await download(up.reference);
        break;
      } catch {
        console.log(no(`not on the public gateway yet, retry ${i}/5…`));
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    if (!got) {
      console.log(bad("uploaded but never readable from the public gateway"));
      failures++;
    } else {
      const back = unseal(got, caseKey("wb-preflight"));
      console.log(
        back === SAMPLE
          ? ok("fetched from the public gateway and unsealed — full round trip")
          : bad("fetched but the payload did not match"),
      );
      if (back !== SAMPLE) failures++;
    }
  } catch (e) {
    console.log(bad(e instanceof SwarmError ? e.message : String(e.message).slice(0, 200)));
    failures++;
  }
}

console.log("");
if (failures === 0 && configured()) console.log("  Swarm is fully wired.\n");
else if (failures === 0) console.log("  Everything that can work without a postage batch works.\n");
else console.log(`  ${failures} failure(s) above.\n`);
process.exit(failures === 0 ? 0 : 1);
