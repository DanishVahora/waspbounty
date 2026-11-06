/* WaspBounty — app client. No framework. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let LIVE = null;
let QUEUE = [];
let current = null;

/* ---------- the welcome -----------------------------------------------------
   Removed from the DOM once it has played, so it can never intercept a click
   or sit in the tab order. Suppressed for the rest of the session, because a
   splash you meet on every tab switch stops being a welcome and becomes a
   toll gate. */
(() => {
  const w = document.getElementById("welcome");
  if (!w) return;
  let seen = false;
  try { seen = sessionStorage.getItem("wb:welcomed") === "1"; } catch { /* private mode */ }
  if (seen || matchMedia("(prefers-reduced-motion: reduce)").matches) { w.remove(); return; }
  try { sessionStorage.setItem("wb:welcomed", "1"); } catch { /* ignore */ }
  setTimeout(() => w.remove(), 1700);
})();

/* ---------- chrome ---------------------------------------------------------
   The four screens are addressable: /app#desk opens the desk. The landing page
   links straight into each one, so without this every door on the front page
   would quietly dump the visitor on the report form — which is exactly the
   kind of broken path that makes an app feel untrustworthy. */
const VIEWS = ["report", "desk", "lanes", "board"];

function show(view, { push = true } = {}) {
  if (!VIEWS.includes(view)) view = "report";
  document.body.dataset.view = view;
  $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === view)));
  $$(".view").forEach((v) => { v.hidden = v.id !== "view-" + view; });
  if (view === "desk") loadQueue();
  if (view === "board") loadBoard();
  if (view === "lanes") loadLanes();

  /* replaceState, not pushState: switching tabs should not stack up history
     entries that make Back feel broken. Back leaves the app, as it should. */
  if (push && location.hash.slice(1) !== view) {
    history.replaceState(null, "", `#${view}`);
  }
  window.scrollTo({ top: 0, behavior: "instant" });
}

$$(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));
addEventListener("hashchange", () => show(location.hash.slice(1), { push: false }));
show(location.hash.slice(1) || "report", { push: false });

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("toast--up");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("toast--up"), 3600);
}

/* ---------- report --------------------------------------------------------- */
$$(".lane").forEach((l) => l.addEventListener("click", () => {
  $$(".lane").forEach((x) => x.setAttribute("aria-pressed", "false"));
  l.setAttribute("aria-pressed", "true");
}));

/* The real handler is fileReport(), wired at the bottom of this file. */


/* ---------- waiting ---------------------------------------------------------
   Reads against Arkiv and Sepolia take seconds, not milliseconds — the board
   runs six queries against a testnet. For that whole time these panels used to
   render as empty boxes, which does not read as "loading", it reads as broken.
   Status is one of the four kinds of feedback a UI owes you, so say it.

   Deliberately plain text rather than shimmering skeleton blocks: a skeleton
   implies a known shape arriving imminently, and when a testnet is slow that
   is a promise we cannot keep. A sentence naming the network you are waiting
   on is honest and tells you where to look when it never arrives.

   Both are function DECLARATIONS, not const arrows. show() runs during module
   evaluation to pick the view from the URL hash, so it reaches these before
   this point in the file — a const would still be in its temporal dead zone
   and throw, taking the whole first render down with it. */
function waitingFor(what) {
  return `<div class="waiting"><span class="waiting__d" aria-hidden="true"></span>${esc(what)}</div>`;
}

function waiting(sel, what) {
  const el = $(sel);
  if (el) el.innerHTML = waitingFor(what);
}

/* ---------- desk ----------------------------------------------------------- */
async function loadQueue() {
  waiting("#queue", "Reading the queue…");
  const q = $("#queue");
  q.innerHTML = `<div style="padding:28px;text-align:center"><span class="spin"></span></div>`;
  try {
    const r = await fetch("/api/queue");
    const data = await r.json();
    LIVE = data.live;
    QUEUE = data.items || [];
    paintStatus();
    paintQueue();
    if (QUEUE[0]) select(QUEUE[0].caseId);
  } catch {
    q.innerHTML = `<div class="empty"><div class="empty__t">Can't reach the server</div>
      <div class="empty__d">The app server is not responding.</div></div>`;
  }
}

