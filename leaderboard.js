// ====== SIRIUS PAROLE 3.0 — Leaderboard, classifiche, ammonizioni ======
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, getDocs,
  runTransaction, serverTimestamp, increment,
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";
import { Game } from "./game.js";

// ---- Firebase config (stesso progetto parole-siriusv2) ----
// ===== CONFIG DI TEST (parole-sirius-3) — sostituire con parole-siriusv2 al lancio =====
const firebaseConfig = {
  apiKey: "AIzaSyBHF68ZRiezbM_bzKPmGG9WNId8afAeikk",
  authDomain: "parole-sirius-3.firebaseapp.com",
  projectId: "parole-sirius-3",
  storageBucket: "parole-sirius-3.firebasestorage.app",
  messagingSenderId: "339666353402",
  appId: "1:339666353402:web:dd4ae0f37ab91d1173dd43",
};

// ---- CODICI INVITO ----
// Forma: "CODICE": { name: "Nome", since: "AAAA-MM-GG" }
const INVITE_CODES = {
  "NICO-UF3Y":   { name: "Nico",   since: "2021-05-31" },
  "DANILO-BRJM": { name: "Danilo", since: "2021-05-31" },
  "MARIO-44R8":  { name: "Mario",  since: "2021-05-31" },
  "TEST-R88Y":   { name: "Test",   since: "2021-05-31" },
  "TEST2-5R4N":  { name: "Test2",  since: "2021-05-31" },
  "MAX-77A4":    { name: "Max",    since: "2021-05-31" },
  "ALDO-A99T":   { name: "Aldo",   since: "2021-05-31" },
  "SARA-99XB":   { name: "Sara",   since: "2026-06-13" },
  "LAURA-24AX":  { name: "Laura",  since: "2026-06-14" },
  "NILOO-8TXY":  { name: "Niloofar", since: "2026-06-14" },
  "ALE-VQ5V":    { name: "Alessandro", since: "2026-06-15" },
  "PIA-XRUC":    { name: "Pia",    since: "2026-06-15" },
  "FRA-ZZFE":    { name: "Francesco", since: "2026-06-15" },
  "MAX-Q4QM":    { name: "Max",    since: "2026-06-15" },
  "NICK-SUDY":   { name: "Nicholas", since: "2026-06-16" },
  "SAVE-KDBP":   { name: "Saverio", since: "2026-06-16" },
  "ISA-ZDNJ":    { name: "Isabella", since: "2026-06-16" },
  "STE-3332":    { name: "Stefano", since: "2026-06-16" },
  "VISC-5P52":   { name: "Vis",    since: "2026-06-16" },
  "GIU-VWST":    { name: "Giuliano", since: "2026-06-17" },
  "ILYA-6TUP":   { name: "Ilya",   since: "2026-06-17" },
  "DAV-PEV5":    { name: "Davide", since: "2026-06-18" },
  "TIZ-AJU3":    { name: "Tiziano", since: "2026-06-18" },
  "FEB-6V9A":    { name: "Fabietto", since: "2026-06-23" },
  "FAB-NVYN":    { name: "Fabio",  since: "2026-06-26" },
  "SIM-9YQY":    { name: "Simone", since: "2026-07-09" },
};

// ---- Costanti (devono combaciare col job) ----
const SEASON_START = new Date(2026, 6, 1); // 1 luglio 2026 (mese 0-based: 6 = luglio)
const SKIP_ATTEMPTS = 7;
const WARNING_THRESHOLD = 5;
const WARNING_PENALTY = 10;
const REASONS = ["Comportamento scorretto", "Ha barato", "Ha sentito la parola", "Ha visto la parola da qualcuno"];

const LS_CODE = "sirius3_code";

// ---- Utils ----
const $ = (id) => document.getElementById(id);
const norm = (c) => (c || "").trim().toUpperCase();
const getCode = () => norm(localStorage.getItem(LS_CODE));
const setCode = (c) => localStorage.setItem(LS_CODE, norm(c));
const nameFor = (c) => (INVITE_CODES[norm(c)] ? INVITE_CODES[norm(c)].name : null);
const sinceFor = (c) => (INVITE_CODES[norm(c)] ? INVITE_CODES[norm(c)].since : null);

function monthKeyNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function safe(s) { return String(s || "").replace(/[<>&]/g, ""); }

// Backfill: penalità per i giorni del mese prima dell'iscrizione (calcolo a vista)
function backfillFor(code) {
  const since = sinceFor(code);
  if (!since) return 0;
  const sinceDate = new Date(since + "T00:00:00");
  const monthStart = new Date(SEASON_START.getFullYear(), new Date().getMonth(), 1);
  const startRef = sinceDate > monthStart ? sinceDate : monthStart;
  // giorni dal monthStart (o inizio stagione) fino all'iscrizione
  const ref = startRef > SEASON_START ? startRef : SEASON_START;
  const diff = Math.floor((ref - Math.max(monthStart, SEASON_START)) / 86400000);
  return Math.max(0, diff) * SKIP_ATTEMPTS;
}

// ---- Modali helper ----
function openBackdrop(el) { if (el) el.classList.add("show"); }
function closeBackdrop(el) { if (el) el.classList.remove("show"); }

// ---- Firebase ----
let db;
async function initFirebase() {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  const auth = getAuth(app);
  await signInAnonymously(auth);
}

// =========================================================
//  CLASSIFICHE
// =========================================================
async function fetchDaily(dayOffset) {
  const col = collection(db, "leaderboards", String(dayOffset), "scores");
  const snap = await getDocs(col);
  return snap.docs
    .map((d) => ({ ...d.data(), _id: d.id }))
    .filter((it) => it.status !== "skipped")
    .sort((a, b) => (a.attempts - b.attempts) || 0);
}

