/* ============================================================================
   Landing behaviour. The page is complete and readable with this file gone;
   everything here only fills in numbers that must come from a live network.
   ========================================================================= */

const $ = (s, r = document) => r.querySelector(s);
const fmt = new Intl.NumberFormat("en-US");

function paint(key, n, t, up) {
  const card = $(`.proof[data-k="${key}"]`);
  if (!card) return;
  card.dataset.state = up ? "up" : "down";
  $("[data-n]", card).textContent = n;
  $("[data-t]", card).textContent = t;
}
const down = (k, why) => paint(k, "—", why, false);

try {
  const [h, b] = await Promise.all([
    fetch("/api/health", { signal: AbortSignal.timeout(20000) }).then((r) => r.json()),
    fetch("/api/board", { signal: AbortSignal.timeout(30000) }).then((r) => r.json()).catch(() => null),
  ]);

  const c = h.contracts;
  c?.connected
    ? paint("chain", fmt.format(c.codeBytes) + " bytes",
        c.ensIsLiveRegistry ? "deployed, reading the real ENSv2 registry" : "deployed on Sepolia", true)
    : down("chain", c?.reason ?? "unreachable");

  const a = h.arkiv;
  a?.connected
    ? paint("arkiv", "#" + fmt.format(Number(a.block)), "current Rabdi block", true)
    : down("arkiv", a?.reason ?? "unreachable");

  const z = h.zerog;
  z?.connected
    ? paint("zerog", z.model, `${z.verifiability} · ${z.teeType ?? "TEE"}, verified by provider address`, true)
    : down("zerog", z?.keyPresent ? "no enclave free right now" : "no key configured");

  /* The clock bar and the line under the hero both come from the same number:
     how long the soonest open report has before it discloses itself. */
  const open = b?.rows?.length ?? 0;
  const soonest = open ? Math.min(...b.rows.map((r) => r.daysLeft ?? 90)) : null;

  if (open && soonest !== null) {
    const spent = Math.max(0, Math.min(100, ((90 - soonest) / 90) * 100));
    $("#clockbar").style.setProperty("--spent", spent.toFixed(1) + "%");
    $("#clockNote").textContent =
      `${open} report${open === 1 ? "" : "s"} on the clock. The soonest discloses itself in ${soonest} day${soonest === 1 ? "" : "s"} — day ${90 - soonest} of 90.`;
    $("#heroStat").textContent =
      `Live on Sepolia and Arkiv · ${open} report${open === 1 ? "" : "s"} on the clock`;
  } else if (a?.connected) {
    $("#clockNote").textContent = "Nothing on the clock right now.";
    $("#heroStat").textContent = "Live on Sepolia and Arkiv";
  } else {
    $("#clockNote").textContent = "Arkiv is unreachable, so the clock cannot be read.";
    $("#heroStat").textContent = "Backends unreachable";
  }
} catch {
  for (const k of ["chain", "arkiv", "zerog"]) down(k, "app server is not running");
  $("#clockNote").textContent = "The app server is not running.";
  $("#heroStat").textContent = "The app server is not running";
}