function paintStatus() {
  const s = $("#deskStatus");
  const m = $("#modelPill");
  if (!LIVE) return;
  const a = LIVE.arkiv, z = LIVE.zerog;
  if (a.connected && a.funded) {
    s.className = "pill pill--live";
    s.textContent = `Arkiv live · block ${a.block}`;
  } else if (a.connected) {
    s.className = "pill pill--sim";
    s.textContent = "Arkiv connected · wallet unfunded";
  } else {
    s.className = "pill pill--sim";
    s.textContent = "Arkiv not connected";
  }
  if (z.verifiability) {
    m.hidden = false;
    m.className = z.connected ? "pill pill--live" : "pill pill--sim";
    m.textContent = `${z.model} · ${z.verifiability}${z.teeType ? "/" + z.teeType : ""}${z.connected ? "" : " · no key"}`;
  }

  /* The three header dots. Green only ever means "this answered just now" —
     if it is amber or red, something on screen is not what it claims to be,
     and the user should be able to see that without opening a tab. */
  const state = {
    arkiv: !a.connected ? "down" : a.funded ? "up" : "warn",
    chain: LIVE.contracts?.connected ? "up" : "down",
    zerog: z.connected ? "up" : z.keyPresent ? "warn" : "down",
  };
  for (const [k, v] of Object.entries(state)) {
    const el = $(`.livedot[data-live="${k}"]`);
    if (el) el.dataset.state = v;
  }

  /* the chain pill links to the contract, so the claim is one click from proof */
  const c = LIVE.contracts, cp = $("#chainPill");
  if (c) {
    cp.hidden = false;
    cp.className = c.connected ? "pill pill--live" : "pill pill--sim";
    cp.textContent = c.connected
      ? `Sepolia · ${c.codeBytes} bytes${c.ensIsLiveRegistry ? " · live ENSv2" : ""}`
      : "contract not reachable";
    if (c.explorer) cp.href = c.explorer;
  }

  /* The lane price is the contract's baseBond, not a number in the markup. */
  const lp = $("#lanePrice");
  if (lp && c?.connected) lp.textContent = `refundable · up to ${c.baseBond} ${tokenSymbol()}`;
  else if (lp) lp.textContent = "refundable · chain unreachable";

  if (!$("#reporter").value.trim()) paintBondDefault();
}

function paintQueue() {
  const q = $("#queue");
  if (!QUEUE.length) {
    q.innerHTML = `<div class="empty"><div class="empty__t">Inbox zero</div>
      <div class="empty__d">Nothing is waiting on a human.</div></div>`;
    return;
  }
  q.innerHTML = "";
  for (const it of QUEUE) {
    const b = document.createElement("button");
    b.className = "qrow";
    b.dataset.case = it.caseId;
    b.setAttribute("aria-current", String(it.caseId === current));
    const sev = (it.severity || "low").toLowerCase();
    const soon = (it.daysLeft ?? 90) <= 14;
    b.innerHTML = `
      <span class="qrow__sev sev-${esc(sev)}">${esc(sev.slice(0, 1))}</span>
      <span>
        <span class="qrow__t">${esc(it.title || "(untitled)")}</span>
        <span class="qrow__m">${esc(it.repo)}#${esc(it.issue)} · ${esc(it.lane || "free")} lane${it.simulated ? " · sample" : ""}</span>
      </span>
      <span class="qrow__r">
        <span class="days ${soon ? "days--soon" : ""}">${it.daysLeft ?? "—"}</span>
        <span class="days__l">days left</span>
      </span>`;
    b.addEventListener("click", () => select(it.caseId));
    q.append(b);
  }
}

function select(caseId) {
  current = caseId;
  $$(".qrow").forEach((r) => r.setAttribute("aria-current", String(r.dataset.case === caseId)));
  const it = QUEUE.find((x) => x.caseId === caseId);
  if (!it) return;
  $("#detail").innerHTML = `
    <div class="card">
      <div class="card__h">
        <span class="card__t">${esc(it.title)}</span>
      </div>
      <p class="note">${esc(it.body || "")}</p>
      <div class="kv" style="margin-top:var(--s4)">
        <span class="kv__k">case</span><span class="kv__v"><span class="mono-chip">${esc(it.caseId)}</span></span>
      </div>
      <div class="kv"><span class="kv__k">project</span><span class="kv__v">${esc(it.repo)} · issue #${esc(it.issue)}</span></div>
      <div class="kv"><span class="kv__k">lane</span><span class="kv__v">${esc(it.lane || "free")}</span></div>
      <div class="actions">
        <button class="btn btn--primary" id="runTriage">Read it in the enclave</button>
      </div>
      <div id="verdict"></div>
    </div>`;
  $("#runTriage").addEventListener("click", () => runTriage(it));
}

