/* Bind a real GitHub project to a WaspBounty lane, and publish the evidence.

   This is the whole GitHub integration end to end:
     1. derive the lane id from the project name   (nobody can disagree about it)
     2. check who controls the default branch      (one curl, no OAuth)
     3. measure how this project actually treats reports it already has
     4. price the response bond from that record, against the promise being made
     5. publish all of it to Arkiv with a 30-day lifetime, because a
        responsiveness measurement stops being true

   Usage:
     npm run github:bind -- curl/curl --window 7          measure + publish
     npm run github:bind -- curl/curl --window 7 --dry     measure only, no write
*/

import { ExpirationTime } from "@arkiv-network/sdk";
import { u64, addr, str, bool } from "@arkiv-network/sdk/schema";
import { RepoBinding, fitStr } from "../src/arkiv/schema.mjs";
import { repoIdFor, verifyRepoControl, repoExists, PROOF_PATH } from "../src/github/identity.mjs";
import { repoSignals, securityPosture, assessPromise } from "../src/github/signals.mjs";
import {
  clients, accountFromEnv, accessKeyFromEnv, guardedCreate, scrub, RABDI_CHAIN_ID,
} from "../src/arkiv/client.mjs";

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith("--")) || "curl/curl";
const windowDays = Number(argv[argv.indexOf("--window") + 1]) || 7;
const dry = argv.includes("--dry");

const account = accountFromEnv();

console.log("WaspBounty · binding a GitHub project to a lane");
console.log("  project :", slug);
console.log("  promise :", windowDays, "day response window");
console.log("  lane id :", repoIdFor(slug));
console.log("            keccak256(\"github.com/" + slug + "\") — recomputable by anyone");
console.log("");

/* ---- 1. does it exist? ---------------------------------------------------- */
const exists = await repoExists(slug);
if (!exists.exists) {
  console.error("  no such project on GitHub:", slug);
  process.exit(1);
}
console.log("  EXISTS    default branch:", exists.defaultBranch, exists.archived ? "(ARCHIVED)" : "");

/* ---- 2. who controls the default branch? --------------------------------- */
const control = await verifyRepoControl(slug, account.address);
console.log("");
if (control.verified) {
  console.log("  CONTROL   proved by", PROOF_PATH, "on the default branch");
  console.log("            " + control.howToCheck);
  console.log("            proves:", control.proves);
} else {
  console.log("  CONTROL   NOT PROVED —", control.reason);
  console.log("            " + (control.howToFix ?? ""));
  console.log("            Publishing the measurement anyway: the SIGNALS below are");
  console.log("            public facts about a public repo and need no permission.");
  console.log("            Only the maintainer SEAT needs the proof, and it stays shut.");
}

/* ---- 3 & 4. the record, and the price of the promise --------------------- */
const signals = await repoSignals(slug);
const posture = await securityPosture(slug);
const promise = assessPromise(windowDays, signals);
const risk = promise.risk;

console.log("");
console.log("  RECORD    stars", signals.stars.toLocaleString(), "· last push", signals.lastPushDays + "d ago");
console.log("            open issues sampled :", signals.openIssuesSampled, signals.sampleCapped ? "(capped at 100)" : "");
console.log("            with ZERO replies   :", signals.unanswered);
console.log("            worst wait          :", signals.oldestUnansweredDays, "days");
console.log("            SECURITY.md         :", posture.securityMd ? "yes" : "no");
if (posture.recentAdvisory) {
  console.log("            last advisory       :", posture.recentAdvisory.ghsa, posture.recentAdvisory.severity);
}
console.log("");
console.log("  PROMISE   " + windowDays + " days ->", promise.supported ? "SUPPORTED by the record" : "NOT SUPPORTED");
console.log("            " + promise.note);
console.log("            response bond: " + risk.bondMultiple + "x base   (" + risk.band + ")");
console.log("            " + risk.arithmetic.formula);
for (const b of risk.breachExamples) {
  console.log("              already waited " + b.waitingDays + "d: " + b.url);
}

if (dry) {
  console.log("");
  console.log("  --dry: nothing written to Arkiv.");
  process.exit(0);
}

/* ---- 5. publish the evidence where a stranger can read it ---------------- */
const accessKey = accessKeyFromEnv();
const c = clients(account, accessKey);
const now = Date.now();

console.log("");
console.log("  -> Arkiv (Rabdi " + RABDI_CHAIN_ID + "), 30-day lifetime");

try {
  const values = {
    slug: str(signals.slug),
    repoId: str(repoIdFor(slug)),
    maintainer: addr(account.address),
    verified: bool(control.verified),
    windowDays: u64(BigInt(windowDays)),
    promiseSupported: bool(promise.supported),

    stars: u64(BigInt(signals.stars)),
    openIssues: u64(BigInt(signals.openIssuesSampled)),
    unanswered: u64(BigInt(signals.unanswered)),
    oldestUnansweredDays: u64(BigInt(signals.oldestUnansweredDays)),
    breaches: u64(BigInt(risk.breaches)),
    /* 1.51x stored as 15100. Money-adjacent numbers are never floats. */
    bondBasisPoints: u64(BigInt(Math.round(risk.bondMultiple * 10_000))),
    securityMd: bool(posture.securityMd),
    measuredAt: u64(BigInt(now)),

    proofUrl: str(fitStr(control.url ?? "")),
    /* the full arithmetic, so a maintainer can audit the number rather than
       take our word for it */
    evidence: new TextEncoder().encode(JSON.stringify({
      risk,
      posture,
      worstThree: signals.worstThree,
      howToCheck: signals.howToCheck,
      measuredAt: new Date(now).toISOString(),
    })),
  };

  const res = await guardedCreate(
    c, account, accessKey, RepoBinding, values,
    { expiration: ExpirationTime.fromDays(30), flags: { readonly: false, permissionlessExtension: false } },
    { label: "repo-binding" },
  );

  console.log("     WRITTEN  entityKey:", res.entityKey);
  console.log("              txHash   :", res.txHash);
  console.log("              expires  : block", res.expiresAt?.toString());

  const back = await c.reader.getEntity(res.entityKey, RepoBinding);
  console.log("");
  console.log("     READ BACK");
  console.log("              " + back.slug.value + "  bond " + (Number(back.bondBasisPoints.value) / 10_000) + "x");
  console.log("              " + back.unanswered.value + " unanswered of " + back.openIssues.value +
              "  worst " + back.oldestUnansweredDays.value + "d");
  console.log("              verified seat:", back.verified.value);
  console.log("");
  console.log("     explorer: https://rabdi.explorer.arkiv.network/tx/" + res.txHash);
} catch (e) {
  console.error("     FAILED:", scrub(e));
  if (e.txHash) console.error("     admitted tx (do NOT resend):", e.txHash);
  process.exit(1);
}
