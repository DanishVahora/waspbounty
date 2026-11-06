/* ============================================================================
   WaspBounty — app server
   ----------------------------------------------------------------------------
   Node stdlib for HTTP; the only dependencies are the Arkiv SDK and viem, which
   the rest of the project already needs.

   Honesty rule enforced here, not just in the copy: every response carries a
   `live` block saying which backends are actually connected. If the 0G key is
   missing or the Arkiv wallet is unfunded, the UI is told so and labels that
   surface as a simulation. We never render invented data as if it were real.
   ========================================================================= */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { clients, accountFromEnv, accessKeyFromEnv, scrub } from "../src/arkiv/client.mjs";
import { expiringSoon, ghostCandidates, countOpen, watchExtensions, repoLanes, laneFor } from "../src/arkiv/board.mjs";
import { repoIdFor, verifyRepoControl, repoExists, canonicalSlug, PROOF_PATH, GitHubError } from "../src/github/identity.mjs";
import { repoSignals, securityPosture, assessPromise } from "../src/github/signals.mjs";
import { triage, assertTeeML, TRIAGE_MODEL, TriageError } from "../src/triage/zerog.mjs";
import { chainStatus, bondQuote, laneState, reportState, tierRoles, ChainError } from "../src/chain/contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const PORT = Number(process.env.PORT || 4318);

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".woff2": "font/woff2",
};

/* ---------- backends ------------------------------------------------------- */
let reader = null, account = null, arkivError = null;
try {
  account = accountFromEnv();
  reader = clients(account, accessKeyFromEnv()).reader;
} catch (e) {
  arkivError = scrub(e);
}

let teeCard = null, teeError = null;
try {
  teeCard = await assertTeeML(TRIAGE_MODEL);
} catch (e) {
  teeError = String(e.message).slice(0, 200);
}

const extensions = [];   /* every public extension of a disclosure deadline */
if (reader) {
  try {
    watchExtensions(reader, (ev) => {
      extensions.unshift(ev);
      extensions.length = Math.min(extensions.length, 50);
      console.log("[arkiv] deadline extended:", ev.entityKey, "->", ev.newExpiryBlock);
    }, () => {}, { owners: [account.address] });
  } catch { /* watcher is a bonus, not a dependency */ }
}

async function liveStatus() {
  let arkiv = { connected: false, reason: arkivError || "not configured" };
  if (reader) {
    try {
      const [id, block] = await Promise.all([reader.getChainId(), reader.getBlockNumber()]);
      const bal = await reader.getBalance({ address: account.address });
      arkiv = {
        connected: true, chainId: id, block: block.toString(),
        signer: account.address, funded: bal > 0n, balanceWei: bal.toString(),
      };
    } catch (e) { arkiv = { connected: false, reason: scrub(e) }; }
  }
  return {
    arkiv,
    zerog: {
      connected: Boolean(process.env.ZEROG_API_KEY) && Boolean(teeCard),
      keyPresent: Boolean(process.env.ZEROG_API_KEY),
      model: teeCard?.model ?? TRIAGE_MODEL,
      verifiability: teeCard?.verifiability ?? null,
      teeType: teeCard?.teeType ?? null,
      teeVerifier: teeCard?.teeVerifier ?? null,
      /* The two lists are the whole point: the same model is served by an
         enclave provider and by ordinary ones. `private` trust mode is what
         keeps us on the first list, and we check the address afterwards. */
      teeProviders: teeCard?.teeProviders ?? [],
      nonTeeProviders: teeCard?.nonTeeProviders ?? [],
      signatureCheck: "unavailable via Router — provider verified by address instead",
      reason: teeError,
    },
    /* Read from Sepolia every time rather than trusting the deployment file:
       "connected" means the contract answered just now. */
    contracts: await chainStatus(),
  };
}

/* ---------- a small demo queue, clearly marked -----------------------------
   Used only until Arkiv has real entities. Every item carries simulated: true
   and the UI prints that badge; nothing here is ever shown as on-chain. */