async function runTriage(it) {
  const btn = $("#runTriage");
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> asking the enclave…`;
  try {
    const r = await fetch("/api/triage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caseId: it.caseId, repo: it.repo, severity: it.severity, title: it.title, body: it.body }),
    });
    const v = await r.json();
    paintVerdict(v);
  } catch (e) {
    toast("Triage failed — see the server log");
  } finally {
    btn.disabled = false;
    btn.textContent = "Read it in the enclave";
  }
}

function paintVerdict(v) {
  const call = v.call || "plausible";
  const words = {
    valid: "A real finding",
    plausible: "Good faith, unconfirmed",
    fabricated: "Fabricated",
  };
  $("#verdict").innerHTML = `
    <div style="margin-top:var(--s6)">
      <div class="call call--${esc(call)}">
        <div>
          <div class="call__n">${esc(call)}</div>
          <div class="call__s">${esc(words[call])} — ${esc(v.summary || "")}</div>
        </div>
      </div>

      <div class="verdict">
        <div class="verdict__h">
          <span class="label">${v.simulated ? "simulation · no enclave contacted" : "0G Private Computer · sealed enclave"}</span>
        </div>
        <div class="verdict__b">
          <div class="kv"><span class="kv__k">model</span><span class="kv__v">${esc(v.model || "—")}</span></div>
          <div class="kv"><span class="kv__k">trust mode</span>
            <span class="kv__v ${v.simulated ? "" : "kv__v--ok"}">${esc(v.trustMode || "—")}</span></div>
          <div class="kv"><span class="kv__k">request id</span>
            <span class="kv__v">${v.requestId ? `<span class="mono-chip">${esc(v.requestId)}</span>` : '<span class="kv__v--no">none — nothing was sent</span>'}</span></div>
          <div class="kv"><span class="kv__k">confidence</span><span class="kv__v">${v.confidence ? (v.confidence * 100).toFixed(0) + "%" : "—"}</span></div>
          <div class="kv"><span class="kv__k">reasoning</span><span class="kv__v">${esc(v.reasoning || "")}</span></div>
          ${v.simulated ? `<div class="kv"><span class="kv__k">why simulated</span><span class="kv__v kv__v--no">${esc(v.reason || "")}</span></div>` : ""}
        </div>
      </div>

      <div class="humanline">
        
        <span><b>A first opinion, not a sentence.</b> Your decision settles the bond, not the model's.</span>
      </div>

      <div class="actions">
        <button class="btn btn--good" data-settle="valid">Refund · grant tier</button>
        <button class="btn" data-settle="wrong">Refund · wrong but honest</button>
        <button class="btn btn--danger" data-settle="fabricated">Slash to triage pool</button>
      </div>
    </div>`;

  $$("[data-settle]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.settle;
    const msg = {
      valid: "Bond returned. A tier was written to their ENS name.",
      wrong: "Bond returned in full.",
      fabricated: "Forfeited to the triage pool, not to you.",
    }[k];
    toast(msg);
  }));
}

/* ---------- board ---------------------------------------------------------- */
async function loadBoard() {
  waiting("#boardQueue", "Reading open disclosures…");
  waiting("#extensions", "Checking for extensions…");
  try {
    const r = await fetch("/api/board");
    const d = await r.json();
    LIVE = d.live;

    const soon = (d.rows || []).filter((x) => (x.daysLeft ?? 90) <= 14).length;
    $("#stats").innerHTML = [
      [d.open ?? 0, "open reports"],
      [soon, "under 14 days"],
      [(d.ghosts || []).length, "overdue"],
      [(d.extensions || []).length, "extended"],
    ].map(([v, k]) => `<div class="stat"><div class="stat__v">${v}</div><div class="stat__k">${k}</div></div>`).join("");

    const ext = $("#extensions");
    if (!(d.extensions || []).length) {
      ext.innerHTML = `<div class="empty" style="padding:var(--s7)">
        <div class="empty__t">Nobody has bought more time</div>
        <div class="empty__d">No deadline this instance owns has moved.</div></div>`;
    } else {
      ext.innerHTML = d.extensions.map((e) => `
        <div class="extended">
          
          <div>
            <div class="extended__t">Deadline pushed back</div>
            <div class="extended__m">${esc(e.entityKey)} → block ${esc(e.newExpiryBlock)} · by ${esc(e.owner)}</div>
          </div>
        </div>`).join("");
    }

    const bq = $("#boardQueue");
    const rows = (d.rows || []).slice().sort((a, b) => (a.daysLeft ?? 90) - (b.daysLeft ?? 90));
    bq.innerHTML = rows.length ? rows.map((it) => {
      const sev = (it.severity || "low").toLowerCase();
      const soonCls = (it.daysLeft ?? 90) <= 14 ? "days--soon" : "";
      return `<div class="qrow" style="cursor:default">
        <span class="qrow__sev sev-${esc(sev)}">${esc(sev.slice(0, 1))}</span>
        <span><span class="qrow__t">${esc(it.title)}</span>
        <span class="qrow__m">${esc(it.repo)}#${esc(it.issue)}${it.simulated ? " · sample" : ""}</span></span>
        <span class="qrow__r"><span class="days ${soonCls}">${it.daysLeft ?? "—"}</span>
        <span class="days__l">days left</span></span></div>`;
    }).join("") : `<div class="empty"><div class="empty__t">Nothing on the clock</div>
      <div class="empty__d">No open disclosures.</div></div>`;

    $("#extPill").className = LIVE?.arkiv?.connected ? "pill pill--live" : "pill pill--sim";
    $("#extPill").textContent = LIVE?.arkiv?.connected ? "watching Arkiv" : "not connected";
  } catch {
    toast("Could not load the board");
  }
}

/* ---------- boot -----------------------------------------------------------
   No show() call here. The initial view is chosen from the URL hash up top,
   so /app#desk opens the desk. A hard show("report") used to sit on this line
   and silently overrode it, which broke every deep link from the front page. */
fetch("/api/health").then((r) => r.json()).then((h) => { LIVE = h; paintStatus(); }).catch(() => {});

/* ===========================================================================
   GITHUB — a project's own record, measured live.
   ----------------------------------------------------------------------------
   The Project field is the whole integration in miniature: type a repo and the
   bond is derived from that project's real issue tracker, with the specific
   issues that justify it linked underneath.

   Two interaction rules, both deliberate:

   · the in-flight request is ABORTED the moment the input changes, so a slow
     answer for `cur` can never overwrite a fresh answer for `curl/curl`
   · the panel shows its busy state on the FIRST keystroke, not after the
     debounce, so typing never feels like nothing is happening
   ======================================================================== */
const band = (bondMultiple) => (bondMultiple <= 1.01 ? "clean" : bondMultiple < 1.6 ? "some" : "bad");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

let ghController = null;
let ghTimer = null;

async function measureRepo(slug, windowDays = 7) {
  ghController?.abort();
  ghController = new AbortController();
  const r = await fetch(
    `/api/github/measure?slug=${encodeURIComponent(slug)}&window=${windowDays}`,
    { signal: ghController.signal },
  );
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function paintGh(data) {
  const panel = $("#ghPanel");
  const s = data.signals;
  const risk = data.promise.risk;

  panel.hidden = false;
  panel.classList.remove("gh--busy");
  panel.dataset.band = band(risk.bondMultiple);

  const slugEl = $("#ghSlug");
  slugEl.textContent = data.slug;
  slugEl.href = data.githubUrl;

  $("#ghStars").textContent =
    `${s.stars.toLocaleString()} stars · pushed ${s.lastPushDays}d ago` +
    (data.posture?.securityMd ? " · SECURITY.md" : " · no SECURITY.md");

  $("#ghOpen").textContent = s.openIssuesSampled;
  $("#ghSilent").textContent = s.unanswered;
  $("#ghWorst").textContent = s.oldestUnansweredDays ? s.oldestUnansweredDays + "d" : "—";
  $("#ghBond").textContent = risk.bondMultiple + "\u00D7";

  /* State the finding in the maintainer's own numbers. No adjectives. */
  $("#ghVerdict").innerHTML = data.promise.supported
    ? `<b>Nothing is waiting past ${risk.proposedWindowDays} days.</b> This project's record supports the promise, so the response bond stays at the floor.`
    : `<b>${plural(risk.breaches, "report has", "reports have")} already waited longer than the ${risk.proposedWindowDays} days being promised.</b> The bond is priced from that gap — not from an opinion about the maintainer.`;

  $("#ghEvidence").innerHTML = (risk.breachExamples || [])
    .map((b) => `<li><a href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">waiting ${b.waitingDays} days → ${esc(b.url.replace("https://github.com/", ""))}</a></li>`)
    .join("");

  $("#ghLaneId").textContent = `lane id ${data.repoId}`;
  $("#ghLaneDeriv").textContent = `= keccak256("github.com/${data.slug}") — recompute it yourself`;
}

