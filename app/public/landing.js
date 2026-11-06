/* ============================================================================
   Landing behaviour.
   ----------------------------------------------------------------------------
   Two rules, both learned the hard way on this page:

   1. The page is complete and readable with this file deleted. Everything
      here either fills in a number that must come from a live network, or
      adds motion. Nothing here reveals content that was not already there.

   2. Declarations first, one boot() call at the very bottom. An earlier
      version ran its fetch at the top of the file and reached a `const`
      declared further down while it was still in its temporal dead zone —
      which threw before the try/catch and took the whole render with it.
   ========================================================================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = new Intl.NumberFormat("en-US");
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- counters --------------------------------------------------------
   Counts to the value actually read, starting from a fraction of it rather
   than from zero. A figure sweeping up from 0 displays numbers it never
   fetched, and on a page whose whole claim is "this is live" that is the
   wrong kind of flourish. */
function countUp(el, target, { suffix = "", ms = 850 } = {}) {
  if (calm || !Number.isFinite(target)) {
    el.textContent = fmt.format(target) + suffix;
    return;
  }
  const from = Math.round(target * 0.84);
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt.format(Math.round(from + (target - from) * eased)) + suffix;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------- proof cards ------------------------------------------------------ */
function paint(key, { n, num, suffix, t, up }) {
  const card = $(`.proof[data-k="${key}"]`);
  if (!card) return;
  card.dataset.state = up ? "up" : "down";
  const nEl = $("[data-n]", card);
  if (Number.isFinite(num)) countUp(nEl, num, { suffix: suffix ?? "" });
  else nEl.textContent = n;
  $("[data-t]", card).textContent = t;
}
const down = (k, why) => paint(k, { n: "—", t: why, up: false });

/* ---------- the live ribbon ---------------------------------------------------
   Real reports from Arkiv. The list is rendered twice so the marquee can
   translate by exactly -50% and loop seamlessly; with one copy it visibly
   snaps back at the end of each pass. */
function paintRibbon(rows) {
  const track = $("#ribbonTrack");
  if (!track) return;
  if (!rows?.length) {
    track.innerHTML = `<span class="ribbon__item">Nothing is on the clock right now</span>`;
    track.style.animation = "none";
    return;
  }
  const item = (r) => {
    const d = r.daysLeft ?? 90;
    return `<span class="ribbon__item">`
      + `<span class="ribbon__d${d <= 14 ? " ribbon__d--soon" : ""}">${d}d</span>`
      + `<b>${esc(r.repo)}</b><span>${esc(r.title)}</span></span>`;
  };
  const once = rows.slice().sort((a, b) => (a.daysLeft ?? 90) - (b.daysLeft ?? 90)).map(item).join("");
  track.innerHTML = once + once;
}

/* ---------- reveal on approach -------------------------------------------------
   The hidden class is added BY SCRIPT, so a page whose JavaScript never runs
   is a page without the animation rather than a page without content. The
   failsafe is the load-bearing part: whatever the observer does, everything
   is visible within two seconds. */
function reveal() {
  if (calm || !("IntersectionObserver" in window)) return;
  const targets = $$(".section .wrap > *, .band .wrap > *, .verdict, .scale, .proof, .shot, .stage");
  setTimeout(() => targets.forEach((el) => el.classList.add("in")), 2000);

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -6% 0px", threshold: 0.01 });

  targets.forEach((el, i) => {
    el.classList.add("js-reveal");
    el.style.transitionDelay = `${Math.min(i % 4, 3) * 60}ms`;
    io.observe(el);
    /* already on screen at load: show it immediately and without a delay — it
       was never off screen, so animating it in is the fade-up tell */
    if (el.getBoundingClientRect().top < innerHeight * 0.94) {
      el.style.transitionDelay = "0ms";
      el.classList.add("in");
      io.unobserve(el);
    }
  });
}

/* ---------- live data ------------------------------------------------------------ */
async function boot() {
  reveal();

  let h, b;
  try {
    [h, b] = await Promise.all([
      fetch("/api/health", { signal: AbortSignal.timeout(20000) }).then((r) => r.json()),
      fetch("/api/board", { signal: AbortSignal.timeout(30000) }).then((r) => r.json()).catch(() => null),
    ]);
  } catch {
    for (const k of ["chain", "arkiv", "zerog"]) down(k, "app server is not running");
    $("#clockNote").textContent = "The app server is not running.";
    $("#heroStat").textContent = "The app server is not running";
    paintRibbon(null);
    return;
  }

  const c = h.contracts;
  c?.connected
    ? paint("chain", { num: c.codeBytes, suffix: " bytes", up: true,
        t: c.ensIsLiveRegistry ? "deployed, reading the real ENSv2 registry" : "deployed on Sepolia" })
    : down("chain", c?.reason ?? "unreachable");

  const a = h.arkiv;
  a?.connected
    ? paint("arkiv", { n: "#" + fmt.format(Number(a.block)), t: "current Rabdi block", up: true })
    : down("arkiv", a?.reason ?? "unreachable");

  const z = h.zerog;
  z?.connected
    ? paint("zerog", { n: z.model, up: true,
        t: `${z.verifiability} · ${z.teeType ?? "TEE"}, verified by provider address` })
    : down("zerog", z?.keyPresent ? "no enclave free right now" : "no key configured");

  paintRibbon(b?.rows);

  /* The clock bar and the hero line come from one number: how long the
     soonest open report has before it discloses itself. */
  const open = b?.rows?.length ?? 0;
  const soonest = open ? Math.min(...b.rows.map((r) => r.daysLeft ?? 90)) : null;

  if (open && soonest !== null) {
    const spent = Math.max(0, Math.min(100, ((90 - soonest) / 90) * 100));
    /* set on the next frame, so the width transition actually runs instead of
       the bar simply existing at its final value */
    requestAnimationFrame(() =>
      $("#clockbar").style.setProperty("--spent", spent.toFixed(1) + "%"));
    $("#clockNote").textContent =
      `${open} report${open === 1 ? "" : "s"} on the clock. The soonest discloses itself in `
      + `${soonest} day${soonest === 1 ? "" : "s"} — day ${90 - soonest} of 90.`;
    $("#heroStat").textContent =
      `Live on Sepolia and Arkiv · ${open} report${open === 1 ? "" : "s"} on the clock`;
  } else if (a?.connected) {
    $("#clockNote").textContent = "Nothing on the clock right now.";
    $("#heroStat").textContent = "Live on Sepolia and Arkiv";
  } else {
    $("#clockNote").textContent = "Arkiv is unreachable, so the clock cannot be read.";
    $("#heroStat").textContent = "Backends unreachable";
  }
}

/* ---------- nav hairline ----------------------------------------------------------- */
const nav = $(".nav");
if (nav) {
  const onScroll = () => { nav.dataset.stuck = String(scrollY > 8); };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

boot();