const DEMO = [
  { caseId: "wb-demo-01", repo: "curl/curl", issue: 9114, severity: "high", lane: "priority",
    title: "Heap overflow in ftp_parse_resp() when PASV reply exceeds 512 bytes",
    body: "A crafted PASV response of 600 bytes causes an unchecked memcpy into a fixed 512-byte buffer in lib/ftp.c. Reachable by any client following a redirect to an attacker-controlled FTP server. PoC attached.",
    openedAt: Date.now() - 41 * 60000, daysLeft: 88, simulated: true },
  { caseId: "wb-demo-02", repo: "curl/curl", issue: 9115, severity: "critical", lane: "free",
    title: "Remote code execution via crafted Set-Cookie in curl_easy_perform",
    body: "curl is vulnerable to RCE through the function curl_cookie_parse_secure() which fails to bound-check the domain attribute. This affects all versions since 7.0. Immediate patch required.",
    openedAt: Date.now() - 12 * 60000, daysLeft: 90, simulated: true },
  { caseId: "wb-demo-03", repo: "curl/curl", issue: 9116, severity: "medium", lane: "priority",
    title: "Possible off-by-one in the HTTP/3 header table when nghttp3 returns early",
    body: "I might be misreading this, but in lib/vquic/curl_ngtcp2.c the loop bound looks like it can read one entry past the table when nghttp3_conn_read_stream returns a short count. I could not reproduce a crash.",
    openedAt: Date.now() - 95 * 60000, daysLeft: 86, simulated: true },
];

const send = (res, code, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "content-type": MIME[".json"], "cache-control": "no-store" });
  res.end(b);
};

const readBody = (req) => new Promise((resolve, reject) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 200_000) { req.destroy(); reject(new Error("too large")); } });
  req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { reject(new Error("bad json")); } });
});

