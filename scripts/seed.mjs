/* Seed the disclosure board with a realistic spread.

   This exists because an empty board proves nothing on stage. It writes real
   entities to Rabdi with real expiries — nothing here is faked or mocked. What
   it buys us is a board where every column has something to show:

     · deadlines from 2 days out to 90, so the countdown column has a range
     · four projects, so the per-repo filter visibly filters
     · all three verdict outcomes, so "being wrong is not slop" is on screen
     · one response clock already overdue, so ghostCandidates() returns a row

   The fabricated entries deliberately cite things that do not exist
   (CURLOPT_PHANTOM_BUFFER, ssl_reseed_entropy_pool). That is the whole thesis
   made visible: slop is not "wrong", it is "invented".

   Usage:  npm run seed            write the full set
           npm run seed -- --dry   print what it would write, touch nothing
*/

import { createHash, randomBytes } from "node:crypto";
import { ExpirationTime } from "@arkiv-network/sdk";
import { Report, Clock, fitStr } from "../src/arkiv/schema.mjs";
import { u64, u256, addr, str } from "@arkiv-network/sdk/schema";
import {
  clients, accountFromEnv, accessKeyFromEnv, guardedCreate, scrub, RABDI_CHAIN_ID,
} from "../src/arkiv/client.mjs";

const DRY = process.argv.includes("--dry");
const now = Date.now();
const DAY = 86_400_000;

const bond = (eth) => BigInt(Math.round(eth * 1e18));

/* ---------------------------------------------------------------------------
   The reports. `days` is both the disclosure deadline and the entity lifetime —
   they are the same fact, which is the point of using Arkiv for this.
   ------------------------------------------------------------------------- */
const REPORTS = [
  { repo: "curl/curl", issue: 9203, severity: "critical", lane: "priority", state: "open", days: 2,
    title: "Use-after-free in multi handle when CURLMOPT_MAX_HOST_CONNECTIONS is lowered mid-transfer",
    body: "Lowering the cap during an active transfer frees a connection still referenced by the easy handle.",
    bondEth: 0.02 },

  { repo: "openssl/openssl", issue: 24881, severity: "high", lane: "priority", state: "open", days: 9,
    title: "Timing side channel in RSA blinding when BN_FLG_CONSTTIME is dropped",
    body: "On the error path the constant-time flag is not restored, leaving a measurable timing difference.",
    bondEth: 0.02 },

  { repo: "nodejs/node", issue: 54102, severity: "high", lane: "free", state: "open", days: 21,
    title: "Prototype pollution via the --experimental-loader resolve hook",
    body: "A loader returning a crafted object reaches Object.assign without a null-prototype guard.",
    bondEth: 0 },

  { repo: "python/cpython", issue: 118334, severity: "medium", lane: "priority", state: "open", days: 45,
    title: "Integer overflow in bytearray.extend() with a 2GB iterable on 32-bit builds",
    body: "The length computation wraps before the realloc, producing an undersized buffer.",
    bondEth: 0.01 },

  /* VALID — refunded, and a tier was granted. */
  { repo: "curl/curl", issue: 9114, severity: "high", lane: "priority", state: "valid", days: 67,
    title: "Heap overflow in ftp_parse_resp() when a PASV reply exceeds 512 bytes",
    body: "A 600-byte PASV response reaches an unchecked memcpy into a fixed buffer.",
    bondEth: 0.02 },

  /* WRONG — honest, mistaken, refunded in full. The one that matters most. */
  { repo: "openssl/openssl", issue: 24790, severity: "medium", lane: "free", state: "wrong", days: 80,
    title: "Suspected double free in SSL_free() after a failed handshake",
    body: "Reporter misread the refcount; the second release is guarded. Good faith, simply incorrect.",
    bondEth: 0 },

  /* FABRICATED — cites an option that does not exist. */
  { repo: "curl/curl", issue: 9217, severity: "critical", lane: "priority", state: "fabricated", days: 88,
    title: "Critical RCE in curl_easy_setopt() via CURLOPT_PHANTOM_BUFFER",
    body: "No such option exists in the codebase. Invented symbol, invented call path, confident prose.",
    bondEth: 0.02 },

  { repo: "openssl/openssl", issue: 24903, severity: "critical", lane: "priority", state: "fabricated", days: 90,
    title: "Entropy pool exhaustion in ssl_reseed_entropy_pool() under concurrent load",
    body: "The named function does not exist. The report cites line numbers from a file that has none.",
    bondEth: 0.02 },
];

/* ---------------------------------------------------------------------------
   Response clocks. The overdue one is the demo: ghostCandidates() finds it with
   two positive predicates, because the query language has no negation.
   ------------------------------------------------------------------------- */
