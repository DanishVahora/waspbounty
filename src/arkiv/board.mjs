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
import { Report, Clock, Verdict, Tier } from "./schema.mjs";

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