async function fetchMonthly(monthKey) {
  const col = collection(db, "monthly", monthKey, "players");
  const snap = await getDocs(col);
  const items = snap.docs.map((d) => {
    const data = d.data();
    const backfill = backfillFor(d.id);
    return { ...data, _id: d.id, displayAttempts: (data.totalAttempts || 0) + backfill };
  });
  items.sort((a, b) => {
    if (a.displayAttempts !== b.displayAttempts) return a.displayAttempts - b.displayAttempts;
    if ((b.wins || 0) !== (a.wins || 0)) return (b.wins || 0) - (a.wins || 0);
    if ((b.games || 0) !== (a.games || 0)) return (b.games || 0) - (a.games || 0);
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  return items;
}

async function fetchHallOfFame() {
  const col = collection(db, "winners");
  const snap = await getDocs(col);
  return snap.docs
    .map((d) => ({ ...d.data(), _id: d.id }))
    .sort((a, b) => b._id.localeCompare(a._id));
}

// Snapshot posizioni per le frecce
async function saveSnapshot(monthKey, items) {
  try {
    const positions = {};
    items.forEach((it, i) => { positions[it._id] = i + 1; });
    await setDoc(doc(db, "snapshots", `${monthKey}_${todayISO()}`), { positions, ts: serverTimestamp() });
  } catch (_) {}
}
async function getYesterdaySnapshot(monthKey) {
  try {
    const snap = await getDocs(collection(db, "snapshots"));
    const prev = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((s) => s.id.startsWith(monthKey + "_") && s.id < `${monthKey}_${todayISO()}`)
      .sort((a, b) => b.id.localeCompare(a.id));
    return prev[0] || null;
  } catch (_) { return null; }
}

// =========================================================
//  AMMONIZIONI
// =========================================================
function warnRef(dayOffset, code) {
  return doc(db, "warnings", String(dayOffset), "received", code);
}

async function fetchWarningsForDay(dayOffset) {
  const col = collection(db, "warnings", String(dayOffset), "received");
  const snap = await getDocs(col);
  const map = {};
  snap.docs.forEach((d) => { map[d.id] = d.data(); });
  return map; // { codice: {count, penaltyApplied, byList} }
}

// Dà o ritira un'ammonizione (transazione atomica)
async function toggleWarning(dayOffset, targetCode, targetName, myCode, myName, reason) {
  const ref = warnRef(dayOffset, targetCode);
  const monthKey = monthKeyNow();
  const monthlyRef = doc(db, "monthly", monthKey, "players", targetCode);

  return await runTransaction(db, async (tx) => {
    // ---- FASE 1: TUTTE LE LETTURE PRIMA (regola Firestore) ----
    const snap = await tx.get(ref);
    const mSnap = await tx.get(monthlyRef);

    let data = snap.exists() ? snap.data() : { count: 0, penaltyApplied: false, byList: [] };
    const byList = data.byList || [];
    const already = byList.findIndex((x) => x.by === myCode);

    // ---- FASE 2: RAGIONAMENTO ----
    if (already >= 0) {
      // RITIRO — consentito solo se la penalità NON è ancora scattata
      if (data.penaltyApplied) {
        return { action: "locked" };
      }
      byList.splice(already, 1);
      data.count = byList.length;
      data.byList = byList;
      tx.set(ref, data);
      return { action: "removed", count: data.count };
    }

    // NUOVA AMMONIZIONE
    byList.push({ by: myCode, name: myName, reason });
    data.count = byList.length;
    data.byList = byList;

    let penaltyJustApplied = false;
    if (data.count >= WARNING_THRESHOLD && !data.penaltyApplied) {
      data.penaltyApplied = true;
      penaltyJustApplied = true;
    }

    // ---- FASE 3: TUTTE LE SCRITTURE DOPO ----
    tx.set(ref, data);
    if (penaltyJustApplied) {
      if (mSnap.exists()) {
        tx.update(monthlyRef, { totalAttempts: increment(WARNING_PENALTY) });
      } else {
        tx.set(monthlyRef, { name: targetName, totalAttempts: WARNING_PENALTY, games: 0, wins: 0 });
      }
    }
    return { action: "added", count: data.count, penalty: penaltyJustApplied };
  });
}

// =========================================================
//  SALVATAGGIO PARTITA
// =========================================================
async function hasPlayedToday(code, dayOffset) {
  try {
    const snap = await getDoc(doc(db, "leaderboards", String(dayOffset), "scores", code));
    return snap.exists();
  } catch (_) { return false; }
}

async function saveScore(dayOffset, code, name, attempts, status) {
  try {
    await setDoc(doc(db, "leaderboards", String(dayOffset), "scores", code),
      { name, attempts, status, ts: serverTimestamp() });
  } catch (_) { return; }
  const monthKey = monthKeyNow();
  const mRef = doc(db, "monthly", monthKey, "players", code);
  try {
    const mSnap = await getDoc(mRef);
    const prev = mSnap.exists() ? mSnap.data() : { name, totalAttempts: 0, games: 0, wins: 0 };
    await setDoc(mRef, {
      name,
      totalAttempts: (prev.totalAttempts || 0) + attempts,
      games: (prev.games || 0) + 1,
      wins: (prev.wins || 0) + (status === "win" ? 1 : 0),
      lastTs: serverTimestamp(),
    }, { merge: true });
  } catch (_) {}
}

// =========================================================
//  RENDERING CLASSIFICA
// =========================================================
let currentTab = "daily";
let currentDayOffset = null;
let warningsCache = {}; // ammonizioni del giorno corrente, per i cartellini

function medalClass(i) { return i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : ""; }
function medalIcon(i) { return i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : ""; }

function badgeHtml(code) {
  const w = warningsCache[code];
  if (!w || !w.count) return "";
  const cls = w.count >= WARNING_THRESHOLD ? "red" : "yellow";
  return `<span class="card-badge ${cls}" data-warn-detail="${code}"><span class="card-rect"></span>${w.count}</span>`;
}

function renderDaily(items, myCode) {
  const list = $("lb-list");
  list.innerHTML = "";
  if (!items.length) { list.innerHTML = `<div class="muted">Nessun punteggio ancora.</div>`; return; }
  items.forEach((it, i) => {
    const label = it.status === "win" ? `${it.attempts}/6` : `<span style="color:#e24b4a;font-weight:900">X</span>`;
    const row = document.createElement("div");
    row.className = `lb-item ${medalClass(i)}`;
    row.innerHTML = `
      <div class="lb-left">
        ${medalIcon(i) ? `<span class="medal">${medalIcon(i)}</span>` : `<div class="pill">${i + 1}</div>`}
        <div>${safe(it.name)}${it._id === myCode ? ' <small style="color:#6aaa64">(tu)</small>' : ""}${badgeHtml(it._id)}</div>
      </div>
      <div class="pill">${label}</div>`;
    list.appendChild(row);
  });
  attachBadgeHandlers();
}

function renderMonthly(items, yesterday, myCode) {
  const list = $("lb-list");
  list.innerHTML = "";
  if (!items.length) { list.innerHTML = `<div class="muted">Nessun punteggio questo mese.</div>`; return; }
  items.forEach((it, i) => {
    const pos = i + 1;
    let delta = "";
    if (yesterday && yesterday[it._id]) {
      const diff = yesterday[it._id] - pos;
      if (diff > 0) delta = `<span class="delta-up">▲${diff}</span>`;
      else if (diff < 0) delta = `<span class="delta-down">▼${Math.abs(diff)}</span>`;
      else delta = `<span class="delta-same">—</span>`;
    } else if (yesterday) {
      delta = `<span class="delta-up">NEW</span>`;
    }
    const row = document.createElement("div");
    row.className = `lb-item ${medalClass(i)}`;
    row.innerHTML = `
      <div class="lb-left">
        ${medalIcon(i) ? `<span class="medal">${medalIcon(i)}</span>` : `<div class="pill">${pos}</div>`}
        <div>${safe(it.name)}${it._id === myCode ? ' <small style="color:#6aaa64">(tu)</small>' : ""}${delta}${badgeHtml(it._id)}
          <div style="font-size:11px;color:#818384;margin-top:2px;">${it.games || 0}p · ${it.wins || 0}v</div>
        </div>
      </div>
      <div class="pill">${it.displayAttempts}</div>`;
    list.appendChild(row);
  });
  attachBadgeHandlers();
}

function renderHall(items, myCode) {
  const list = $("lb-list");
  list.innerHTML = "";
  if (!items.length) { list.innerHTML = `<div class="muted">Ancora nessun vincitore. Il primo sarà a fine mese!</div>`; return; }
  const MESI = ["", "gennaio","febbraio","marzo","aprile","maggio","giugno","luglio","agosto","settembre","ottobre","novembre","dicembre"];
  items.forEach((it) => {
    const [y, m] = it._id.split("-");
    const label = `${MESI[parseInt(m,10)]} ${y}`;
    const status = it.final ? "" : ' <small style="color:#c9b458">(in corso)</small>';
    const row = document.createElement("div");
    row.className = "lb-item gold";
    row.innerHTML = `
      <div class="lb-left">
        <span class="medal">🏆</span>
        <div>${safe(it.name)}${it.code === myCode ? ' <small style="color:#6aaa64">(tu)</small>' : ""}
          <div style="font-size:11px;color:#e8d9a0;margin-top:2px;">${label}${status}</div>
        </div>
      </div>
      <div class="pill">${it.totalAttempts != null ? it.totalAttempts : ""}</div>`;
    list.appendChild(row);
  });
}

function attachBadgeHandlers() {
  document.querySelectorAll("[data-warn-detail]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      showWarnDetail(el.getAttribute("data-warn-detail"));
    });
  });
}