function ghBusy(on) {
  const panel = $("#ghPanel");
  if (on) { panel.hidden = false; panel.classList.add("gh--busy"); }
  else panel.classList.remove("gh--busy");
}

function ghFail(msg) {
  const panel = $("#ghPanel");
  panel.classList.remove("gh--busy");
  panel.hidden = true;
  $("#repoHint").textContent = msg;
}

async function runRepoMeasure() {
  const slug = $("#repo").value.trim();
  if (!slug) { ghFail("Any public GitHub project. We read its issue tracker, not its promises."); return; }
  try {
    const data = await measureRepo(slug, 7);
    paintGh(data);
    $("#repoHint").textContent = "Measured live from GitHub just now.";
  } catch (e) {
    if (e.name === "AbortError") return;   // superseded by a newer keystroke
    ghFail(e.message);
  }
}

const repoInput = $("#repo");
if (repoInput) {
  repoInput.addEventListener("input", () => {
    ghBusy(true);                 // feedback on the keystroke, not after the wait
    clearTimeout(ghTimer);
    ghTimer = setTimeout(runRepoMeasure, 450);
  });
  repoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { clearTimeout(ghTimer); runRepoMeasure(); }
  });
  /* measure whatever is prefilled, so the panel is never empty on arrival */
  runRepoMeasure();
}

