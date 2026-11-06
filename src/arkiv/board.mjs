/* ============================================================================
   The disclosure board — the user-visible READ from Arkiv.
   ----------------------------------------------------------------------------
   Arkiv's rubric auto-disqualifies a project where the SDK is installed but
   never used to read, or where Arkiv is "a log nothing reads". This module is
   the answer to that: the board is a real feature, and it cannot be built on
   anything but Arkiv.

   What it shows that a database cannot:
     · which reports are running out of clock   (ordered by $expiresAt)
     · WHO EXTENDED THEIRS                      (onExpiryExtended — a public act)
     · which maintainers ghosted                (a clock that expired unanswered)

   Query notes that cost real time to learn:
     · only .indexed() columns can be filtered or sorted
     · the network has no `!=` and no `NOT`, so "still open" is expressed as an
       explicit equality against a state enum, never as a negation
     · a rejected query raises QueryError — it is NOT an empty result
   ========================================================================= */

import { eq, and, gt, lt, desc, asc } from "@arkiv-network/sdk/query";
import { str, u64, addr } from "@arkiv-network/sdk/schema";
import { Report, Clock, Verdict, Tier, RepoBinding } from "./schema.mjs";

const PAGE = 100; // MAX_LIMIT

/* Reports closest to their disclosure deadline, soonest first. */
export async function expiringSoon(reader, { limit = 20 } = {}) {
  const { entities } = await reader
    .select({ $key: true, $expiresAt: true, caseId: true, repo: true, issue: true, severity: true, state: true, disclosureAt: true, title: true })
    .from(Report)
    .where(eq("state", str("open")))
    .orderBy(asc("disclosureAt"))
    .limit(Math.min(limit, PAGE))
    .fetch();

  return entities.map(shapeReport);
}

/* Everything for one repo, newest first. */
export async function byRepo(reader, repo, { limit = 50 } = {}) {
  const { entities } = await reader
    .select({ $key: true, $expiresAt: true, caseId: true, repo: true, issue: true, severity: true, state: true, lane: true, disclosureAt: true, openedAt: true, title: true })
    .from(Report)
    .where(eq("repo", str(repo)))
    .orderBy(desc("openedAt"))
    .limit(Math.min(limit, PAGE))
    .fetch();

  return entities.map(shapeReport);
}

/* Clocks that are still running but already past due: the ghost candidates.
   Expressed with two positive predicates because the network has no negation. */
export async function ghostCandidates(reader, { now = Date.now(), limit = 50 } = {}) {
  const { entities } = await reader
    .select({ $key: true, $expiresAt: true, caseId: true, repo: true, maintainer: true, state: true, dueAt: true, startedAt: true })
    .from(Clock)
    .where(and(eq("state", str("running")), lt("dueAt", u64(BigInt(now)))))
    .orderBy(asc("dueAt"))
    .limit(Math.min(limit, PAGE))
    .fetch();

  return entities.map((e) => ({
    key: e.$key,
    caseId: e.caseId.value,
    repo: e.repo.value,
    maintainer: e.maintainer.value,
    dueAt: Number(e.dueAt.value),
    overdueMs: now - Number(e.dueAt.value),
    expiresAtBlock: e.$expiresAt?.toString(),
  }));
}

/* A reporter's tier, read from Arkiv. The authoritative tier lives on the ENS
   name; this is the audit trail of how it was earned. */
export async function tiersFor(reader, address, { limit = 20 } = {}) {
  const { entities } = await reader
    .select({ $key: true, $expiresAt: true, subject: true, ensName: true, tier: true, earnedAt: true, earnedOn: true, caseId: true })
    .from(Tier)
    .where(eq("subject", addr(address)))
    .orderBy(desc("earnedAt"))
    .limit(Math.min(limit, PAGE))
    .fetch();

  return entities.map((e) => ({
    key: e.$key,
    subject: e.subject.value,
    ensName: e.ensName.value,
    tier: Number(e.tier.value),
    earnedAt: Number(e.earnedAt.value),
    earnedOn: e.earnedOn.value,
    caseId: e.caseId.value,
    expiresAtBlock: e.$expiresAt?.toString(),
  }));
}