function showWarnDetail(code) {
  const w = warningsCache[code];
  const list = $("detail-list");
  $("detail-title").textContent = `Ammonizioni di ${nameFor(code) || safe(code)}`;
  list.innerHTML = "";
  if (!w || !w.byList || !w.byList.length) {
    list.innerHTML = `<div class="muted">Nessuna ammonizione.</div>`;
  } else {
    w.byList.forEach((b) => {
      const row = document.createElement("div");
      row.className = "lb-item";
      row.innerHTML = `<div class="lb-left"><div>${safe(b.name)}</div></div><div class="muted">${safe(b.reason)}</div>`;
      list.appendChild(row);
    });
  }
  openBackdrop($("detail-backdrop"));
}

async function loadTab() {
  const myCode = getCode();
  const list = $("lb-list");
  list.innerHTML = `<div class="muted">Carico…</div>`;
  try {
    warningsCache = await fetchWarningsForDay(currentDayOffset);
    if (currentTab === "daily") {
      $("lb-subtitle").textContent = `Puzzle #${currentDayOffset}`;
      $("lb-hint").textContent = "Una partita al giorno.";
      renderDaily(await fetchDaily(currentDayOffset), myCode);
    } else if (currentTab === "monthly") {
      const mk = monthKeyNow();
      $("lb-subtitle").textContent = `Mese ${mk} — somma tentativi`;
      $("lb-hint").textContent = "▲ salita, ▼ discesa da ieri.";
      const items = await fetchMonthly(mk);
      const yest = await getYesterdaySnapshot(mk);
      renderMonthly(items, yest ? yest.positions : null, myCode);
      saveSnapshot(mk, items);
    } else {
      $("lb-subtitle").textContent = "I vincitori dei mesi passati";
      $("lb-hint").textContent = "";
      renderHall(await fetchHallOfFame(), myCode);
    }
  } catch (e) {
    list.innerHTML = `<div class="muted">Errore nel caricare.</div>`;
    $("lb-hint").textContent = String(e && e.message || e);
  }
}

