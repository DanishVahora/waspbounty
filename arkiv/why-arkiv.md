# Why Arkiv

What a user loses if this is a Postgres table.

---

## The one-sentence version

A disclosure deadline is a **promise between two parties who do not trust each
other**. Postgres can only make that deadline a fact about *our server*. Arkiv
makes it a fact about a network neither side runs.

---

## The situation the data has to survive

A reporter sends an unpatched vulnerability to a maintainer. Three things are now
contested, and every one of them has been argued about publicly in real
disclosure disputes:

1. **When was it reported?**
2. **What was the agreed deadline?**
3. **Did the deadline move, and who moved it?**

That third one is the whole fight. "The vendor asked for more time" versus "the
vendor sat on it for six months" is the single most common disclosure argument,
and today it is **one party's word against another's**, usually settled by
whoever has the bigger blog.

---

## What Postgres gives you here

A `disclosure_at` column. And the ability, at any moment, to run:

```sql
UPDATE reports SET disclosure_at = disclosure_at + interval '90 days'
WHERE id = 'wb-7c41ae';
```

One statement. No trace that anyone would find. The row simply says something
different than it said yesterday.

You can defend against this — an append-only audit table, a trigger, a WORM
volume, a nightly hash published somewhere. But notice what you are building:
**you are reconstructing a tamper-evident log**, badly, and the reporter still
has to trust that *we* did not disable the trigger. Every one of those defences
is enforced by the same operator the reporter is being asked to trust.

That is the actual failure. Not performance, not cost. **The adversary in this
system is partly us**, and Postgres cannot be a referee in a match where it is
owned by one of the players.

---

## What Arkiv changes

### 1. Expiry is the mechanism, not a storage discount

Arkiv markets Entity Expiration as paying only for the duration you need. For us
it *is* the product:

A report is written with `ExpirationTime.fromDays(90)` — the Project Zero norm.
On day 90 it stops being answerable. **Nobody deletes it. Nobody runs a job.
Nobody decides.** The network stops returning it because the lifetime it was
bought with ran out. The default outcome requires no honest actor.

### 2. Extension is loud, death is silent

This is the part we could not buy anywhere else.

- The **only** way a report outlives day 90 is a signed `extendEntity` from the
  owner, and Arkiv emits **`onExpiryExtended`** when that happens.
- Arkiv emits **no event at all on natural expiry.**

So silence means the clock ran out normally, and the *one* thing that produces a
public event is somebody buying more time. "The vendor asked for an extension"
stops being a claim and becomes a row anyone can query.

**That inverts who has to explain themselves.** In Postgres the extension is
invisible and the reporter must prove it happened. Here the extension is the only
visible thing, and the maintainer's own signature is on it.

### 3. Ownership is cryptographic, not configuration

Only the entity owner can extend. Not an admin, not whoever has the database
password, not us. In Postgres, "who may change this row" is an application rule;
in Arkiv it is a signature requirement the network enforces. Our service wallet
cannot quietly extend a maintainer's clock even if we wanted to.

### 4. Ghosting is provable from absence

A response clock that reaches expiry without being patched to `answered` was
never answered. Because no event fires on natural expiry, we do not need one —
the absence *is* the finding, and `claimGhosted()` pays the reporter. The query
is two positive predicates, since the network has no negation:

```js
and(eq("state", str("running")), lt("dueAt", u64(BigInt(now))))
```

---

## What a user concretely loses with Postgres

| | Postgres | Arkiv |
|---|---|---|
| Deadline moved | one silent `UPDATE` | signed `extendEntity`, emits `onExpiryExtended` |
| Who can move it | anyone with DB access, incl. us | only the key-holding owner |
| Report ages out | a cron job we wrote, that we can skip | the lifetime simply ends |
| Reporter's recourse | trust our audit table | run the query themselves |
| Tier a reporter earned | a row in our users table; gone if we vanish | an entity + an ENS role they hold |
| If we shut down | all of it disappears | the record outlives the company |

That last row is not decoration. A reputation that only exists while we do is not
portable reputation — it is a loyalty card.

---

## Where Postgres is genuinely better, and what we would still use it for

Being honest about this is the point, not a hedge:

- **Cost and latency.** Every Arkiv write costs tGLM and waits for a block.
  Postgres is free and instant.
- **Query power.** Arkiv has no `!=` and no `NOT`, no joins, no full-text search,
  a 100-row page cap and a 128-**byte** `str`. Postgres has all of it.
- **Privacy by default.** Everything readable on Arkiv is public. We encrypt the
  report body before writing and store only a digest in the clear — in Postgres
  that would be the default, not an obligation.
- **Operational maturity.** Backups, migrations, replicas, twenty years of tooling.

So the honest architecture is not "Arkiv instead of Postgres." It is:

> **Arkiv for the handful of facts that must survive our own bad behaviour.
> Postgres for everything else.**

Draft state, UI preferences, rate limits, session data, search indexes — none of
that belongs on a public chain, and we would not put it there. What goes on Arkiv
is the four things a reporter might one day need to prove **against us**: that
they reported, when the clock was set, whether it moved, and what standing they
earned.

---

## One claim we do not make

We do **not** claim Arkiv erases bytes from history. The documented behaviour is
that queries stop returning an expired entity and operations on it fail. That is
what we say in the UI and it is enough for this design — the point was never
shredding, it was that **the deadline cannot be moved quietly**.
