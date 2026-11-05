# How we use Arkiv

Filters, ownership, expiry, and the effect a user can actually see.

Network: **Rabdi, chain 7794095**. SDK `@arkiv-network/sdk@1.0.1`, schema-first.
Source: [`src/arkiv/schema.mjs`](../src/arkiv/schema.mjs),
[`src/arkiv/board.mjs`](../src/arkiv/board.mjs),
[`src/arkiv/client.mjs`](../src/arkiv/client.mjs).

---

## 1. Four schemas

Declared with `defineSchema`, not ad-hoc objects, so column types are checked
before a query is ever sent.

| schema | holds | expires |
|---|---|---|
| `wasp.report` | the disclosure record | **day 90** — the Project Zero norm |
| `wasp.clock` | the maintainer's promise to answer | at the response deadline |
| `wasp.verdict` | the enclave's call + its receipt | alongside the report |
| `wasp.tier` | a reputation level earned at one project | deliberately, so standing decays |

Full column list in [`schema.md`](./schema.md).

---

## 2. Filters

**Every column we filter or sort on is `.indexed()`. Nothing else is** — an index
you never query is cost without benefit. `bytes` columns (`sealed`, `signature`,
`reasoning`) cannot be indexed at all, which is correct: they are payload, never
predicates.

Six real queries, all in [`board.mjs`](../src/arkiv/board.mjs):

**The disclosure board — what is open, soonest deadline first:**
```js
reader.select({ $key: true, $expiresAt: true, caseId: true, repo: true,
                issue: true, severity: true, state: true, disclosureAt: true, title: true })
  .from(Report)
  .where(eq("state", str("open")))
  .orderBy(asc("disclosureAt"))
  .limit(Math.min(limit, PAGE))
```

**Ghost detection — two positive predicates, because the network has no `NOT`:**
```js
.from(Clock)
.where(and(eq("state", str("running")), lt("dueAt", u64(BigInt(now)))))
.orderBy(asc("dueAt"))
```

**A reporter's standing, by address:**
```js
.from(Tier).where(eq("subject", addr(address))).orderBy(desc("earnedAt"))
```

**The verdict attached to a case:**
```js
.from(Verdict).where(eq("caseId", str(caseId))).orderBy(desc("at")).limit(1)
```

Plus `byRepo()` for per-project filtering and `countOpen()`, which uses
`reader.count()` rather than fetching rows to count them.

### Three constraints that shaped the schema, not just the queries

- **No `!=`, no `NOT`.** Every condition has to be positively expressible. That
  is why `state` is an explicit enum we patch on transition rather than something
  derived from an absence. Ghosting is found with `state = "running" AND dueAt <
  now`, never "not answered".
- **Typed literals are mandatory.** `str('x')`, `u64(...)`, `addr(...)`. A bare
  number is `i32`, so a bare `4` will silently fail to match a `dec` column. We
  wrap every predicate value.
- **`str` is 128 bytes, not characters.** We truncate on the byte boundary
  (`fitStr`) so a multi-byte character is never cut in half.

A malformed query raises `QueryError` — **it is not an empty result.** We let it
throw rather than rendering "no reports found" over a broken filter.

---

## 3. Ownership

**The writer is a single service wallet** —
`0x4CA8176777D44B76235684b63334088C618994e4` — and it owns every entity it
creates. This matters in three places:

**Only the owner can extend.** Not an admin, not whoever holds the database
password. Our own service wallet cannot quietly extend a *maintainer's* clock,
and no third party can extend a report to delay its disclosure. The network
enforces this with a signature requirement, not an application rule.

**The event watcher filters by owner.** `watchEntityEvents` is a **chain-wide
firehose** — nothing in the docs says so. Verified live on 2026-11-05: 61
`onExpiryExtended` events arrived in about four minutes from nine unrelated
owners. Our board would have displayed strangers' extensions as if they were
ours. So the subscription is scoped:

```js
watchExtensions(reader, onExtended, onError, { owners: [account.address] })
```

Written up as entry 7 in [`friction.md`](./friction.md).

**Creation flags are immutable.** Reports are written with explicit flags rather
than defaults, and read back after the write to confirm the entity that landed is
the entity we meant to write.

---

## 4. Expiry — the part that is the product

```js
ExpirationTime.fromDays(90)
```

A report is bought with 90 days of life. On day 90 it stops being answerable.
**Nobody deletes it. No cron job runs. No honest actor is required.**

Two properties of Arkiv do the real work:

**Extension emits an event.** The only way a report outlives its deadline is a
signed `extendEntity` by the owner, and that fires **`onExpiryExtended`**.

**Natural expiry emits nothing.** Confirmed in the SDK behaviour and relied on
deliberately.

So **silence is the normal case, and the one loud thing is somebody buying more
time.** "The vendor asked for an extension" stops being a claim in a blog post
and becomes a row a reporter can query. Full argument in
[`why-arkiv.md`](./why-arkiv.md).

Two limits we respect: `MAX_LIFETIME` is 7,884,000 blocks (~182.5 days), so a
90-day clock fits with room, and a tier cannot outlive ~6 months without a
deliberate renewal — which is the point, since a tier that never decays is
seniority, not reputation.

---

## 5. The visible effect

**The user-facing feature that reads from Arkiv is the Disclosure Board**, served
at `/api/board` and rendered as the third tab of the app
([`app/server.mjs`](../app/server.mjs), [`app/public/app.js`](../app/public/app.js)).

A visitor who has never heard of Arkiv sees:

- **every open report, ordered by how close it is to disclosure** — from
  `expiringSoon()`, which is a live Arkiv query, not a cached table
- **a countdown per case** derived from `$expiresAt`, the entity's own lifetime
- **a "ghosted" column** listing cases whose response clock ran out —
  `ghostCandidates()`, the two-positive-predicate query above
- **an "extended" marker** on any case where somebody bought more time, pushed
  live by `onExpiryExtended`

The maintainer's triage queue (`/api/queue`) is the same read, scoped to one
project.

**Remove Arkiv and this screen is empty.** It is not a mirror of a Postgres table
we also keep — there is no second copy. The board *is* the query.

---

## 6. Write safety

Writes go through [`client.mjs`](../src/arkiv/client.mjs), ported from Arkiv's
own guidance:

- **An unsigned estimate first.** `estimateWrite` replaces the signer with a
  refusal so a preflight can never accidentally broadcast.
- **Explicit `txParams`.** Latest nonce, current gas price, and
  `gas = max(1_000_000 + 400_000 × (ops − 1), 2 × estimate)` — the measured Rabdi
  floor, kept even though 1.0.1 adds 25% headroom automatically.
- **Read-back after write.** Receipt status, creator, `$expiresAt` and the
  payload digest are all confirmed before we call a write successful.
- **Errors are scrubbed.** `ark_live_*` keys and keyed RPC URLs are redacted
  before anything reaches a log or a response body — the access key is embedded
  in the RPC URL by `rabdi({ accessKey })`, so an unsanitised transport error
  leaks it.
- **No automatic retry.** An uncertain submission is reconciled, never resent.

---

## Honest status

**Reads are live and run against Rabdi today** — they need no gas, which is why
the entire query layer was testable before the wallet had a single tGLM.
`scripts/arkiv-read.mjs` exercises all six queries against the real network.

**Writes are implemented and pending funding** at the time of writing: the faucet
pays only the wallet that connects, so the service signer needed tGLM forwarded
to it. The write path is complete, guarded, and exercised by
`scripts/arkiv-write.mjs`; what it was waiting on was gas, not code. See
[`friction.md`](./friction.md) entry 2.
