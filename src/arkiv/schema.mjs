/* ============================================================================
   WaspBounty on Arkiv — the four entities
   ----------------------------------------------------------------------------
   Design constraints that shaped this (SDK 1.0.x, verified against the installed
   package and the official skills):

   · Only `.indexed()` columns can be filtered or sorted. `bytes` can never be.
   · `str` is capped at 128 BYTES. Anything longer lives in a `bytes` column.
   · The network supports no `!=` and no `NOT`. Every filter must be expressible
     positively — which is why `state` is an explicit enum string and why the
     clock carries `respondedAt` rather than a "not answered" flag.
   · A named schema costs one of the 32 attributes, leaving 31.
   · Max lifetime is ~182.5 days, so a 90-day disclosure clock fits with room.

   The expiry is not a storage optimisation here. It IS the product:
   a report entity dies on day 90, and the only way it lives longer is a public,
   signed extension that Arkiv announces via onExpiryExtended.
   ========================================================================= */

import { defineSchema, str, bytes, u64, u256, i32, addr, bool } from "@arkiv-network/sdk/schema";

/* The disclosure record. Expires on day 90 — the Project Zero norm.
   Letting it die is silent; extending it is a public act. */
export const Report = defineSchema("wasp.report", {
  caseId: str().indexed(),        // our id, e.g. "wb-7c41ae"
  repo: str().indexed(),          // "curl/curl"
  issue: u64().indexed(),         // github issue number
  reporter: addr().indexed(),
  severity: str().indexed(),      // low | medium | high | critical
  state: str().indexed(),         // open | valid | wrong | fabricated | ghosted
  lane: str().indexed(),          // free | priority
  openedAt: u64().indexed(),      // ms
  disclosureAt: u64().indexed(),  // ms — day 90, mirrors $expiresAt for the board
  bondWei: u256(),
  digest: str(),                  // sha256 hex of the sealed payload (64 chars)
  title: str(),                   // truncated to 128 bytes on write
  sealed: bytes(),                // the report itself, encrypted before storing
});

/* The maintainer's promise. Expires at the response deadline.
   If it expires without being patched to "answered", the maintainer ghosted —
   and that is provable by absence, because Arkiv emits no event on expiry. */
export const Clock = defineSchema("wasp.clock", {
  caseId: str().indexed(),
  repo: str().indexed(),
  maintainer: addr().indexed(),
  state: str().indexed(),         // running | answered | ghosted
  dueAt: u64().indexed(),         // ms
  respondedAt: u64().indexed(),   // ms, 0 while running
  startedAt: u64().indexed(),
  bondWei: u256(),
});

/* What the sealed chip said, and the receipt that proves it said it. */
export const Verdict = defineSchema("wasp.verdict", {
  caseId: str().indexed(),
  call: str().indexed(),          // fabricated | plausible | valid
  model: str().indexed(),
  requestId: str().indexed(),     // the ZG-Res-Key
  provider: addr().indexed(),
  trustMode: str().indexed(),     // private | verified | standard
  verified: bool().indexed(),     // signature checked against teeSignerAddress
  at: u64().indexed(),
  summary: str(),                 // <= 128 bytes
  signature: bytes(),
  reasoning: bytes(),
});

/* A tier, earned at one project and spendable at the next.
   It expires too: reputation that never decays is just seniority. */
export const Tier = defineSchema("wasp.tier", {
  subject: addr().indexed(),
  ensName: str().indexed(),       // newcomer.waspbounty.eth
  tier: i32().indexed(),          // 0-15, one ENSv2 nybble
  earnedAt: u64().indexed(),
  earnedOn: str().indexed(),      // repo where it was earned
  caseId: str().indexed(),
  txHash: str(),                  // the settlement that granted it
});

/* ---------------------------------------------------------------------------
   THE GITHUB BINDING — what makes `repo: "curl/curl"` above mean anything.

   Until this entity existed, every other schema here carried a repo as a
   decorative string. Nothing said the project was real, and nothing said the
   address holding the response bond had any authority over it.

   This entity is the measurement AND the proof, published where a stranger can
   read it without asking us:
     - `proofUrl` is a raw.githubusercontent.com link a judge can curl
     - `repoId` is the on-chain lane id, recomputable from `slug` alone
     - the signal columns are the arithmetic behind the bond multiple

   WHY IT EXPIRES, AND WHY THAT IS THE POINT

   A claim about how fast a project answers reports is true on the day it is
   measured and decays from then on. A permanent record of "curl had 10
   unanswered issues" would become a lie without anyone editing it.

   So this entity is written with a 30-day lifetime. Stale evidence disappears
   on its own rather than quietly misinforming the next reporter, and a lane
   whose measurement has expired is visibly unmeasured instead of falsely
   reassuring. Letting it die is the default; renewing it requires measuring
   again.
   --------------------------------------------------------------------------- */
export const RepoBinding = defineSchema("wasp.repo", {
  slug: str().indexed(),               // "curl/curl", lowercase and canonical
  repoId: str().indexed(),             // the on-chain lane id, 66 chars of hex
  maintainer: addr().indexed(),
  verified: bool().indexed(),          // the proof file named this address
  windowDays: u64().indexed(),         // the promise being made
  promiseSupported: bool().indexed(),  // does their own record back it up

  stars: u64().indexed(),
  openIssues: u64().indexed(),         // non-PR, sampled
  unanswered: u64().indexed(),         // zero replies
  oldestUnansweredDays: u64().indexed(),
  breaches: u64().indexed(),           // already waited longer than windowDays
  bondBasisPoints: u64().indexed(),    // 1.51x stored as 15100 — never a float
  securityMd: bool().indexed(),
  measuredAt: u64().indexed(),         // ms

  proofUrl: str(),                     // curl this to check the binding yourself
  evidence: bytes(),                   // the full signals JSON, so the maths is auditable
});

export const SCHEMAS = { Report, Clock, Verdict, Tier, RepoBinding };

/* str() is 128 BYTES, not 128 characters. Truncate on the byte boundary so a
   multi-byte character can never be cut in half. */
export function fitStr(input, max = 128) {
  const enc = new TextEncoder();
  let s = String(input ?? "");
  if (enc.encode(s).length <= max) return s;
  while (enc.encode(s).length > max - 1 && s.length > 0) s = s.slice(0, -1);
  return s + "…";
}