const CLOCKS = [
  { repo: "curl/curl", issue: 9203, state: "running", dueInDays: 4, startedDaysAgo: 3, bondEth: 0.02 },
  { repo: "nodejs/node", issue: 54102, state: "running", dueInDays: -2, startedDaysAgo: 16, bondEth: 0.02 }, // OVERDUE
  { repo: "openssl/openssl", issue: 24881, state: "answered", dueInDays: 6, startedDaysAgo: 8, bondEth: 0.02 },
];

const account = accountFromEnv();
const accessKey = accessKeyFromEnv();
const c = DRY ? null : clients(account, accessKey);

console.log("WaspBounty — seeding the disclosure board");
console.log("  network :", "Rabdi", RABDI_CHAIN_ID);
console.log("  signer  :", account.address);
console.log("  mode    :", DRY ? "DRY RUN — nothing will be written" : "writing");
console.log("");

let written = 0, failed = 0;
const caseIds = [];

for (const r of REPORTS) {
  const caseId = "wb-" + randomBytes(4).toString("hex");
  caseIds.push({ caseId, repo: r.repo, issue: r.issue });

  const plaintext = JSON.stringify({ summary: r.title, detail: r.body });
  const sealed = Buffer.concat([randomBytes(16), Buffer.from(plaintext, "utf8")]);
  const digest = createHash("sha256").update(plaintext).digest("hex");

  const values = {
    caseId: str(caseId),
    repo: str(r.repo),
    issue: u64(BigInt(r.issue)),
    reporter: addr(account.address),
    severity: str(r.severity),
    state: str(r.state),
    lane: str(r.lane),
    openedAt: u64(BigInt(now - (90 - r.days) * DAY)),
    disclosureAt: u64(BigInt(now + r.days * DAY)),
    bondWei: u256(bond(r.bondEth)),
    digest: str(digest),
    title: str(fitStr(r.title)),
    sealed: new Uint8Array(sealed),
  };

  const label = `${r.state.padEnd(10)} ${String(r.days).padStart(2)}d  ${r.repo}#${r.issue}`;
  if (DRY) { console.log("  would write  " + label); written++; continue; }

  try {
    const options = {
      expiration: ExpirationTime.fromDays(r.days),
      flags: { readonly: false, permissionlessExtension: false },
    };
    const res = await guardedCreate(c, account, accessKey, Report, values, options, { label: "report" });
    console.log(`  ok  ${label}  ${res.entityKey.slice(0, 12)}…`);
    written++;
  } catch (e) {
    console.log(`  FAIL ${label}  ${scrub(String(e.message)).slice(0, 90)}`);
    failed++;
  }
}

console.log("");

for (const k of CLOCKS) {
  const match = caseIds.find((x) => x.repo === k.repo && x.issue === k.issue);
  if (!match) continue;

  const dueAt = now + k.dueInDays * DAY;
  const values = {
    caseId: str(match.caseId),
    repo: str(k.repo),
    maintainer: addr(account.address),
    state: str(k.state),
    dueAt: u64(BigInt(dueAt)),
    respondedAt: u64(k.state === "answered" ? BigInt(now - DAY) : 0n),
    startedAt: u64(BigInt(now - k.startedDaysAgo * DAY)),
    bondWei: u256(bond(k.bondEth)),
  };

  /* An overdue clock still needs a positive lifetime, so it is given a short
     one. The contract decides ghosting from dueAt, not from the entity dying. */
  const lifetimeDays = Math.max(1, k.dueInDays + 7);
  const label = `${k.state.padEnd(9)} due ${String(k.dueInDays).padStart(3)}d  ${k.repo}#${k.issue}` +
                (k.dueInDays < 0 ? "   <- OVERDUE, ghost candidate" : "");

  if (DRY) { console.log("  would write  clock  " + label); written++; continue; }

  try {
    const options = {
      expiration: ExpirationTime.fromDays(lifetimeDays),
      flags: { readonly: false, permissionlessExtension: false },
    };
    const res = await guardedCreate(c, account, accessKey, Clock, values, options, { label: "clock" });
    console.log(`  ok  clock  ${label}  ${res.entityKey.slice(0, 12)}…`);
    written++;
  } catch (e) {
    console.log(`  FAIL clock ${label}  ${scrub(String(e.message)).slice(0, 90)}`);
    failed++;
  }
}

console.log("");
console.log(`  written: ${written}   failed: ${failed}`);
if (!DRY) console.log("  check it:  npm run arkiv:read     or     http://localhost:4318");
