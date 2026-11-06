/* ============================================================================
   Transaction building.
   ----------------------------------------------------------------------------
   The server encodes calldata; the browser signs it. Nothing else.

   WHY THIS SPLIT. Encoding ABI by hand in the browser is a good way to lose a
   hackathon at 3am, and bundling viem for the browser means adding a build
   step to a project that deliberately has none. viem already lives on the
   server, so the server does the encoding and hands back { to, data }. The
   wallet does the only thing a wallet should do: sign.

   The server never sees a private key, never sends a transaction, and cannot
   sign on anyone's behalf. Every function here is pure — it takes arguments
   and returns bytes. If this process were compromised the worst it could do
   is propose a transaction the user still has to read and approve.
   ========================================================================= */

import { encodeFunctionData, parseEther, formatEther } from "viem";
import { abi, address, tokenAddress, deployment, pub } from "./contract.mjs";

export class TxError extends Error {}

/* The mock bond currency. Its mint() is deliberately permissionless, which is
   what lets a judge or a demo attendee get tokens without asking us for any. */
const TOKEN_ABI = [
  { type: "function", name: "mint", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "who", type: "address" }], outputs: [{ type: "uint256" }] },
];

const VERDICTS = { valid: 1, goodFaith: 2, slop: 3 };

const req = (v, what) => {
  if (v === undefined || v === null || v === "") throw new TxError(`${what} is required`);
  return v;
};
const asAddress = (v, what) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(v))) throw new TxError(`${what} must be a 0x address`);
  return v;
};
const asBytes32 = (v, what) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(v))) throw new TxError(`${what} must be a 0x bytes32`);
  return v;
};

/* ---------- reads the UI needs before it can propose a write -------------- */

export async function tokenState(who) {
  asAddress(who, "address");
  const [balance, allowance] = await Promise.all([
    pub.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: "balanceOf", args: [who] }),
    pub.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: "allowance", args: [who, address] }),
  ]);
  return {
    token: tokenAddress,
    balance: formatEther(balance),
    balanceWei: balance.toString(),
    allowance: formatEther(allowance),
    allowanceWei: allowance.toString(),
  };
}

/* ---------- the writes ----------------------------------------------------- */

/* Anyone may mint the mock currency. Said plainly in the UI, because a token
   anyone can print is not a token anyone should value — and pretending
   otherwise on a testnet is the kind of small lie that costs trust. */
export function buildMint({ to, amount = "100" }) {
  asAddress(to, "to");
  return {
    to: tokenAddress,
    data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "mint", args: [to, parseEther(String(amount))] }),
    label: `Mint ${amount} WASP`,
    note: "The demo currency. Anyone can mint it; it is worth nothing.",
  };
}

export function buildApprove({ amount = "1000" }) {
  return {
    to: tokenAddress,
    data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [address, parseEther(String(amount))] }),
    label: `Allow Wasp Bounty to hold ${amount} WASP`,
    note: "Approval only. Nothing moves until you post a bond or open a lane.",
  };
}

/* The maintainer's side: open a lane and stake the pool that will pay a
   reporter if the project goes quiet. */
export function buildRegisterRepo({ slug, pool = "100", windowDays = 7 }) {
  req(slug, "slug");
  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(String(slug))) {
    throw new TxError("slug must look like owner/repo, lowercase");
  }
  const seconds = Math.round(Number(windowDays) * 86400);
  if (!Number.isFinite(seconds) || seconds < 3600) throw new TxError("the response window must be at least an hour");
  return {
    to: address,
    data: encodeFunctionData({ abi, functionName: "registerRepo", args: [slug, parseEther(String(pool)), BigInt(seconds)] }),
    label: `Open the lane for ${slug}`,
    note: `Stakes ${pool} WASP against a ${windowDays}-day promise to answer.`,
  };
}

export function buildTopUp({ repoId, amount }) {
  asBytes32(repoId, "repoId");
  return {
    to: address,
    data: encodeFunctionData({ abi, functionName: "topUp", args: [repoId, parseEther(String(amount))] }),
    label: `Add ${amount} WASP to the pool`,
  };
}

/* The reporter's side. arkivKey is the entity holding the sealed body, so the
   chain carries a pointer to the report without carrying the report. */
export function buildSubmit({ repoId, arkivKey, labelId = 0 }) {
  asBytes32(repoId, "repoId");
  asBytes32(arkivKey, "arkivKey");
  return {
    to: address,
    data: encodeFunctionData({ abi, functionName: "submit", args: [repoId, BigInt(labelId), arkivKey] }),
    label: "File the report",
  };
}

export function buildResolve({ reportId, verdict }) {
  asBytes32(reportId, "reportId");
  const v = VERDICTS[verdict];
  if (!v) throw new TxError(`verdict must be one of ${Object.keys(VERDICTS).join(", ")}`);
  return {
    to: address,
    data: encodeFunctionData({ abi, functionName: "resolve", args: [reportId, v] }),
    label: { valid: "Settle as valid", goodFaith: "Settle as good faith", slop: "Settle as fabricated" }[verdict],
  };
}

/* Callable by ANYONE once the window has passed — which is the point, so the
   reporter never has to ask the party that owes them. */
export function buildClaimGhosted({ reportId }) {
  asBytes32(reportId, "reportId");
  return {
    to: address,
    data: encodeFunctionData({ abi, functionName: "claimGhosted", args: [reportId] }),
    label: "Claim the response bond",
    note: "Anyone can send this once the window has passed. The reporter is paid, not the sender.",
  };
}

/* ---------- what the UI should ask for next --------------------------------
   One place that decides whether a user needs tokens, an approval, or neither
   — so the three screens cannot disagree about it. */
export async function preflight({ who, need = "0" }) {
  asAddress(who, "who");
  const t = await tokenState(who);
  const needWei = parseEther(String(need));
  const haveWei = BigInt(t.balanceWei);
  const allowWei = BigInt(t.allowanceWei);
  return {
    ...t,
    need,
    needsTokens: haveWei < needWei,
    needsApproval: needWei > 0n && allowWei < needWei,
    ready: haveWei >= needWei && (needWei === 0n || allowWei >= needWei),
  };
}

export const chainInfo = () => ({
  chainIdHex: "0xaa36a7",             /* Sepolia, 11155111 */
  chainId: 11155111,
  name: "Sepolia",
  contract: address,
  token: tokenAddress,
  explorer: deployment?.explorer ?? "https://sepolia.etherscan.io/address/",
  txExplorer: "https://sepolia.etherscan.io/tx/",
});
