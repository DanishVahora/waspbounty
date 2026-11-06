/* WaspBounty — app client. No framework. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let LIVE = null;
let QUEUE = [];
let current = null;

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

$("#submit").addEventListener("click", () => {
  const lane = $('.lane[aria-pressed="true"]')?.dataset.lane ?? "priority";
  const note = $("#submitNote");

  if (lane === "free") {
    note.textContent = "Queued for the enclave. No bond held, no wallet needed, no account.";
    toast("Filed on the free lane. Nothing was charged.");
  } else {
    /* Quote the real number from the chain, and be exact about what did NOT
       happen. The app never signs for anyone: posting the bond is a
       transaction the reporter sends from their own wallet. Saying "escrowed"
       here would claim a transfer that has not occurred. */
    const q = LAST_QUOTE;
    const amount = q ? (q.waived ? "no bond" : `${q.bond} ${TOKEN}`) : "your bond";
    note.textContent = q?.waived
      ? `Queued, and ${q.reason.toLowerCase()} — so there is nothing to sign.`
      : `Next step is ${amount}, signed from your own wallet. We never hold your key, so nothing has moved yet.`;
    toast(q?.waived ? "Filed — no bond was due." : `Filed. ${amount} to post when you sign.`);
  }
  setTimeout(() => show("desk"), 900);
});


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
  waiting("#queue", "Reading the queue from Arkiv…");
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
      <div class="empty__d">Is it still running? <code>npm run serve</code></div></div>`;
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
    const el = $(`.dot[data-live="${k}"]`);
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
  if (lp && c?.connected) lp.textContent = `refundable · up to ${c.baseBond} ${TOKEN}`;
  else if (lp) lp.textContent = "refundable · chain unreachable";

  if (!$("#reporter").value.trim()) paintBondDefault();
}

function paintQueue() {
  const q = $("#queue");
  if (!QUEUE.length) {
    q.innerHTML = `<div class="empty"><div class="empty__t">Inbox zero</div>
      <div class="empty__d">Nothing is waiting on a human right now. That is the whole point.</div></div>`;
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
            <span class="kv__v ${v.simulated ? "" : "kv__v--ok"}">${esc(v.trustMode || "—")}${v.simulated ? "" : " — the prompt never left the enclave"}</span></div>
          <div class="kv"><span class="kv__k">request id</span>
            <span class="kv__v">${v.requestId ? `<span class="mono-chip">${esc(v.requestId)}</span>` : '<span class="kv__v--no">none — nothing was sent</span>'}</span></div>
          <div class="kv"><span class="kv__k">confidence</span><span class="kv__v">${v.confidence ? (v.confidence * 100).toFixed(0) + "%" : "—"}</span></div>
          <div class="kv"><span class="kv__k">reasoning</span><span class="kv__v">${esc(v.reasoning || "")}</span></div>
          ${v.simulated ? `<div class="kv"><span class="kv__k">why simulated</span><span class="kv__v kv__v--no">${esc(v.reason || "")}</span></div>` : ""}
        </div>
      </div>

      <div class="humanline">
        <span aria-hidden="true">✋</span>
        <span><b>This is a first opinion, not a sentence.</b> Nothing is slashed
        on a machine verdict. You decide, and your decision is what settles the bond.</span>
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
      valid: "Bond returned in full, tier 2 written to the reporter's ENS name.",
      wrong: "Bond returned in full. Being wrong is not slop.",
      fabricated: "Bond forfeited to the triage pool — not to you. A judge must not profit from the verdict.",
    }[k];
    toast(msg + " (contract not deployed yet)");
  }));
}

/* ---------- board ---------------------------------------------------------- */
async function loadBoard() {
  waiting("#boardQueue", "Reading open disclosures from Arkiv…");
  waiting("#extensions", "Checking whether anyone bought more time…");
  try {
    const r = await fetch("/api/board");
    const d = await r.json();
    LIVE = d.live;

    const soon = (d.rows || []).filter((x) => (x.daysLeft ?? 90) <= 14).length;
    $("#stats").innerHTML = [
      [d.open || (d.rows || []).length, "open reports"],
      [soon, "under 14 days"],
      [(d.ghosts || []).length, "maintainers overdue"],
      [(d.extensions || []).length, "deadlines extended"],
    ].map(([v, k]) => `<div class="stat"><div class="stat__v">${v}</div><div class="stat__k">${k}</div></div>`).join("");

    const ext = $("#extensions");
    if (!(d.extensions || []).length) {
      ext.innerHTML = `<div class="empty" style="padding:var(--s7)">
        <div class="empty__t">Nobody has bought more time</div>
        <div class="empty__d">Every disclosure deadline on record is still the one it started with.
        If that changes, Arkiv emits an event and it appears here within a block.</div></div>`;
    } else {
      ext.innerHTML = d.extensions.map((e) => `
        <div class="extended">
          <span aria-hidden="true">⏱</span>
          <div>
            <div class="extended__t">A disclosure deadline was pushed back</div>
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
      <div class="empty__d">No open disclosures right now.</div></div>`;

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
  waiting("#lanesList", "Reading registered projects from Arkiv…");
  const list = $("#lanesList");
  list.innerHTML = `<div style="padding:28px;text-align:center"><span class="spin"></span></div>`;
  try {
    const r = await fetch("/api/lanes");
    const j = await r.json();

    $("#lanesSource").textContent = j.source === "arkiv"
      ? `${plural(j.lanes.length, "project", "projects")} read from Arkiv · Rabdi ${j.live?.arkiv?.chainId ?? ""}`
      : `Arkiv unavailable (${j.source})`;

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
        <div class="lane-row__m">${l.openIssues}<i>open</i></div>
        <div class="lane-row__m">${l.unanswered}<i>unanswered</i></div>
        <div class="lane-row__m">${l.oldestUnansweredDays || "—"}${l.oldestUnansweredDays ? "d" : ""}<i>longest wait</i></div>
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
  if (!slug) { note.textContent = "Give me an owner/repo."; return; }
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
const TOKEN = "WASP";
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
  $("#bondUnit").textContent = `${TOKEN} — the full bond`;
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
  $("#bondUnit").textContent = q.waived ? "no bond to post" : `${TOKEN} — refundable`;

  /* Say WHY, because "0" means two very different things: a first-timer being
     let in, and a reputation that has already been earned. */
  $("#bondReason").textContent =
    q.tier > 0
      ? `Tier ${q.tier} on this name waives the bond. That tier was earned on a previous report, and it is not ours to take away — it lives on the ENS name, not in our database.`
      : q.waived
        ? "First report from this address is free. The door is open by default; the bond only ever buys priority."
        : `No tier on this name yet, so the full ${q.baseBond} ${TOKEN} applies. You get all of it back if the report is real — and all of it back if it is simply wrong.`;

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
