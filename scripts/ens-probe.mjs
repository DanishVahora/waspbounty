/* ============================================================================
   P1 — the ENSv2 go/no-go.
   ----------------------------------------------------------------------------
   The whole tier design rests on one unverified assumption: that we can grant a
   CUSTOM role in an unused nybble on an ENSv2 name, and read it back from a
   third-party contract.

   `initialize` accepting custom role bitmaps is confirmed from source. The later
   `grantRoles` on a custom nybble is NOT, and it is the part that matters.

   Two modes:
     (default)  read-only. Costs nothing. Confirms the deployed addresses are
                real, that the deployed initialize is the Grant[] form, and that
                hasRoles answers a static call with the signature we compiled in.
     --write    the real thing: deploy a UserRegistry, grant a tier, read it
                back, prove a stranger is refused. Needs Sepolia ETH.
   ========================================================================= */

import { createPublicClient, createWalletClient, http, toFunctionSelector, keccak256, toHex } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const WRITE = process.argv.includes("--write");

/* From the ENS docs deployments page (Sepolia / ENSv2, commit 07e55a05).
   NOT from the repo's deployments/ folder, which is months stale. */
export const SEPOLIA = {
  ETHRegistry:      "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4",
  RootRegistry:     "0xb458d6a3a77919449d03e7a6903c26827c1ec43f",
  UserRegistryImpl: "0x9bd8a88719068d09ecee662f36c0e3856708366a",
  VerifiableFactory:"0xda70306c98e97ece36f997a21368e53298572991",
  LabelStore:       "0xed8246ff02203a4d4cb262bd78beaa7408a57cae",
  ETHRegistrar:     "0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3",
};

const ROLE_TIER_1 = 1n << 40n;   // nybble 10
const ROLE_TIER_2 = 1n << 44n;   // nybble 11
const ROLE_TIER_3 = 1n << 48n;   // nybble 12
const ADMIN = (r) => r << 128n;  // confirmed: admin counterpart is role << 128

const EAC_ABI = [
  { type: "function", name: "hasRoles", stateMutability: "view",
    inputs: [{ name: "anyId", type: "uint256" }, { name: "roleBitmap", type: "uint256" }, { name: "account", type: "address" }],
    outputs: [{ type: "bool" }] },
  { type: "function", name: "grantRoles", stateMutability: "nonpayable",
    inputs: [{ name: "anyId", type: "uint256" }, { name: "roleBitmap", type: "uint256" }, { name: "account", type: "address" }],
    outputs: [{ type: "bool" }] },
  { type: "function", name: "roles", stateMutability: "view",
    inputs: [{ name: "anyId", type: "uint256" }, { name: "account", type: "address" }],
    outputs: [{ type: "uint256" }] },
];

const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });

const ok = (s) => console.log("  ✓ " + s);
const no = (s) => console.log("  ✗ " + s);

console.log("ENSv2 probe — Sepolia");
console.log("  rpc:", RPC);
console.log("");

/* ---------- 1. do the documented addresses actually hold code? ----------- */
console.log("1. deployed addresses");
const codes = {};
for (const [name, addr] of Object.entries(SEPOLIA)) {
  const code = await pub.getCode({ address: addr });
  codes[name] = code ?? "0x";
  const size = ((code?.length ?? 2) - 2) / 2;
  (size > 0 ? ok : no)(`${name.padEnd(18)} ${addr}  ${size} bytes`);
}

/* ---------- 2. which initialize is actually deployed? -------------------- */
console.log("\n2. UserRegistry.initialize — which signature is live?");
const grantForm = toFunctionSelector("initialize((address,uint256)[])");
const plainForm = toFunctionSelector("initialize(address,uint256)");
const impl = codes.UserRegistryImpl;
const hasGrant = impl.includes(grantForm.slice(2));
const hasPlain = impl.includes(plainForm.slice(2));
console.log(`  Grant[] form  ${grantForm}  ${hasGrant ? "PRESENT" : "absent"}`);
console.log(`  (addr,uint)   ${plainForm}  ${hasPlain ? "PRESENT" : "absent"}`);
if (hasGrant && !hasPlain) ok("deployed build is the Grant[] form — matches the docs, NOT main branch");
else if (hasPlain && !hasGrant) no("deployed build is the main-branch form — the brief's warning is inverted, re-check");
else console.log("  ? inconclusive from a bytecode scan; confirm against the ABI");

/* ---------- 3. does hasRoles answer with the signature we compiled? ------ */
console.log("\n3. hasRoles(uint256,uint256,address) against the live ETHRegistry");
try {
  const res = await pub.readContract({
    address: SEPOLIA.ETHRegistry, abi: EAC_ABI, functionName: "hasRoles",
    args: [BigInt(keccak256(toHex("vitalik"))), ROLE_TIER_1, "0x0000000000000000000000000000000000000001"],
  });
  ok(`call succeeded, returned ${res} — the uint256 signature is correct`);
  console.log("    (false is the expected answer; what matters is that it decoded at all)");
} catch (e) {
  no("call reverted: " + String(e.shortMessage || e.message).slice(0, 160));
  console.log("    If this is a decoding error, the signature is wrong — stop and fix before P2.");
}

/* ---------- 4. the bitmap rule that kills the 'tier level' story --------- */
console.log("\n4. role bitmap legality (this is a source fact, restated so it is not forgotten)");
const ALL_ROLES = BigInt("0x" + "1".repeat(64));
for (const [label, bits] of [["1 << 40 (tier 1)", ROLE_TIER_1], ["0xF << 40 (a 'level')", 0xfn << 40n]]) {
  const legal = (bits & ~ALL_ROLES) === 0n;
  (legal ? ok : no)(`${label.padEnd(22)} ${legal ? "legal" : "REJECTED by _checkRoleBitmap"}`);
}
console.log("    So a nybble is a boolean. Three tiers = three nybbles, not one counter.");

if (!WRITE) {
  console.log("\nRead-only probe complete. Nothing was spent.");
  console.log("Run with --write (and a funded Sepolia key) for the real grant test.");
  process.exit(0);
}

/* ---------- 5. the real test ------------------------------------------- */
console.log("\n5. live grant test");
const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk) { no("DEPLOYER_PRIVATE_KEY missing"); process.exit(1); }
const account = privateKeyToAccount(pk);
const bal = await pub.getBalance({ address: account.address });
console.log("  signer :", account.address);
console.log("  balance:", bal.toString(), "wei");
if (bal === 0n) {
  no("no Sepolia ETH — fund this address, then re-run with --write");
  process.exit(1);
}

const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const label = "waspbounty-probe-" + Date.now().toString(36);
const labelId = BigInt(keccak256(toHex(label)));
console.log("  label  :", label, "->", labelId.toString(16).slice(0, 16) + "…");

console.log("\n  NOTE: deploying a UserRegistry via VerifiableFactory with");
console.log("  initialize([{account: signer, roleBitmap: ADMIN(TIER_1|TIER_2|TIER_3)}])");
console.log("  then grantRoles(labelId, ROLE_TIER_2, signer) and reading it back.");
console.log("  Admin counterparts:", (ADMIN(ROLE_TIER_1 | ROLE_TIER_2 | ROLE_TIER_3)).toString(16));
console.log("\n  [the write path is wired in P1-1..P1-3 once the factory ABI is pinned]");