/* ---------- the Projects board -------------------------------------------- */
async function loadLanes() {
  waiting("#lanesList", "Reading projects…");
  const list = $("#lanesList");
  list.innerHTML = `<div style="padding:28px;text-align:center"><span class="spin"></span></div>`;
  try {
    const r = await fetch("/api/lanes");
    const j = await r.json();

    $("#lanesSource").textContent = j.source === "arkiv"
      ? `${plural(j.lanes.length, "project", "projects")} read from Arkiv · Rabdi ${j.live?.arkiv?.chainId ?? ""}`
      : "Arkiv unavailable";

    if (!j.lanes.length) {
      list.innerHTML = `<div class="card"><p class="note">No projects measured yet. Add one above.</p></div>`;
      return;
    }

    list.innerHTML = j.lanes.map((l) => `
      <div class="lane-row" data-band="${band(l.bondMultiple)}">
        <div>
          <a class="lane-row__n" href="${esc(l.githubUrl)}" target="_blank" rel="noopener noreferrer">${esc(l.slug)}</a>
          <span class="lane-row__sub">
            ${l.stars.toLocaleString()} stars ·
            ${l.verified ? "maintainer seat claimed" : "maintainer seat open"} ·
            promising ${l.windowDays}d
          </span>
        </div>
        <div class="lane-row__m">${l.openIssues}</div>
        <div class="lane-row__m">${l.unanswered}</div>
        <div class="lane-row__m">${l.oldestUnansweredDays || "—"}${l.oldestUnansweredDays ? "d" : ""}</div>
        <div class="lane-row__bond">${l.bondMultiple}&#215;</div>
      </div>`).join("");
  } catch (e) {
    list.innerHTML = `<div class="card"><p class="note">Could not read the lanes: ${esc(e.message)}</p></div>`;
  }
}

