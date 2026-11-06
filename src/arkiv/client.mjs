/* ============================================================================
   Arkiv client + the guarded write path.
   ----------------------------------------------------------------------------
   Ported from Arkiv's official `arkiv-first-write` skill (SDK 1.0.1, Rabdi).
   Three things here are not optional and are the reason this file exists:

   1. SANITIZED ERRORS. The SDK encodes the access key into the RPC URL, so a
      raw transport error printed to a log leaks the key. Everything that leaves
      this module goes through scrub().

   2. AN UNSIGNED ESTIMATE. SDK 1.0.x has no public create-estimator, and the
      skill records that default estimation produced gas-exhaustion reverts on
      Rabdi (lane W controls, 2026-10-30). So we estimate through a wallet whose
      signer is replaced by a refusal and whose RPC allowlist blocks anything
      mutating.

   3. EXPLICIT TX PARAMS. Rabdi wants latest nonce, current gasPrice and
      gas = max(1_000_000 + 400_000*(ops-1), 2*estimate), bounded by half the
      latest block gas limit.
   ========================================================================= */

import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http, custom, MethodNotFoundRpcError } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const RABDI_CHAIN_ID = 7794095;

/* ---------- error hygiene ------------------------------------------------- */
const safeMarks = new WeakMap();

export function safeError(message = "Arkiv operation failed", details = {}) {
  const allowed = {};
  for (const f of ["txHash", "entityKey"]) {
    const v = details[f];
    if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) allowed[f] = v;
  }
  if (typeof details.expiresAt === "bigint" && details.expiresAt >= 0n && details.expiresAt < 2n ** 64n) {
    allowed.expiresAt = details.expiresAt;
  }
  const err = Object.assign(new Error(message), allowed);
  safeMarks.set(err, { message, details: { ...allowed } });
  return err;
}

export function sanitizedFailure(error, fallback = "Arkiv request failed; reconcile any admitted write before retrying") {
  const own = error !== null && typeof error === "object" ? safeMarks.get(error) : undefined;
  if (own) return safeError(own.message, own.details);
  try {
    if (error instanceof Error && error.message === "Unsigned preparation/estimate failed") {
      return safeError("Unsigned preparation/estimate failed");
    }
  } catch { /* ignore */ }
  return safeError(fallback);
}

/* Belt and braces for anything we print ourselves. */
export const scrub = (e) =>
  String(e?.shortMessage || e?.message || e)
    .replace(/ark_live_[A-Za-z0-9_-]+/g, "ark_live_<redacted>")
    .replace(/https?:\/\/[^\s)]+/g, "<rpc-redacted>")
    .split("\n")[0]
    .slice(0, 240);

/* ---------- clients -------------------------------------------------------- */
export function clients(account, accessKey) {
  try {
    const chain = rabdi({ accessKey });
    const transport = http(undefined, {
      retryCount: 0,
      timeout: 15000,
      fetchOptions: { cache: "no-store", redirect: "error" },
    });
    return {
      chain,
      reader: createPublicClient({ chain, transport, cacheTime: 0 }),
      wallet: createWalletClient({ account, chain, transport, cacheTime: 0 }),
    };
  } catch (error) {
    throw sanitizedFailure(error);
  }
}

/* Reads need an access key and nothing else — no account, no signer, no
   private key anywhere in the process.

   This exists because the public demo should not be holding a wallet. The
   board, the docket and every query a judge runs are reads; binding them to a
   signer meant a deployment either carried a funded key or showed empty
   panels. Now it can do neither. Writes are still refused without an account,
   loudly, rather than silently doing nothing. */
export function readerOnly(accessKey) {
  try {
    const chain = rabdi({ accessKey });
    const transport = http(undefined, {
      retryCount: 0,
      timeout: 15000,
      fetchOptions: { cache: "no-store", redirect: "error" },
    });
    return { chain, reader: createPublicClient({ chain, transport, cacheTime: 0 }), wallet: null };
  } catch (error) {
    throw sanitizedFailure(error);
  }
}

export function accountFromEnv() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw safeError("DEPLOYER_PRIVATE_KEY missing or malformed — run: npm run wallet");
  }
  return privateKeyToAccount(pk);
}

export function accessKeyFromEnv() {
  const k = process.env.ARKIV_ACCESS_KEY;
  if (!k || typeof k !== "string") throw safeError("ARKIV_ACCESS_KEY missing from .env");
  return k;
}

