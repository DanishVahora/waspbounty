/* ============================================================================
   Landing page behaviour. Three small jobs, no framework.

   The rule that shapes all of it: the page is complete and readable with this
   file deleted. Nothing here reveals content — it only decorates content that
   is already on screen. That is why the rise-in class is ADDED by script
   rather than sitting in the HTML: if the script never runs, nothing is
   hidden, because nothing was ever marked hidden.
   ========================================================================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- 1. the nav hairline ------------------------------------------
   The rule under the nav only exists once there is content behind it. At the
   top of the page the nav is just paper, with nothing to separate from. */
const nav = $("#nav");
const onScroll = () => nav.dataset.stuck = String(window.scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

/* ---------- 2. live proof --------------------------------------------------
   Reads the same /api/health the app uses. Every card reports the truth,
   including "down" — a landing page that claims a backend is live when it is
   not is worse than one that says nothing, because the first thing a judge
   does is check. */
const fmt = new Intl.NumberFormat("en-US");

function paint(key, { ok, n, t, href, pill, pillClass }) {
  const card = $(`.proof[data-k="${key}"]`);
  if (!card) return;
  card.dataset.state = ok ? "up" : "down";
  $("[data-n]", card).textContent = n;
  $("[data-t]", card).textContent = t;

  const p = $("[data-pill]", card);
  p.textContent = pill;
  p.className = `stamp ${pillClass}`;

  const a = $("[data-a]", card);
  if (href) {
    a.hidden = false;
    a.textContent = "view on Etherscan →";
    a.href = href;
  } else if (a.tagName === "A") {
    a.hidden = true;
  }
}

function down(key, why) {
  paint(key, { ok: false, n: "—", t: why, pill: "unreachable", pillClass: "stamp stamp--block" });
}

try {
  const r = await fetch("/api/health", { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const h = await r.json();

  /* --- the contract --- */
  const c = h.contracts;
  if (c?.connected) {
    paint("chain", {
      ok: true,
      n: fmt.format(Number(c.codeBytes)) + " bytes",
      t: c.ensIsLiveRegistry
        ? "deployed, and reading the real ENSv2 registry"
        : "deployed on Sepolia",
      href: c.explorer,
      pill: "live",
      pillClass: "stamp stamp--done",
    });
  } else {
    down("chain", c?.reason ?? "not reachable");
  }

  /* --- arkiv --- */
  const a = h.arkiv;
  if (a?.connected) {
    paint("arkiv", {
      ok: true,
      n: "#" + fmt.format(Number(a.block)),
      t: a.funded
        ? "current Rabdi block — reports expire against this clock"
        : "connected, but the writing wallet is empty",
      pill: a.funded ? "live" : "unfunded",
      pillClass: a.funded ? "stamp stamp--done" : "stamp stamp--run",
    });
  } else {
    down("arkiv", a?.reason ?? "not reachable");
  }

  /* --- the enclave --- */
  const z = h.zerog;
  if (z?.connected) {
    paint("zerog", {
      ok: true,
      n: z.model,
      t: `${z.verifiability} · ${z.teeType ?? "TEE"} · verified by provider address`,
      pill: "sealed",
      pillClass: "stamp stamp--done",
    });
  } else {
    down("zerog", z?.keyPresent ? (z.reason ?? "no enclave free") : "no key configured");
  }
} catch (e) {
  for (const k of ["chain", "arkiv", "zerog"]) down(k, "the app server is not running");
}