$("#laneMeasure")?.addEventListener("click", async () => {
  const slug = $("#laneSlug").value.trim();
  const windowDays = Number($("#laneWindow").value);
  const note = $("#laneNote");
  if (!slug) { note.textContent = "Enter an owner/repo."; return; }
  note.textContent = "reading GitHub…";
  try {
    const d = await measureRepo(slug, windowDays);
    const r = d.promise.risk;
    note.innerHTML = `<b>${esc(d.slug)}</b> — ${r.band}, bond <b>${r.bondMultiple}&#215;</b>. ` +
      `Run <code>npm run github:bind -- ${esc(d.slug)} --window ${windowDays}</code> to publish it to Arkiv.`;
    toast(`${d.slug}: ${r.bondMultiple}\u00D7 bond — ${r.band}`);
  } catch (e) {
    if (e.name === "AbortError") return;
    note.textContent = e.message;
  }
});

/* ===========================================================================
   THE BOND, READ FROM THE CHAIN
   ---------------------------------------------------------------------------
   This panel exists because "no hard-coded values" has to be visible, not
   asserted. The number below is bondFor() on Sepolia, which reaches through
   our contract into the live ENSv2 registry to decide whether a tier on the
   reporter's name waives the bond. Paste a different address and it changes.

   Same two interaction rules as the Project field: abort in flight so a slow
   answer for a half-typed address cannot overwrite a fresh one, and show the
   busy state immediately rather than after the debounce.
   ======================================================================== */
/* The ticker comes from the token's own symbol() via /api/health. It used to
   be the literal "WASP" while the deployed contract answers "MOCK" — a
   hard-coded unit sitting beside a number whose whole selling point is that
   it was read from the chain. `tokens` is the fallback, because inventing a
   ticker is what caused this. */
const tokenSymbol = () => LIVE?.contracts?.tokenSymbol || "tokens";
const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

/* The last quote the chain gave us, so the submit button can state the real
   amount instead of a number typed into a string. Null until someone enters
   an address — and the copy has to handle that, rather than guessing. */
let LAST_QUOTE = null;

let bondController = null;
let bondTimer = null;

function paintBondDefault() {
  LAST_QUOTE = null;
  const c = LIVE?.contracts;
  const panel = $("#bondPanel");
  if (!c?.connected) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.classList.remove("bondq--busy");
  panel.dataset.state = "default";
  $("#bondAmount").textContent = c.baseBond;
  $("#bondUnit").textContent = `${tokenSymbol()} — the full bond`;
  $("#bondReason").textContent =
    "This is the base bond for a reporter with no history and no tier. Enter an address to see what you would actually pay.";
  $("#bondLink").href = c.explorer;
}

function paintBond(q) {
  LAST_QUOTE = q;
  const panel = $("#bondPanel");
  panel.hidden = false;
  panel.classList.remove("bondq--busy");
  panel.dataset.state = q.waived ? "waived" : "due";

  $("#bondAmount").textContent = q.waived ? "Free" : q.bond;
  $("#bondUnit").textContent = q.waived ? "no bond to post" : `${tokenSymbol()} — refundable`;

  /* Say WHY, because "0" means two very different things: a first-timer being
     let in, and a reputation that has already been earned. */
  $("#bondReason").textContent =
    q.tier > 0
      ? `Tier ${q.tier} on this name waives the bond. That tier was earned on a previous report, and it is not ours to take away — it lives on the ENS name, not in our database.`
      : q.waived
        ? "First report from this address is free. The door is open by default; the bond only ever buys priority."
        : `No tier on this name yet, so the full ${q.baseBond} ${tokenSymbol()} applies. You get all of it back if the report is real — and all of it back if it is simply wrong.`;

  $("#bondLink").href = LIVE?.contracts?.explorer ?? "#";
}