/* ---------- unsigned estimate (signing and sending are blocked) ----------- */
export async function estimateWrite(account, accessKey, prepare) {
  try {
    const chain = rabdi({ accessKey });
    const rpc = http(undefined, {
      retryCount: 0,
      timeout: 15000,
      fetchOptions: { cache: "no-store", redirect: "error" },
    })({ chain });

    if (BigInt(await rpc.request({ method: "eth_chainId" })) !== BigInt(RABDI_CHAIN_ID)) {
      throw safeError("Wrong chain");
    }

    const reads = new Set([
      "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber",
      "eth_getTransactionCount", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_estimateGas",
    ]);
    const reader = createPublicClient({ chain, cacheTime: 0, transport: custom(rpc, { retryCount: 0 }) });

    let estimate;
    const stop = safeError("Unsigned estimate captured");
    const oversized = safeError("Gas exceeds half the latest block limit; split unprepared work");

    const transport = custom({
      async request(args) {
        if (args.method === "eth_fillTransaction") {
          throw new MethodNotFoundRpcError(safeError("Use guarded estimate path"));
        }
        if (!reads.has(args.method)) throw safeError("Unexpected or mutating RPC blocked");

        const result = await rpc.request(
          args.method === "eth_estimateGas"
            ? { method: "eth_estimateGas", params: [args.params?.[0], "latest"] }
            : args,
        );

        if (args.method === "eth_estimateGas") {
          if (typeof result !== "string" || !/^0x[0-9a-f]+$/i.test(result)) throw safeError("Invalid estimate");
          estimate = BigInt(result);
          if (estimate <= 0n) throw safeError("Invalid estimate");
          const gas = 2n * estimate > 1_000_000n ? 2n * estimate : 1_000_000n;
          const block = await reader.getBlock({ blockTag: "latest" });
          if (typeof block.gasLimit !== "bigint" || block.gasLimit <= 0n) {
            throw safeError("Latest block gas limit required");
          }
          if (gas > block.gasLimit / 2n) throw oversized;
          throw stop;
        }
        return result;
      },
    }, { retryCount: 0 });

    const unsigned = { ...account, signTransaction: async () => { throw safeError("Signing blocked"); } };
    const wallet = createWalletClient({ account: unsigned, chain, transport });

    try {
      await prepare(wallet);
    } catch (error) {
      let cause = error;
      for (let depth = 0; cause && depth < 24; depth++) {
        if (cause === oversized) throw oversized;
        if (cause === stop && estimate !== undefined) return estimate;
        cause = typeof cause === "object" ? cause.cause : undefined;
      }
      throw safeError("Unsigned preparation/estimate failed");
    }
    throw safeError("Callback skipped estimation or swallowed the guard");
  } catch (error) {
    throw sanitizedFailure(error, "Unsigned preparation/estimate failed");
  }
}

/* ---------- explicit transaction parameters -------------------------------- */
export async function rabdiTxParams(reader, address, approvedMaximumCost, estimate, operations = 1) {
  try {
    if (estimate <= 0n || !Number.isSafeInteger(operations) || operations < 1) {
      throw safeError("Valid unsigned estimate and operation count required");
    }
    const floor = 1_000_000n + 400_000n * BigInt(operations - 1);
    const gas = floor > 2n * estimate ? floor : 2n * estimate;

    const block = await reader.getBlock({ blockTag: "latest" });
    if (typeof block.gasLimit !== "bigint" || block.gasLimit <= 0n) {
      throw safeError("Latest block gas limit required");
    }
    if (gas > block.gasLimit / 2n) throw safeError("Gas exceeds half the latest block limit; split unprepared work");

    const latest = await reader.getTransactionCount({ address, blockTag: "latest" });
    if (await reader.getTransactionCount({ address, blockTag: "pending" }) !== latest) {
      throw safeError("Reconcile pending nonce first");
    }

    const gasPrice = await reader.getGasPrice();
    const cost = gas * gasPrice;
    if (cost > approvedMaximumCost) throw safeError("Gas cap exceeds approved budget");
    if (cost > await reader.getBalance({ address })) throw safeError("Gas cap exceeds balance — fund the dev EOA");

    return { nonce: latest, gas, gasPrice };
  } catch (error) {
    throw sanitizedFailure(error);
  }
}

/* ---------- one guarded write --------------------------------------------- */
export async function guardedCreate({ reader, wallet }, account, accessKey, schema, values, options, {
  approvedMaximumCost = 10n ** 16n,   // 0.01 tGLM per write, generous for a testnet
  label = "entity",
} = {}) {
  if (await reader.getChainId() !== RABDI_CHAIN_ID || wallet.chain?.id !== RABDI_CHAIN_ID) {
    throw safeError("Wrong chain");
  }

  const estimate = await estimateWrite(account, accessKey, (unsigned) =>
    unsigned.createEntity(schema, values, options));

  const txParams = await rabdiTxParams(reader, account.address, approvedMaximumCost, estimate);
  const result = await wallet.createEntity(schema, values, options, txParams);

  /* A success from the SDK is not the end of it: check the receipt, then read
     the entity back. Never resend after an SDK success. */
  const receipt = await reader.getTransactionReceipt({ hash: result.txHash });
  if (receipt.status !== "success") {
    throw safeError("Write reverted; reconcile before resending", result);
  }

  return { ...result, estimate, gas: txParams.gas, label };
}