export async function verdictFor(reader, caseId) {
  const { entities } = await reader
    .select({ $key: true, caseId: true, call: true, model: true, requestId: true, provider: true, trustMode: true, verified: true, at: true, summary: true })
    .from(Verdict)
    .where(eq("caseId", str(caseId)))
    .orderBy(desc("at"))
    .limit(1)
    .fetch();

  const e = entities[0];
  if (!e) return null;
  return {
    key: e.$key,
    caseId: e.caseId.value,
    call: e.call.value,
    model: e.model.value,
    requestId: e.requestId.value,
    provider: e.provider.value,
    trustMode: e.trustMode.value,
    verified: e.verified.value,
    at: Number(e.at.value),
    summary: e.summary.value,
  };
}

/* How many open reports exist, without paging through them. */
export async function countOpen(reader) {
  return reader.count().from(Report).where(eq("state", str("open"))).fetch();
}

function shapeReport(e) {
  return {
    key: e.$key,
    caseId: e.caseId?.value,
    repo: e.repo?.value,
    issue: e.issue ? Number(e.issue.value) : undefined,
    severity: e.severity?.value,
    state: e.state?.value,
    lane: e.lane?.value,
    title: e.title?.value,
    openedAt: e.openedAt ? Number(e.openedAt.value) : undefined,
    disclosureAt: e.disclosureAt ? Number(e.disclosureAt.value) : undefined,
    expiresAtBlock: e.$expiresAt?.toString(),
    daysLeft: e.disclosureAt ? Math.max(0, Math.round((Number(e.disclosureAt.value) - Date.now()) / 86_400_000)) : undefined,
  };
}

/* ---------------------------------------------------------------------------
   The part no database can do: watch for someone extending a deadline.
   Arkiv emits onExpiryExtended. It emits NOTHING on natural expiry.
   So silence means the record died on schedule, and noise means a human
   deliberately kept a vulnerability secret for longer. That asymmetry is the
   whole reason this is on Arkiv.

   ⚠️ The event stream is GLOBAL. watchEntityEvents fires for every entity on the
   chain, from every wallet — there is no schema or owner filter on the
   subscription. Verified live on 2026-11-05: 61 onExpiryExtended events arrived
   within minutes, from 9 unrelated owners. You MUST filter client-side or you
   will present strangers' records as your own.
   ------------------------------------------------------------------------- */
export function watchExtensions(reader, onExtended, onError, { owners = [], keys = [] } = {}) {
  const ownerSet = new Set(owners.map((a) => String(a).toLowerCase()));
  const keySet = new Set(keys.map((k) => String(k).toLowerCase()));

  const mine = (entityKey, owner) => {
    if (keySet.size && keySet.has(String(entityKey).toLowerCase())) return true;
    if (ownerSet.size && ownerSet.has(String(owner).toLowerCase())) return true;
    return false;
  };

  return reader.watchEntityEvents({
    onExpiryExtended: ({ entityKey, owner, expiresAt, blockNumber, transactionHash }) => {
      if (!mine(entityKey, owner)) return;   // not ours; the stream is chain-wide
      onExtended({
        entityKey,
        owner,
        newExpiryBlock: expiresAt?.toString(),
        blockNumber: blockNumber?.toString(),
        txHash: transactionHash,
        at: Date.now(),
      });
    },
    onError: onError || (() => {}),
  });
}

/* Unfiltered, for the demo only: proves the extension signal is real and
   chain-wide. Never render this as WaspBounty data. */
export function watchAllExtensions(reader, onAny, onError) {
  return reader.watchEntityEvents({
    onExpiryExtended: (e) => onAny({
      entityKey: e.entityKey,
      owner: e.owner,
      newExpiryBlock: e.expiresAt?.toString(),
      at: Date.now(),
    }),
    onError: onError || (() => {}),
  });
}