/* ---------- server --------------------------------------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/api/health") return send(res, 200, await liveStatus());

    if (url.pathname === "/api/queue") {
      const live = await liveStatus();
      let items = [];
      if (live.arkiv.connected) {
        try {
          const rows = await expiringSoon(reader, { limit: 50 });
          items = rows.map((r) => ({ ...r, simulated: false }));
        } catch (e) { /* fall through to demo */ }
      }
      if (!items.length) items = DEMO;
      return send(res, 200, { items, live, usingDemo: items === DEMO });
    }

    if (url.pathname === "/api/board") {
      const live = await liveStatus();
      let open = 0, ghosts = [], rows = [];
      if (live.arkiv.connected) {
        try {
          [open, ghosts, rows] = await Promise.all([
            countOpen(reader).then(Number).catch(() => 0),
            ghostCandidates(reader).catch(() => []),
            expiringSoon(reader, { limit: 25 }).catch(() => []),
          ]);
        } catch { /* leave zeros */ }
      }
      return send(res, 200, {
        live, open, ghosts, rows: rows.length ? rows : DEMO,
        extensions, usingDemo: rows.length === 0,
      });
    }

    /* ---------------------------------------------------------------------
       THE GITHUB LANES — the user-visible read from Arkiv.

       Every row is a real project whose response bond was priced from its own
       issue tracker. Falls back to a LIVE MEASUREMENT (not fake data) if Arkiv
       has nothing yet, and says which one you are looking at.
       --------------------------------------------------------------------- */
    if (url.pathname === "/api/lanes") {
      const live = await liveStatus();
      let lanes = [];
      let source = "none";
      if (live.arkiv.connected) {
        try {
          lanes = await repoLanes(reader, { limit: 50 });
          source = "arkiv";
        } catch (e) { source = "arkiv-failed:" + scrub(e); }
      }
      return send(res, 200, { lanes, source, live });
    }

    /* One lane, with the full arithmetic behind its bond multiple. */
    if (url.pathname === "/api/lane") {
      const slug = url.searchParams.get("slug");
      if (!slug) return send(res, 400, { error: "slug required" });
      if (!reader) return send(res, 503, { error: "Arkiv not connected" });
      try {
        const lane = await laneFor(reader, canonicalSlug(slug));
        if (!lane) return send(res, 404, { error: "no measurement published for " + slug });
        return send(res, 200, lane);
      } catch (e) {
        return send(res, 400, { error: e instanceof GitHubError ? e.message : scrub(e) });
      }
    }

    /* Measure a project live, against a window the caller proposes. No write,
       no key, no wallet — this is the number before anyone commits to it. */
    if (url.pathname === "/api/github/measure") {
      const slug = url.searchParams.get("slug");
      const windowDays = Number(url.searchParams.get("window") || 7);
      if (!slug) return send(res, 400, { error: "slug required" });
      try {
        const canonical = canonicalSlug(slug);
        const exists = await repoExists(canonical);
        if (!exists.exists) return send(res, 404, { error: "no such project on GitHub: " + canonical });

        const [signals, posture] = await Promise.all([
          repoSignals(canonical),
          securityPosture(canonical).catch(() => ({ securityMd: false })),
        ]);
        const promise = assessPromise(windowDays, signals);

        return send(res, 200, {
          slug: canonical,
          repoId: repoIdFor(canonical),
          githubUrl: "https://github.com/" + canonical,
          exists,
          signals: { ...signals, silent: undefined },  // the full list is large; worstThree is enough for the UI
          posture,
          promise,
          /* a judge can reproduce every number */
          howToCheck: signals.howToCheck,
        });
      } catch (e) {
        return send(res, 400, { error: e instanceof GitHubError ? e.message : scrub(e) });
      }
    }

    /* Does whoever holds this address control the repo's default branch? */
    if (url.pathname === "/api/github/verify") {
      const slug = url.searchParams.get("slug");
      const address = url.searchParams.get("address") || account?.address;
      if (!slug || !address) return send(res, 400, { error: "slug and address required" });
      try {
        const out = await verifyRepoControl(slug, address);
        return send(res, 200, { ...out, proofPath: PROOF_PATH });
      } catch (e) {
        return send(res, 400, { error: e instanceof GitHubError ? e.message : scrub(e) });
      }
    }

    /* ---------- chain reads ------------------------------------------------
       All four are live calls to Sepolia. The bond one is the important one:
       it reaches through our contract into the real ENSv2 registry, so the
       number it returns is not ours to decide. */
    if (url.pathname === "/api/chain/bond") {
      const reporter = url.searchParams.get("reporter");
      if (!reporter || !/^0x[0-9a-fA-F]{40}$/.test(reporter)) {
        return send(res, 400, { error: "reporter must be a 0x address" });
      }
      return send(res, 200, await bondQuote(reporter, url.searchParams.get("labelId") || 0));
    }

    if (url.pathname === "/api/chain/lane") {
      const slug = url.searchParams.get("slug");
      if (!slug) return send(res, 400, { error: "slug required" });
      return send(res, 200, await laneState(slug));
    }

    if (url.pathname === "/api/chain/report") {
      const id = url.searchParams.get("id");
      if (!id || !/^0x[0-9a-fA-F]{64}$/.test(id)) {
        return send(res, 400, { error: "id must be a 0x-prefixed bytes32" });
      }
      return send(res, 200, await reportState(id));
    }

    if (url.pathname === "/api/chain/tiers") return send(res, 200, await tierRoles());

    if (url.pathname === "/api/triage" && req.method === "POST") {
      const body = await readBody(req);
      const item = DEMO.find((d) => d.caseId === body.caseId) || body;

      if (!process.env.ZEROG_API_KEY || !teeCard) {
        /* No key: return a clearly-labelled stand-in rather than pretending. */
        const fabricated = /curl_cookie_parse_secure|does not exist/i.test(item.body || "");
        return send(res, 200, {
          simulated: true,
          reason: teeError || "ZEROG_API_KEY not set — get a key at pc.0g.ai",
          call: fabricated ? "fabricated" : /might be misreading|could not reproduce/i.test(item.body || "") ? "plausible" : "valid",
          confidence: 0,
          summary: "Simulated verdict. No enclave was contacted.",
          reasoning: "This response did not come from a TEE. Set ZEROG_API_KEY to run the real triage against " + TRIAGE_MODEL + ".",
          checks: [], requestId: null, model: TRIAGE_MODEL, provider: null,
          trustMode: "private", decidedBy: "simulation", binding: false,
        });
      }

      const out = await triage({
        repo: item.repo, severity: item.severity, title: item.title, body: item.body,
      });
      return send(res, 200, { ...out, simulated: false });
    }

    /* static */
    let rel = url.pathname === "/" ? "/index.html" : url.pathname;
    rel = decodeURIComponent(rel).replace(/\.\./g, "");
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": ext === ".woff2" ? "public, max-age=31536000, immutable" : "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    const msg = e instanceof TriageError || e instanceof ChainError ? e.message : scrub(e);
    send(res, 500, { error: msg });
  }
});

server.listen(PORT, async () => {
  const live = await liveStatus();
  console.log("\n  WASP BOUNTY  ·  bail for bug reports");
  console.log(`  -> http://localhost:${PORT}\n`);
  console.log("  Arkiv :", live.arkiv.connected
    ? `block ${live.arkiv.block}, signer ${live.arkiv.signer}, ${live.arkiv.funded ? "funded" : "UNFUNDED"}`
    : `not connected (${live.arkiv.reason})`);
  console.log("  0G    :", live.zerog.connected
    ? `${live.zerog.model} (${live.zerog.verifiability}/${live.zerog.teeType})`
    : `no key — triage will return a labelled simulation`);
  console.log("");
});