function openLeaderboard(dayOffset) {
  currentDayOffset = dayOffset;
  currentTab = "daily";
  $("lb-tabs").querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === "daily"));
  openBackdrop($("lb-backdrop"));
  loadTab();
}

// =========================================================
//  MODALE AMMONIZIONI (lista persone)
// =========================================================
async function openWarnings(dayOffset) {
  const myCode = getCode();
  warningsCache = await fetchWarningsForDay(dayOffset);
  const list = $("warn-list");
  list.innerHTML = "";
  // Ordino: prima gli altri, escludo me stesso
  const codes = Object.keys(INVITE_CODES).filter((c) => c !== myCode);
  codes.forEach((code) => {
    const info = INVITE_CODES[code];
    const w = warningsCache[code] || { count: 0, byList: [] };
    const iAmmonished = (w.byList || []).some((x) => x.by === myCode);
    const locked = w.penaltyApplied;
    const row = document.createElement("div");
    row.className = "lb-item";
    let btnLabel, btnColor;
    if (iAmmonished && locked) { btnLabel = "Bloccato"; btnColor = "#555"; }
    else if (iAmmonished) { btnLabel = "Ritira"; btnColor = "#888"; }
    else { btnLabel = "Ammonisci"; btnColor = "#c9b458"; }
    row.innerHTML = `
      <div class="lb-left">
        <div>${safe(info.name)} ${badgeHtml(code)}</div>
      </div>
      <button class="close-x" style="background:${btnColor};border:none;color:${iAmmonished && !locked ? '#fff' : '#121213'};font-weight:700" data-warn-action="${code}" ${iAmmonished && locked ? "disabled" : ""}>${btnLabel}</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll("[data-warn-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleWarnAction(btn.getAttribute("data-warn-action")));
  });
  openBackdrop($("warn-backdrop"));
  attachBadgeHandlers();
}

let pendingWarnTarget = null;

async function handleWarnAction(targetCode) {
  const myCode = getCode();
  const w = warningsCache[targetCode] || { byList: [] };
  const iAmmonished = (w.byList || []).some((x) => x.by === myCode);

  if (iAmmonished) {
    // Ritiro diretto (se non bloccato)
    try {
      const res = await toggleWarning(currentDayOffset, targetCode, nameFor(targetCode), myCode, nameFor(myCode), null);
      if (res.action === "locked") {
        alert("Non puoi ritirare: la penalità è già scattata.");
      }
    } catch (e) { alert("Errore: " + (e.message || e)); }
    warningsCache = await fetchWarningsForDay(currentDayOffset);
    openWarnings(currentDayOffset);
    return;
  }

  // Nuova ammonizione: chiedi il motivo
  pendingWarnTarget = targetCode;
  const rlist = $("reason-list");
  $("reason-title").textContent = `Perché ammonisci ${nameFor(targetCode)}?`;
  rlist.innerHTML = "";
  REASONS.forEach((r) => {
    const b = document.createElement("button");
    b.className = "reason-btn";
    b.textContent = r;
    b.addEventListener("click", () => confirmWarn(r));
    rlist.appendChild(b);
  });
  openBackdrop($("reason-backdrop"));
}

async function confirmWarn(reason) {
  const myCode = getCode();
  const targetCode = pendingWarnTarget;
  closeBackdrop($("reason-backdrop"));
  try {
    const res = await toggleWarning(currentDayOffset, targetCode, nameFor(targetCode), myCode, nameFor(myCode), reason);
    if (res.penalty) {
      alert(`${nameFor(targetCode)} ha raggiunto ${WARNING_THRESHOLD} ammonizioni: +${WARNING_PENALTY} punti di penalità.`);
    }
  } catch (e) { alert("Errore: " + (e.message || e)); }
  warningsCache = await fetchWarningsForDay(currentDayOffset);
  openWarnings(currentDayOffset);
}

// =========================================================
//  FINE PARTITA
// =========================================================
function showEndModal(status, solution, attempts) {
  const isWin = status === "won";
  $("end-title").textContent = isWin ? "🎉 Hai vinto!" : "Peccato!";
  $("end-message").innerHTML = isWin
    ? `Hai indovinato <strong>${solution.toUpperCase()}</strong> in ${attempts}/6.`
    : `La parola era <strong>${solution.toUpperCase()}</strong>.`;
  const link = $("treccani-link");
  link.href = `https://www.treccani.it/vocabolario/ricerca/${encodeURIComponent(solution.toLowerCase())}/`;
  link.textContent = `Cerca "${solution.toUpperCase()}" su Treccani →`;
  openBackdrop($("end-backdrop"));
}

async function onGameEnd(info) {
  const code = getCode();
  const name = nameFor(code);
  if (!name) return;
  const already = await hasPlayedToday(code, info.dayOffset);
  if (!already) {
    if (info.status === "won") {
      await saveScore(info.dayOffset, code, name, Math.min(Math.max(info.attempts, 1), 6), "win");
    } else {
      await saveScore(info.dayOffset, code, name, 7, "lose");
    }
  }
  currentDayOffset = info.dayOffset;
  showEndModal(info.status, info.solution, info.attempts);
}

// =========================================================
//  BLOCCO "GIÀ GIOCATO OGGI"
// =========================================================
async function checkAlreadyPlayed(dayOffset) {
  const code = getCode();
  if (!code) return;
  const already = await hasPlayedToday(code, dayOffset);
  if (!already) return;
  Game.lock();
  const snap = await getDoc(doc(db, "leaderboards", String(dayOffset), "scores", code));
  const data = snap.exists() ? snap.data() : null;
  const label = data && data.status === "win" ? `${data.attempts}/6` : "non indovinata";
  $("end-title").textContent = "Hai già giocato oggi";
  $("end-message").innerHTML = `Risultato di oggi: <strong>${label}</strong>.<br>Torna domani per il prossimo puzzle.`;
  $("treccani-link").parentElement.style.display = "none";
  currentDayOffset = dayOffset;
  openBackdrop($("end-backdrop"));
}

// =========================================================
//  BOTTONE FLOTTANTE + DRAG
// =========================================================
function setupFab() {
  const wrap = $("fab-wrap");
  const main = $("fab-main");
  let open = false;

  main.addEventListener("click", (e) => {
    if (dragMoved) { dragMoved = false; return; }
    open = !open;
    wrap.classList.toggle("open", open);
    main.textContent = open ? "✕" : "🏆";
  });

  $("fab-classifica").addEventListener("click", () => {
    if (!getCode()) return promptCode();
    openLeaderboard(Game.getPublicState().dayOffset ?? currentDayOffset);
  });
  $("fab-ammonizioni").addEventListener("click", () => {
    if (!getCode()) return promptCode();
    openWarnings(Game.getPublicState().dayOffset ?? currentDayOffset);
  });

  // Drag del wrap
  let dragMoved = false, dragging = false, sx = 0, sy = 0, sr = 0, sb = 0;
  const start = (x, y) => {
    dragging = true; dragMoved = false; sx = x; sy = y;
    const r = wrap.getBoundingClientRect();
    sr = window.innerWidth - r.right; sb = window.innerHeight - r.bottom;
  };
  const move = (x, y) => {
    if (!dragging) return;
    const dx = x - sx, dy = y - sy;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) dragMoved = true;
    let nr = Math.max(8, Math.min(window.innerWidth - 62, sr - dx));
    let nb = Math.max(8, Math.min(window.innerHeight - 62, sb - dy));
    wrap.style.right = nr + "px"; wrap.style.bottom = nb + "px";
  };
  const end = () => {
    if (dragging && dragMoved) {
      try {
        const r = wrap.getBoundingClientRect();
        localStorage.setItem("sirius3_fab", JSON.stringify({ right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom }));
      } catch (_) {}
    }
    dragging = false;
  };
  main.addEventListener("touchstart", (e) => { const t = e.touches[0]; start(t.clientX, t.clientY); }, { passive: true });
  main.addEventListener("touchmove", (e) => { if (dragging) { e.preventDefault(); const t = e.touches[0]; move(t.clientX, t.clientY); } }, { passive: false });
  main.addEventListener("touchend", end);
  main.addEventListener("mousedown", (e) => start(e.clientX, e.clientY));
  document.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
  document.addEventListener("mouseup", end);

  try {
    const p = JSON.parse(localStorage.getItem("sirius3_fab") || "null");
    if (p) { wrap.style.right = p.right + "px"; wrap.style.bottom = p.bottom + "px"; }
  } catch (_) {}
}

// =========================================================
//  CODICE INVITO
// =========================================================
function promptCode() {
  $("code-input").value = "";
  openBackdrop($("code-backdrop"));
  setTimeout(() => $("code-input").focus(), 50);
}

function setupCodeModal() {
  const ok = () => {
    const v = norm($("code-input").value);
    if (!nameFor(v)) {
      $("code-error").textContent = "Codice non valido. Controlla maiuscole e trattino.";
      return;
    }
    setCode(v);
    closeBackdrop($("code-backdrop"));
    checkAlreadyPlayed(Game.getPublicState().dayOffset);
  };
  $("code-ok").addEventListener("click", ok);
  $("code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
}

// =========================================================
//  WIRING MODALI
// =========================================================
function setupModals() {
  $("lb-close").addEventListener("click", () => closeBackdrop($("lb-backdrop")));
  $("end-close").addEventListener("click", () => { closeBackdrop($("end-backdrop")); $("treccani-link").parentElement.style.display = ""; });
  $("end-show-lb").addEventListener("click", () => { closeBackdrop($("end-backdrop")); $("treccani-link").parentElement.style.display = ""; openLeaderboard(currentDayOffset); });
  $("warn-close").addEventListener("click", () => closeBackdrop($("warn-backdrop")));
  $("reason-close").addEventListener("click", () => closeBackdrop($("reason-backdrop")));
  $("detail-close").addEventListener("click", () => closeBackdrop($("detail-backdrop")));

  $("lb-tabs").querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentTab = btn.dataset.tab;
      $("lb-tabs").querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      loadTab();
    });
  });

  // Chiudi cliccando sul backdrop nero
  [["lb-backdrop"], ["end-backdrop"], ["warn-backdrop"], ["reason-backdrop"], ["detail-backdrop"]].forEach(([id]) => {
    const bd = $(id);
    bd.addEventListener("click", (e) => { if (e.target === bd) closeBackdrop(bd); });
  });
}

// =========================================================
//  AVVIO
// =========================================================
(async function main() {
  await initFirebase();
  const state = Game.init({ onGameEnd });
  currentDayOffset = state.dayOffset;

  setupFab();
  setupCodeModal();
  setupModals();

  if (!getCode()) {
    promptCode();
  } else {
    checkAlreadyPlayed(state.dayOffset);
  }
})();