/* ---------------------------------------------------------------------------
   THE GITHUB LANES — real projects, measured, with the arithmetic attached.

   This is the read that makes the board about something. Every row is a public
   GitHub project, the response bond its own issue tracker justifies, and a
   proof URL a stranger can curl.

   Ordered by bond multiple descending: the lanes where a report is most likely
   to be ignored come first, which is the opposite of how every bug bounty
   platform sorts and the only ordering a REPORTER actually wants.
   --------------------------------------------------------------------------- */
export async function repoLanes(reader, { limit = 50 } = {}) {
  const { entities } = await reader
    .select({
      $key: true, $expiresAt: true, $creator: true,
      slug: true, repoId: true, maintainer: true, verified: true,
      windowDays: true, promiseSupported: true,
      stars: true, openIssues: true, unanswered: true, oldestUnansweredDays: true,
      breaches: true, bondBasisPoints: true, securityMd: true, measuredAt: true,
      proofUrl: true,
    })
    .from(RepoBinding)
    /* newest measurement first, so the dedupe below keeps the current one */
    .orderBy(desc("measuredAt"))
    .limit(PAGE)
    .fetch();

  /* A project gets re-measured — that is the whole point of a 30-day lifetime,
     and nothing stops two measurements of one repo being live at once. The
     board must show the CURRENT reading per project, not the history, or a
     stale row sits next to a fresh one claiming equal authority. */
  const newestPerSlug = new Map();
  for (const row of entities.map(shapeBinding)) {
    const seen = newestPerSlug.get(row.slug);
    if (!seen || row.measuredAt > seen.measuredAt) newestPerSlug.set(row.slug, row);
  }

  /* Highest bond first: the lanes where a report is most likely to be ignored.
     That is the opposite of how bounty platforms sort, and the only ordering a
     REPORTER actually wants. */
  return [...newestPerSlug.values()]
    .sort((a, b) => b.bondMultiple - a.bondMultiple)
    .slice(0, limit);
}

/* One project's current measurement. */
export async function laneFor(reader, slug) {
  const { entities } = await reader
    .select({
      $key: true, $expiresAt: true,
      slug: true, repoId: true, maintainer: true, verified: true,
      windowDays: true, promiseSupported: true,
      stars: true, openIssues: true, unanswered: true, oldestUnansweredDays: true,
      breaches: true, bondBasisPoints: true, securityMd: true, measuredAt: true,
      proofUrl: true, evidence: true,
    })
    .from(RepoBinding)
    .where(eq("slug", str(String(slug).toLowerCase())))
    .orderBy(desc("measuredAt"))
    .limit(1)
    .fetch();

  if (!entities.length) return null;
  const row = shapeBinding(entities[0]);
  /* the full arithmetic, so the number on screen can be argued with */
  try {
    const raw = entities[0].evidence?.value;
    if (raw) row.evidence = JSON.parse(new TextDecoder().decode(hexToBytes(raw)));
  } catch { /* a binding without readable evidence still shows its numbers */ }
  return row;
}

const hexToBytes = (hex) => {
  const h = String(hex).replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

function shapeBinding(e) {
  const n = (v) => Number(v ?? 0);
  return {
    key: e.$key,
    slug: e.slug.value,
    repoId: e.repoId.value,
    maintainer: e.maintainer.value,
    /* false until someone proves push access to the default branch. Shown on
       screen as an open seat, never hidden. */
    verified: Boolean(e.verified.value),
    windowDays: n(e.windowDays.value),
    promiseSupported: Boolean(e.promiseSupported.value),
    stars: n(e.stars.value),
    openIssues: n(e.openIssues.value),
    unanswered: n(e.unanswered.value),
    oldestUnansweredDays: n(e.oldestUnansweredDays.value),
    breaches: n(e.breaches.value),
    bondMultiple: n(e.bondBasisPoints.value) / 10_000,
    securityMd: Boolean(e.securityMd.value),
    measuredAt: n(e.measuredAt.value),
    proofUrl: e.proofUrl?.value ?? null,
    /* the measurement dies on its own; a stale lane is visibly unmeasured */
    expiresAtBlock: e.$expiresAt?.toString() ?? null,
    githubUrl: "https://github.com/" + e.slug.value,
  };
}
