/* WaspBounty — app client. No framework. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let LIVE = null;
let QUEUE = [];
let current = null;

/* ---------- chrome --------------------------------------------------------- */
function show(view) {
  document.body.dataset.view = view;
  $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === view)));
  $$(".view").forEach((v) => { v.hidden = v.id !== "view-" + view; });
  if (view === "desk") loadQueue();
  if (view === "board") loadBoard();
  window.scrollTo({ top: 0, behavior: "instant" });
}
$$(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));

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
    note.textContent = "Queued for machine triage. No bond held, no wallet needed.";
    toast("Report filed — free lane. Nothing was charged.");
  } else {
    note.textContent = "Bond of 0.01 ETH would be escrowed here once the contract is deployed.";
    toast("Priority lane selected — contract not deployed yet, so nothing was signed.");
  }
  setTimeout(() => show("desk"), 900);
});

/* ---------- desk ----------------------------------------------------------- */
async function loadQueue() {
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

/* ---------- boot ----------------------------------------------------------- */
fetch("/api/health").then((r) => r.json()).then((h) => { LIVE = h; paintStatus(); }).catch(() => {});
show("report");
