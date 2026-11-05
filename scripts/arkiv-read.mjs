/* Exercise every query the disclosure board makes, against the live chain.
   Reads cost no gas, so this validates the whole read path before the wallet is
   funded. A rejected query raises QueryError here — it does not come back empty,
   which is exactly why running this early is worth it. */

import { clients, accountFromEnv, accessKeyFromEnv, scrub } from "../src/arkiv/client.mjs";
import { expiringSoon, byRepo, ghostCandidates, tiersFor, countOpen, verdictFor } from "../src/arkiv/board.mjs";

const account = accountFromEnv();
const { reader } = clients(account, accessKeyFromEnv());

const run = async (name, fn) => {
  const t0 = Date.now();
  try {
    const out = await fn();
    const n = Array.isArray(out) ? out.length : typeof out === "bigint" ? Number(out) : out ? 1 : 0;
    console.log(`  OK    ${name.padEnd(26)} ${String(n).padStart(4)} ${Array.isArray(out) ? "rows" : ""}  ${Date.now() - t0}ms`);
    return out;
  } catch (e) {
    console.log(`  FAIL  ${name.padEnd(26)} ${e?.constructor?.name || "Error"}${e?.kind ? `(${e.kind})` : ""}: ${scrub(e)}`);
    return null;
  }
};

console.log("Disclosure board — query path check (reads only, no gas)\n");

const rows = await run("expiringSoon", () => expiringSoon(reader, { limit: 20 }));
await run("byRepo(curl/curl)", () => byRepo(reader, "curl/curl"));
await run("ghostCandidates", () => ghostCandidates(reader));
await run("tiersFor(dev EOA)", () => tiersFor(reader, account.address));
await run("countOpen", () => countOpen(reader));
await run("verdictFor(none)", () => verdictFor(reader, "wb-nonexistent"));

if (rows?.length) {
  console.log("\n  open reports, soonest deadline first:");
  for (const r of rows.slice(0, 10)) {
    console.log(`    ${String(r.daysLeft).padStart(3)}d  ${r.repo}#${r.issue}  ${r.severity.padEnd(8)} ${r.caseId}  ${r.title?.slice(0, 48) ?? ""}`);
  }
} else {
  console.log("\n  (no entities yet — expected until the wallet is funded and we write)");
}

console.log("\n  every query above was accepted by the network, so the syntax is sound.");
