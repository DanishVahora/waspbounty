# ENSv2

## Why the reputation has to live on a name

Wasp Bounty refunds your bond when your report is real, and grants you a **tier**
that waives the bond next time. The whole point of that tier is that it travels.

> A researcher who has proved themselves to `curl` should not have to start from
> zero at `openssl`.

The moment `curl` stores that record in `curl`'s database, it is worthless at
`openssl` — and worse, it is `curl`'s to revoke. A reputation that one project
can delete is not a reputation, it is a loyalty card.

So the tier is not a row in our database. **It is a role on an ENSv2 name the
reporter owns**, and our contract only *reads* it. We cannot take it away. The
next project does not need our permission, our API, or our continued existence
to honour it — they read the same registry we do.

**Remove ENS and the tier stops travelling.** Wasp Bounty still works as a bond
escrow, but it becomes one more silo, and the argument that made it worth
building collapses.

---

## How the contract uses it

`bondFor()` is the only place a bond amount is ever decided, and it reads ENS
before it answers:

```solidity
uint256 public constant ROLE_TIER_1 = 1 << 40; // nybble 10
uint256 public constant ROLE_TIER_2 = 1 << 44; // nybble 11
uint256 public constant ROLE_TIER_3 = 1 << 48; // nybble 12

function bondFor(address reporter, uint256 labelId) public view returns (uint256) {
    if (!hasSubmittedBefore[reporter]) return 0;                           // first one free
    if (ensRegistry.hasRoles(labelId, ROLE_TIER_3, reporter)) return 0;    // trusted: walks in
    if (ensRegistry.hasRoles(labelId, ROLE_TIER_2, reporter)) return baseBond / 4;
    if (ensRegistry.hasRoles(labelId, ROLE_TIER_1, reporter)) return baseBond / 2;
    return baseBond;
}
```

Four external calls to ENS in the hot path of the one function that decides
money. The ladder is deliberately shallow:

| tier | bond | what it means |
|---|---|---|
| none, first report | **free** | the door is open by default |
| none, reported before | `baseBond` | no record yet |
| 1 | `baseBond / 2` | one report held up |
| 2 | `baseBond / 4` | a pattern |
| 3 | **free** | trusted — walks in like a maintainer |

Tier 3 and a first-time reporter both pay nothing, and the app says *why* in
each case rather than printing `0` twice, because "we have never met you" and
"you have earned this" are opposite facts that happen to cost the same.

This is a **live read against the real ENSv2 ETHRegistry on Sepolia**
(`0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4`) — not a mock, not a fixture. The
deploy script points the constructor at that address and the app shows
`ensIsLiveRegistry` as a computed boolean, not a label.

Check it without spending anything:

```bash
cast call 0xe7d75b9c9a5b65ce4c3ba654da7013139f451f7e \
  "bondFor(address,uint256)(uint256)" \
  0x0000000000000000000000000000000000000001 0 \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

Or in the app: type any address into **Your address** on the Report tab. The
number comes from `bondFor()` on Sepolia every time — nothing about the bond is
hard-coded in the front end, which is why the field changes as you type.

```bash
curl 'http://localhost:4318/api/chain/bond?reporter=0x…'
curl  http://localhost:4318/api/chain/tiers     # the role constants, read from the contract
```

---

## The thing we got wrong, and the probe that caught it

The original design read a **0–15 level** out of one unused EAC nybble. Four bits,
sixteen tiers, elegant. It does not work, and it fails loudly rather than
silently — which is lucky.

`EnhancedAccessControl` validates every bitmap against
`ALL_ROLES = 0x1111…1111`. A nybble may hold the value `1`, never `0xF`:

```
✓ 1 << 40   (tier 1)        legal
✗ 0xF << 40 (a "level")     REJECTED by _checkRoleBitmap → EACInvalidRoleBitmap
```

**So a nybble is a boolean, not a counter.** Three tiers are three separate
nybbles, not one four-bit integer. [`test/waspbounty.test.mjs`](../test/waspbounty.test.mjs)
asserts the rejection explicitly, because the opposite assumption is an easy one
to ship and it would have failed on-chain at demo time.

Two more facts from [`scripts/ens-probe.mjs`](../scripts/ens-probe.mjs), both
verified live against Sepolia rather than recalled from docs:

- **`hasRoles` takes a `uint256`, not a `bytes32`.** The probe calls
  `hasRoles(uint256,uint256,address)` and confirms it decodes. With `bytes32` it
  reverts, and the revert looks like a permissions failure rather than a
  signature mismatch — a genuinely expensive hour if you trust the type.
- **`UserRegistry.initialize` on Sepolia is the `Grant[]` form** (`0x37cb53a8`),
  matching the docs — *not* the `(address,uint256)` form on the main branch
  (`0xcd6dc687`, absent from the deployed build). Build against what is deployed.

Run it yourself — it is read-only and spends nothing:

```bash
npm run ens:probe
```

---

## What is deliberately not here

**We do not write roles during the demo.** Granting a tier is a transaction the
name's controller signs; the app never holds a user's key and never signs on
their behalf. Every ENS interaction in the running product is a read.

**We do not claim tiers are portable in practice today.** They are portable *by
construction* — the role sits on the reporter's name and any contract can read
it — but Wasp Bounty is the only reader so far. The honest claim is about where
the data lives and who can revoke it, which is the part that cannot be retrofitted
later.