async function quoteBond(reporter) {
  bondController?.abort();
  bondController = new AbortController();
  const r = await fetch(`/api/chain/bond?reporter=${encodeURIComponent(reporter)}`, {
    signal: bondController.signal,
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

$("#reporter").addEventListener("input", (e) => {
  const v = e.target.value.trim();
  const hint = $("#reporterHint");
  clearTimeout(bondTimer);

  if (!v) {
    bondController?.abort();
    hint.textContent = "We read your tier from ENS. We never ask you to sign anything here.";
    paintBondDefault();
    return;
  }
  if (!isAddress(v)) {
    bondController?.abort();
    hint.textContent = "That is not a 0x address yet — 42 characters including the 0x.";
    return;
  }

  hint.textContent = "Reading bondFor() on Sepolia…";
  $("#bondPanel").hidden = false;
  $("#bondPanel").classList.add("bondq--busy");

  bondTimer = setTimeout(async () => {
    try {
      const q = await quoteBond(v);
      hint.textContent = q.source;
      paintBond(q);
    } catch (err) {
      if (err.name === "AbortError") return;
      hint.textContent = err.message;
      $("#bondPanel").classList.remove("bondq--busy");
    }
  }, 320);
});

/* ============================================================================
   THE TWO SIDES, ON CHAIN
   ----------------------------------------------------------------------------
   Until now every screen here was a read. This is where the product becomes
   two-sided: a reporter files and posts a bond, a maintainer opens a lane and
   settles. Both sign from their own wallet; this app never holds a key.

   The sequence a reporter goes through, and why it is this order:
     1. seal   — the body is encrypted and recorded on Arkiv, which returns
                 the entity key. Done FIRST because submit() needs that key.
     2. submit — the chain transaction, signed by the reporter.
   Sealing before signing means a refused signature leaves a disclosure record
   with no bond against it, which is recoverable. Signing first would put a
   bond against a report that does not exist, which is not.
   ========================================================================= */

import * as W from "./wallet.js";

const tray = {
  el: () => $("#tray"),
  show(state, title, note, link) {
    const t = this.el();
    t.hidden = false;
    t.dataset.state = state;
    $("#trayTitle").textContent = title;
    $("#trayNote").textContent = note ?? "";
    const a = $("#trayLink");
    if (link) { a.hidden = false; a.href = link; } else { a.hidden = true; }
  },
  hide() { this.el().hidden = true; },
};
$("#trayClose")?.addEventListener("click", () => tray.hide());

/* ---------- connect ---------------------------------------------------------- */
function paintWallet(s) {
  const b = $("#connect");
  if (!b) return;
  if (s.connected) {
    b.dataset.connected = "1";
    b.textContent = W.short(s.account);
    b.title = s.account;
  } else {
    delete b.dataset.connected;
    b.textContent = "Connect wallet";
    b.title = "";
  }
}
W.onChange(paintWallet);
W.resume().then(() => paintWallet(W.state()));

$("#connect")?.addEventListener("click", async () => {
  if (W.state().connected) { toast("Switch accounts in your wallet"); return; }
  try {
    await W.connect();
    toast("Wallet connected on Sepolia");
  } catch (e) {
    tray.show("fail", "Could not connect", e.message);
  }
});

/* ---------- one place that signs ------------------------------------------------
   Every write in the product goes through here, so the four states are
   described identically wherever they happen. */
async function signAndWait(what, args, { working, done }) {
  tray.show("work", working ?? "Preparing the transaction", "Building the call data");
  const req = await W.build(what, args);
  tray.show("work", req.label ?? working, req.note ?? "Confirm it in your wallet");
  const { hash } = await W.send(req, {
    onHash: (h) => tray.show("work", "Waiting for a block", "Submitted — not confirmed yet.", W.txUrl(h)),
  });
  tray.show("done", done ?? "Confirmed", "Mined on Sepolia.", W.txUrl(hash));
  return hash;
}

/* ---------- reporter: seal, then file -------------------------------------------- */
async function fileReport() {
  const repo = $("#repo").value.trim().toLowerCase();
  const title = $("#title").value.trim();
  const body = $("#body").value.trim();
  const lane = $('.lane[aria-pressed="true"]')?.dataset.lane ?? "priority";
  const note = $("#submitNote");

  if (!repo || !title || !body) { note.textContent = "A project, a title and a description are needed."; return; }

  try {
    /* The lane must exist on chain before a report can be filed against it:
       submit() reverts with RepoInactive otherwise. Say that in words rather
       than letting the wallet show a raw revert. */
    const lanes = await fetch(`/api/chain/lane?slug=${encodeURIComponent(repo)}`).then((r) => r.json());
    if (!lanes.registered) {
      note.textContent = `No lane is open for ${repo} yet. A maintainer has to open one first — see the Projects tab.`;
      tray.show("fail", "That project has no lane yet",
        "Nobody has staked a response pool for it, so there is nothing to report into.");
      return;
    }

    tray.show("work", "Sealing the report", "Encrypting, then recording the disclosure clock on Arkiv.");
    const sealRes = await fetch("/api/report/seal", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, title, body, issue: $("#issue").value,
        severity: $("#sev").value, lane, reporter: W.state().account }),
    });
    const sealed = await sealRes.json();
    if (!sealRes.ok || sealed.error) throw new Error(sealed.error ?? "Could not record the report");

    note.textContent = `Recorded as ${sealed.caseId}. Confirm the filing in your wallet.`;

    await signAndWait("submit", { repoId: lanes.repoId, arkivKey: sealed.arkivKey, labelId: 0 },
      { working: "Filing the report", done: `Filed — ${sealed.caseId}` });

    note.textContent = `Filed. ${sealed.caseId} is on the clock, and the bond is held by the contract.`;
    setTimeout(() => show("desk"), 1200);
  } catch (e) {
    note.textContent = e.message;
    tray.show("fail", "The report was not filed", e.message);
  }
}

