# Friction

What actually broke while building WaspBounty on Arkiv, in the order it happened,
with the reproduction. Written as it occurred, not reconstructed afterwards.

Environment: Windows 11, Node v25.5.0, `@arkiv-network/sdk` 1.0.1, `viem` 2.57.16,
Rabdi chain 7794095.

---

## 1. Every example on the internet targets an SDK that no longer exists

**Cost: this would have been hours if we had not checked first.**

The SDK reached 1.0.0 on 2026-10-30 and 1.0.1 on 2026-11-02. Every blog post,
every tutorial and every cached model answer targets the 0.x "Golem Base" API.
The differences are not cosmetic:

| 0.x (what you will find) | 1.0.x (what is installed) |
|---|---|
| untyped annotations | `defineSchema()` with typed columns |
| `updateEntity` | `patchEntity(schema, key, { set, unset })` |
| `bytes32` type | removed — use `key` |
| `payload` / `jsonToPayload` / `MimeType` | removed — use `bytes` and `str` columns |
| cursors, `QueryResult.next()` | removed — `.limit().offset()` or keyset on `$key` |
| `ExpirationTime.permanent()` | removed |

The repo README's own sample `package.json` still pins `"@arkiv-network/sdk":
"^0.9.0"`, which adds to the confusion.

**What helped:** the official skills at `Arkiv-Network/skills` are the only
current reference, and they say so. Installing those before writing a line was
the single highest-value thing we did.

**Suggestion:** put a prominent "1.0 is a breaking change, here is the migration
table" banner at the top of docs.arkiv.network. Right now a developer who starts
from a search engine lands on 0.x material with nothing telling them it is stale.
The docs API-reference sidebar also still lists removed symbols (`MAX_PAYLOAD_BYTES`,
`jsonToPayload`, `stringToPayload`, `MimeType`, `bytes32`, `not`/`ne`,
`resolveExpiry`, `chainFromName`) and does **not** list `rabdi`.

---

## 2. The faucet can only pay the wallet you connect, so a server-side signer is awkward

**Reproduce:** open `hub.arkiv.network/faucet`. The only action is "Connect
wallet"; there is no address field.

Good practice — and what the official `arkiv-first-write` skill tells you to do —
is to use a **dedicated development EOA** generated server-side, and to never put
a personal private key in a project. But that EOA is not in MetaMask, so the
faucet cannot fund it directly. You end up either importing a throwaway key into
a browser wallet, or claiming to a personal wallet and forwarding.

**Suggestion:** allow an optional address field on the faucet, rate-limited per
connected account. It would make the documented best practice (a dedicated,
server-held signer) a one-step flow instead of a three-step one.

---

## 3. A type mismatch in a predicate is caught client-side, with a genuinely good error

**Reproduce:**

```js
// subject is declared addr().indexed()
.where(eq("subject", account.address))     // a bare JS string
```

```
InvalidPredicateError: "subject" is a addr column, but the predicate asserts a
str, so it could never match. Write addr(...) around the value.
```

**Fix:** `eq("subject", addr(account.address))`.

This is the opposite of friction and worth saying out loud: the error names the
column, the declared type, the asserted type, *why* it can never match, and the
exact fix. We hit it on the first run of our read path and it cost under a minute.
Most database clients would have returned an empty result set and let us debug a
phantom.

(Minor: the message reads "is a addr column" — should be "is an addr column".)

---

## 4. Reads need no gas, which makes the whole query layer testable before funding

Not a problem — a design property worth recording, because it changed how we
worked. We validated all six board queries (compound `and()`, `lt()` on a `u64`,
ordering, `count()`, and a schema-scoped `getEntity`) against the live network
while the wallet still had a zero balance. Every query shape was confirmed sound
before a single token was spent.

This matters more than it sounds, because **a rejected query raises `QueryError`
rather than returning an empty result**. Being able to separate "my syntax is
wrong" from "there is no data yet" without spending anything is a real advantage
over testing against a seeded database.

---

## 5. No negation in the query language shapes the schema, not just the query

The network supports no `!=` and no `NOT`. This is documented, but the
consequence only becomes clear when modelling: you cannot ask for "clocks that
have not been answered".

We had to make every queryable condition **positively expressible**. So `state`
is an explicit enum string (`running` / `answered` / `ghosted`) that gets patched
on transition, rather than something derived from the absence of a value. Our
ghost query becomes two positive predicates:

```js
and(eq("state", str("running")), lt("dueAt", u64(BigInt(now))))
```

**Suggestion:** mention this in the data-modelling guide, framed as a modelling
rule rather than a query limitation — "design states as enums you patch, not as
absences you negate". It is the sort of thing that is obvious in hindsight and
expensive to discover after you have written your schema.

---

## 6. `str` is 128 **bytes**, not 128 characters

Easy to miss, and it bites with any non-ASCII content. A Devanagari or emoji
title will blow the limit far sooner than its character count suggests. We wrote
a `fitStr()` helper that truncates on the byte boundary so a multi-byte character
can never be cut in half.

---

## 7. `watchEntityEvents` is a chain-wide firehose, and nothing says so

**This produced a real bug in our UI, and it is the most useful entry in this file.**

We subscribed to expiry extensions, expecting events for the entities we wrote:

```js
reader.watchEntityEvents({ onExpiryExtended: (e) => board.push(e) })
```

Within minutes our public disclosure board was showing **50 deadline extensions
from 9 wallets that are not ours**. The subscription has no schema filter, no
owner filter and no key filter — it is every entity on the chain. Our board was
presenting strangers' records as WaspBounty disclosures.

**Reproduce:** subscribe on Rabdi with no filter and count. We logged **61
`onExpiryExtended` events in roughly four minutes** of wall time.

**Fix:** filter client-side against a known owner or key set.

```js
watchExtensions(reader, onExt, onErr, { owners: [account.address] })
// 50 events -> 0 events
```

**Why this matters beyond our bug.** The docs present the watch callbacks as the
way to react to your data, and `.ownedBy()` / `.createdBy()` exist on the *query*
builder — so the natural expectation is that the event stream is scoped the same
way. It is not, and the asymmetry is silent: plausible-looking events arrive
immediately, so nothing signals that you are reading the whole chain.

**Suggestions, in order of value:**
1. Accept a filter on the subscription: `watchEntityEvents({ ownedBy, schema, keys }, {...})`.
   Server-side filtering would also cut a lot of pointless polling traffic.
2. Failing that, put one bold line at the top of the watch-events page:
   *"These callbacks fire for every entity on the chain. Filter by owner or key."*
3. Events carry `entityKey` and `owner` but no schema tag, so filtering by schema
   costs a lookup per event. Including the `arkiv.schema` tag in the event
   payload would make client-side filtering cheap.

**Credit where it is due:** that extensions are observable chain-wide *at all* is
precisely why we chose Arkiv. We only needed to be told the stream was global.

---

*Running log — appended to as the build continues.*
