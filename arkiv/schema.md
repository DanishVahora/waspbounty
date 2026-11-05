# Schema

Four entities on Rabdi (chain **7794095**), declared with `defineSchema` from
`@arkiv-network/sdk@1.0.1`. Source: [`src/arkiv/schema.mjs`](../src/arkiv/schema.mjs).

The shape of these is driven by three hard constraints, not by preference:

- **Only `.indexed()` columns can be filtered or sorted.** `bytes` can never be.
- **`str` is 128 *bytes*.** Anything longer goes in a `bytes` column. We truncate
  on the byte boundary (`fitStr`) so a multi-byte character is never cut in half.
- **The network supports no `!=` and no `NOT`.** Every queryable condition has to
  be positively expressible, which is why `state` is an explicit enum that we
  patch on transition rather than something derived from an absence.

A named schema costs one of the 32 attributes, leaving 31.

---

## `wasp.report`

The disclosure record. **Expires on day 90** — the Google Project Zero norm.

| column | type | indexed | why |
|---|---|:--:|---|
| `caseId` | `str` | ✓ | our id, e.g. `wb-7c41ae`; joins the other three entities |
| `repo` | `str` | ✓ | `curl/curl` — the board filters by project |
| `issue` | `u64` | ✓ | GitHub issue number |
| `reporter` | `addr` | ✓ | who posted the bond |
| `severity` | `str` | ✓ | `low` / `medium` / `high` / `critical` |
| `state` | `str` | ✓ | `open` / `valid` / `wrong` / `fabricated` / `ghosted` |
| `lane` | `str` | ✓ | `free` / `priority` |
| `openedAt` | `u64` | ✓ | ms — board ordering |
| `disclosureAt` | `u64` | ✓ | ms — day 90; mirrors `$expiresAt` in app time |
| `bondWei` | `u256` | | the escrowed amount |
| `digest` | `str` | | sha256 of the sealed payload, 64 hex chars |
| `title` | `str` | | one line, truncated to 128 bytes |
| `sealed` | `bytes` | | the report itself, **encrypted before storing** |

**Expiry:** `ExpirationTime.fromDays(90)`.
**Owner:** the submitting service wallet. **Nobody else can extend it**, and an
extension emits `onExpiryExtended` — which is the entire point (see below).

> Everything on Arkiv is public. The report body is encrypted before it is
> written and only `digest` is readable, so a vulnerability is never disclosed
> early by the act of recording it.

---

## `wasp.clock`

The maintainer's promise to answer. **Expires at the response deadline.**

| column | type | indexed | why |
|---|---|:--:|---|
| `caseId` | `str` | ✓ | joins to the report |
| `repo` | `str` | ✓ | |
| `maintainer` | `addr` | ✓ | who owes the answer |
| `state` | `str` | ✓ | `running` / `answered` / `ghosted` |
| `dueAt` | `u64` | ✓ | ms |
| `respondedAt` | `u64` | ✓ | ms, `0` while running |
| `startedAt` | `u64` | ✓ | |
| `bondWei` | `u256` | | the maintainer's half of the bail |

**Ghosting is proved by absence.** A clock that reaches its expiry without being
patched to `answered` was never answered. Because Arkiv emits **no event on
natural expiry**, silence is the signal — and `claimGhosted()` on the contract
pays the reporter.

The query is two positive predicates, because negation does not exist:

```js
and(eq("state", str("running")), lt("dueAt", u64(BigInt(now))))
```

---

## `wasp.verdict`

What the sealed enclave said, and the receipt that proves it said it.

| column | type | indexed | why |
|---|---|:--:|---|
| `caseId` | `str` | ✓ | joins to the report |
| `call` | `str` | ✓ | `valid` / `plausible` / `fabricated` |
| `model` | `str` | ✓ | e.g. `0gm-1.0-35b-a3b` |
| `requestId` | `str` | ✓ | the `ZG-Res-Key` from the 0G router |
| `provider` | `addr` | ✓ | the TEE provider that served it |
| `trustMode` | `str` | ✓ | `private` / `verified` / `standard` |
| `verified` | `bool` | ✓ | signature checked against the on-chain signer |
| `at` | `u64` | ✓ | ms |
| `summary` | `str` | | ≤ 128 bytes |
| `signature` | `bytes` | | the provider's signature over the response |
| `reasoning` | `bytes` | | the model's full reasoning |

**Lives alongside the report** so that when a bond is slashed, the basis for it
is on a public record with a checkable receipt — not an assertion from us.

---

## `wasp.tier`

A reputation level, earned at one project and spendable at the next.

| column | type | indexed | why |
|---|---|:--:|---|
| `subject` | `addr` | ✓ | the reporter |
| `ensName` | `str` | ✓ | `newcomer.waspbounty.eth` |
| `tier` | `i32` | ✓ | 0–3 |
| `earnedAt` | `u64` | ✓ | ms |
| `earnedOn` | `str` | ✓ | the repo where it was earned |
| `caseId` | `str` | ✓ | the report that earned it |
| `txHash` | `str` | | the settlement transaction |

**The authority is the ENS name, not this entity.** The on-chain role on an
ENSv2 name is what `bondFor()` reads; this entity is the audit trail of *how*
the tier was earned, which a name alone cannot carry.

**Expiry is deliberate.** A tier that never decays is seniority, not reputation.
When the entity expires the trail is gone and the standing has to be re-earned.

---

## Why the expiry is the product, not a storage discount

Arkiv markets expiry as paying only for the duration you need. For WaspBounty it is
the mechanism itself:

- A report **dies on day 90** on its own. Nobody deletes it; the network stops
  answering. That matches how coordinated disclosure already works.
- The **only** way it lives longer is a signed `extendEntity`, and Arkiv emits
  **`onExpiryExtended`** when that happens. So "the vendor asked for more time" —
  the single most argued-about fact in security disclosure — becomes a checkable
  public event instead of a private claim.
- Because **no event fires on natural expiry**, the default is silent and the
  exception is loud. That inverts who has to explain themselves.

In Postgres, a deadline sliding from day 90 to day 180 is one `UPDATE` that
nobody sees. That is the capability we could not buy anywhere else.

⚠️ We do **not** claim Arkiv erases bytes from history. The documented behaviour
is that queries stop returning the entity and operations on it fail. That is
what we say, and it is enough.

---

## Indexing and cost notes

- Every column we filter or sort on is `.indexed()`; nothing else is, because an
  index you do not query is cost without benefit.
- `sealed`, `signature` and `reasoning` are `bytes` and therefore unindexable by
  design — they are payload, never predicates.
- Page size is capped at **100** (`MAX_LIMIT`), and the board pages with
  `.limit().offset()` plus `orderBy`.
- Max lifetime is **7,884,000 blocks ≈ 182.5 days**, so a 90-day clock fits with
  room to spare, and a tier cannot outlive ~6 months without a deliberate renewal.