$("#submit")?.addEventListener("click", fileReport);

/* ---------- maintainer: open a lane ----------------------------------------------
   registerRepo() stakes a pool and sets the window. Both are real money and a
   real promise, so the control states the consequence before it is pressed,
   not after. */
async function openLane() {
  const slug = ($("#laneSlug")?.value ?? "").trim().toLowerCase();
  const pool = ($("#lanePool")?.value ?? "100").trim();
  const days = ($("#laneWindow")?.value ?? "7").trim();
  const note = $("#laneNote");

  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(slug)) {
    if (note) note.textContent = "Use the owner/repo form, lowercase.";
    return;
  }
  try {
    if (!W.state().connected) await W.connect();

    /* The pool is pulled with transferFrom, so tokens and an allowance both
       have to be in place first. Checking here means the user is told what is
       missing instead of meeting a TransferFailed revert. */
    const pre = await W.preflight(pool);
    if (pre?.needsTokens) {
      await signAndWait("mint", { to: W.state().account, amount: "500" },
        { working: "Getting demo tokens", done: "500 WASP minted" });
    }
    if (pre?.needsApproval || pre?.needsTokens) {
      await signAndWait("approve", { amount: "1000" },
        { working: "Approving the bond currency", done: "Approved" });
    }

    await signAndWait("register", { slug, pool, windowDays: Number(days) },
      { working: `Opening the lane for ${slug}`, done: `${slug} is open` });

    if (note) note.textContent = `${slug} is live. Reports filed against it are now bonded both ways.`;
    loadLanes();
  } catch (e) {
    if (note) note.textContent = e.message;
    tray.show("fail", "The lane was not opened", e.message);
  }
}
document.addEventListener("click", (e) => {
  if (e.target.closest("#openLane")) openLane();
});

/* ---------- maintainer: settle ------------------------------------------------------
   Three verdicts, and the enclave's opinion is only ever a suggestion — the
   maintainer signs, so the maintainer decides. */
async function settle(reportId, verdict) {
  const words = { valid: "Settled as valid — bond refunded and a tier granted",
                  goodFaith: "Settled as good faith — bond refunded in full",
                  slop: "Settled as fabricated — bond sent to the triage pool" };
  try {
    await signAndWait("resolve", { reportId, verdict },
      { working: "Settling the report", done: words[verdict] });
    loadQueue();
  } catch (e) {
    tray.show("fail", "The report was not settled", e.message);
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-settle]");
  if (!b) return;
  const id = b.dataset.reportId;
  if (!id) { toast("This case has no on-chain report id yet"); return; }
  settle(id, b.dataset.settle);
});

/* ---------- anyone: claim a ghosted report --------------------------------------------
   Deliberately not gated to the reporter. If the maintainer goes quiet past
   the window, any passer-by can trigger the payout and the reporter is the
   one paid — which is what stops the promise depending on the promiser. */
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-ghost]");
  if (!b) return;
  try {
    await signAndWait("ghosted", { reportId: b.dataset.ghost },
      { working: "Claiming the response bond", done: "Claimed — the reporter was paid" });
    loadBoard();
  } catch (err) {
    tray.show("fail", "The claim did not go through", err.message);
  }
});
