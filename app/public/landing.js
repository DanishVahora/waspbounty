/* ============================================================================
   Landing behaviour. Two jobs, and the page is complete without either.
   ========================================================================= */

const $ = (s, r = document) => r.querySelector(s);

/* ---------- 1. nav hairline ---------------------------------------------- */
const nav = $("#nav");
const onScroll = () => { nav.dataset.stuck = String(scrollY > 8); };
addEventListener("scroll", onScroll, { passive: true });
onScroll();

/* ---------- 2. live numbers -----------------------------------------------
   The clock column's lit portion is set from a real number: the share of the
   ninety-day window the soonest report has already spent. If the backend is
   down the stripes simply stay unlit, which is honest — an unlit clock means
   we do not know what time it is, not that nothing is due. */
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
    ? paint("chain", fmt.format(c.codeBytes) + " bytes", c.ensIsLiveRegistry ? "live, reading real ENSv2" : "live on Sepolia", true)
    : down("chain", c?.reason ?? "unreachable");

  const a = h.arkiv;
  a?.connected
    ? paint("arkiv", "#" + fmt.format(Number(a.block)), a.funded ? "current Rabdi block" : "wallet empty", true)
    : down("arkiv", a?.reason ?? "unreachable");

  const z = h.zerog;
  z?.connected
    ? paint("zerog", z.model, `${z.verifiability} · ${z.teeType ?? "TEE"}`, true)
    : down("zerog", z?.keyPresent ? "no enclave free" : "no key");

  /* the one line under the hero, and the stripes it drives */
  const open = b?.rows?.length ?? 0;
  const soonest = b?.rows?.length
    ? Math.min(...b.rows.map((r) => r.daysLeft ?? 90))
    : null;

  /* The docket. Five rows at most — a hero is not a table, and the sixth row
     would push the fold. Each row's clock lights the days already spent. */
  const rows = $("#docketRows");
  if (b?.rows?.length) {
    const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    rows.innerHTML = b.rows
      .slice()
      .sort((x, y) => (x.daysLeft ?? 90) - (y.daysLeft ?? 90))
      .slice(0, 5)
      .map((r) => {
        const d = r.daysLeft ?? 90;
        const left = Math.max(1.5, Math.min(100, (d / 90) * 100)).toFixed(1);
        return `<div class="drow${d <= 14 ? " drow--soon" : ""}">
          <div class="drow__top">
            <span class="drow__r">${esc(r.repo)}#${esc(r.issue)}</span>
            <span class="drow__d">${d}d</span>
          </div>
          <p class="drow__t">${esc(r.title)}</p>
          <div class="drow__clock clock" style="--left:${left}%" aria-hidden="true"></div>
        </div>`;
      })
      .join("");
  } else {
    rows.innerHTML = `<p class="sub docket__wait">${
      h.arkiv?.connected ? "Nothing on the clock right now" : "Arkiv unreachable"
    }</p>`;
  }

  /* The hero field stays unlit on purpose: it is the ninety-day grid itself,
     the unit every row is measured against. The lit measurement belongs to
     the rows, where it means one specific report. */
  if (open && soonest !== null) {
    $("#heroStat").textContent =
      `${open} report${open === 1 ? "" : "s"} on the clock · the next one discloses in ${soonest} day${soonest === 1 ? "" : "s"}`;
  } else if (h.arkiv?.connected) {
    $("#heroStat").textContent = "Nothing on the clock right now";
  } else {
    $("#heroStat").textContent = "Backends unreachable — start the app server";
  }
} catch {
  for (const k of ["chain", "arkiv", "zerog"]) down(k, "app server not running");
  $("#heroStat").textContent = "Backends unreachable — start the app server";
}
