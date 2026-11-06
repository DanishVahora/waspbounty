/* ============================================================================
   The wallet.
   ----------------------------------------------------------------------------
   EIP-1193 against whatever the browser has injected — MetaMask, Rabby, Frame.
   No library, no bundler: the server encodes the calldata with viem and hands
   back { to, data }, and this file does the one thing a wallet layer should
   do, which is ask the user to sign it.

   Three rules this file keeps:

   · It never holds a key and never sees one. Every signature happens in the
     wallet's own UI, where the user can read what they are approving.
   · It never silently switches networks. It asks, and if the user declines it
     says so rather than failing somewhere later with a confusing revert.
   · It never claims a transaction succeeded until a receipt says status 1.
     "Submitted" and "confirmed" are different words here because they are
     different facts.
   ========================================================================= */

const eth = () => window.ethereum ?? null;
export const hasWallet = () => Boolean(eth());

export class WalletError extends Error {}

let account = null;
let chainInfo = null;
const listeners = new Set();

export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn(state()));
export const state = () => ({ account, chainInfo, connected: Boolean(account) });

/* MetaMask's own error codes. 4001 is the user saying no, which is a normal
   outcome and must never be reported as a failure. */
const USER_REJECTED = 4001;
const CHAIN_NOT_ADDED = 4902;

export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

async function info() {
  if (!chainInfo) chainInfo = await fetch("/api/tx/chain").then((r) => r.json());
  return chainInfo;
}

/* ---------- connect --------------------------------------------------------- */

export async function connect() {
  const p = eth();
  if (!p) {
    throw new WalletError(
      "No wallet found in this browser. Install MetaMask, or open the app in a browser that has it.",
    );
  }
  let accounts;
  try {
    accounts = await p.request({ method: "eth_requestAccounts" });
  } catch (e) {
    if (e?.code === USER_REJECTED) throw new WalletError("You declined the connection.");
    throw new WalletError(e?.message ?? "Could not reach the wallet.");
  }
  account = accounts?.[0] ?? null;
  if (!account) throw new WalletError("The wallet returned no account.");

  await ensureChain();
  emit();
  return account;
}

/* Reconnect silently if this browser already granted access — so a reload
   does not make the user click Connect again. Never prompts. */
export async function resume() {
  const p = eth();
  if (!p) return null;
  try {
    const accounts = await p.request({ method: "eth_accounts" });
    account = accounts?.[0] ?? null;
    if (account) emit();
    return account;
  } catch { return null; }
}

export async function ensureChain() {
  const p = eth();
  const c = await info();
  const current = await p.request({ method: "eth_chainId" });
  if (current === c.chainIdHex) return true;

  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: c.chainIdHex }] });
    return true;
  } catch (e) {
    if (e?.code === CHAIN_NOT_ADDED) {
      await p.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: c.chainIdHex,
          chainName: "Sepolia",
          nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
          blockExplorerUrls: ["https://sepolia.etherscan.io"],
        }],
      });
      return true;
    }
    if (e?.code === USER_REJECTED) throw new WalletError("Wasp Bounty runs on Sepolia. The network was not switched.");
    throw new WalletError(e?.message ?? "Could not switch network.");
  }
}

/* ---------- build, sign, confirm ---------------------------------------------- */

/* Ask the server for calldata. `what` names a builder; `args` are its inputs. */
export async function build(what, args) {
  const r = await fetch(`/api/tx/${what}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new WalletError(j.error ?? `Could not build ${what}`);
  return j;
}

export async function preflight(need = "0") {
  if (!account) return null;
  const r = await fetch(`/api/tx/preflight?who=${account}&need=${encodeURIComponent(need)}`);
  return r.ok ? r.json() : null;
}

/* Sends and then WAITS. Resolves only on a receipt with status 1, so nothing
   downstream can treat an unmined or reverted transaction as done. */
export async function send(req, { onHash } = {}) {
  if (!account) await connect();
  await ensureChain();
  const p = eth();

  let hash;
  try {
    hash = await p.request({
      method: "eth_sendTransaction",
      params: [{ from: account, to: req.to, data: req.data, ...(req.value ? { value: req.value } : {}) }],
    });
  } catch (e) {
    if (e?.code === USER_REJECTED) throw new WalletError("You declined the transaction.");
    /* The wallet's simulation usually explains a revert better than we could */
    const m = e?.data?.message || e?.message || "The wallet refused the transaction.";
    throw new WalletError(m.split("\n")[0].slice(0, 200));
  }

  onHash?.(hash);
  const receipt = await waitFor(hash);
  if (!receipt || receipt.status !== "0x1") {
    throw new WalletError("The transaction was mined but reverted. Nothing changed on chain.");
  }
  return { hash, receipt };
}

/* Poll for the receipt. Sepolia blocks are ~12s, so a 2s poll is responsive
   without hammering, and three minutes is long enough that a slow block does
   not look like a failure. */
async function waitFor(hash, { timeoutMs = 180000, everyMs = 2000 } = {}) {
  const p = eth();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await p.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null);
    if (r) return r;
    await new Promise((s) => setTimeout(s, everyMs));
  }
  throw new WalletError(
    "Still waiting on a receipt after three minutes. The transaction may yet confirm — check the explorer.",
  );
}

export const txUrl = (hash) => `https://sepolia.etherscan.io/tx/${hash}`;

/* ---------- keep up with the wallet ---------------------------------------------
   An account or network change invalidates everything on screen, so the app
   is told rather than left showing a balance that belongs to someone else. */
if (eth()) {
  eth().on?.("accountsChanged", (a) => { account = a?.[0] ?? null; emit(); });
  eth().on?.("chainChanged", () => { emit(); });
}
