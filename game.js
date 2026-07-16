// ====== SIRIUS PAROLE 3.0 — Motore di gioco ======
// Riscritto da zero. Nessun residuo del vecchio codice.
// Comportamento: Wordle classico a 5 lettere, 6 tentativi, una parola al giorno.

import { SOLUTIONS, ACCEPTED } from "./words.js";

// ---- Config ----
const WORD_LENGTH = 5;
const MAX_ROWS = 6;
// Data di partenza: DEVE combaciare con START_DATE del job (31 maggio 2021).
// Nota: mese 0-based in JS -> 4 = maggio.
const START_DATE = new Date(2021, 4, 31, 0, 0, 0, 0);

// ---- Stato del gioco (chiuso in modulo: non accessibile da console) ----
// La soluzione NON viene esposta su window o su proprietà pubbliche leggibili.
let _solution = "";
let _dayOffset = 0;
let currentRow = 0;
let currentCol = 0;
let board = [];              // board[r][c] = lettera
let evaluations = [];        // evaluations[r][c] = "correct" | "present" | "absent"
let status = "playing";      // "playing" | "won" | "lost"
let locked = false;          // blocca input (partita finita o gia' giocata)

// Callback verso l'esterno (leaderboard) a fine partita
let onGameEnd = null;

// Stato tastiera: lettera -> miglior esito raggiunto
const keyState = {};

// ---- Calcolo giorno e soluzione ----
function computeDayOffset(date = new Date()) {
  const today = new Date(date);
  today.setHours(0, 0, 0, 0);
  const start = new Date(START_DATE);
  start.setHours(0, 0, 0, 0);
  const diff = today.getTime() - start.getTime();
  return Math.floor(diff / 86400000);
}

function solutionForOffset(offset) {
  const idx = ((offset % SOLUTIONS.length) + SOLUTIONS.length) % SOLUTIONS.length;
  return SOLUTIONS[idx];
}

// ---- Persistenza locale della partita del giorno ----
function storageKey(offset) {
  return `sirius3_game_${offset}`;
}

function saveState() {
  try {
    const data = { board, evaluations, currentRow, status, dayOffset: _dayOffset };
    localStorage.setItem(storageKey(_dayOffset), JSON.stringify(data));
  } catch (_) {}
}

function loadState(offset) {
  try {
    const raw = localStorage.getItem(storageKey(offset));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.dayOffset !== offset) return null;
    return data;
  } catch (_) {
    return null;
  }
}

// ---- Valutazione di un tentativo (algoritmo Wordle con doppioni corretti) ----
function evaluateGuess(guess, solution) {
  const result = new Array(WORD_LENGTH).fill("absent");
  const solChars = solution.split("");
  const used = new Array(WORD_LENGTH).fill(false);

  // Prima passata: lettere giuste al posto giusto
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guess[i] === solChars[i]) {
      result[i] = "correct";
      used[i] = true;
    }
  }
  // Seconda passata: lettere presenti ma in posizione sbagliata
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (result[i] === "correct") continue;
    for (let j = 0; j < WORD_LENGTH; j++) {
      if (!used[j] && guess[i] === solChars[j]) {
        result[i] = "present";
        used[j] = true;
        break;
      }
    }
  }
  return result;
}

// ---- Rendering griglia ----
const boardEl = () => document.getElementById("board");

function buildBoard() {
  const el = boardEl();
  el.innerHTML = "";
  for (let r = 0; r < MAX_ROWS; r++) {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.row = r;
    for (let c = 0; c < WORD_LENGTH; c++) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.row = r;
      tile.dataset.col = c;
      row.appendChild(tile);
    }
    el.appendChild(row);
  }
}

function renderTile(r, c) {
  const tile = boardEl().querySelector(`.tile[data-row="${r}"][data-col="${c}"]`);
  if (!tile) return;
  const letter = board[r] && board[r][c] ? board[r][c] : "";
  tile.textContent = letter.toUpperCase();
  tile.classList.toggle("filled", !!letter);
  const evalState = evaluations[r] && evaluations[r][c];
  tile.classList.remove("correct", "present", "absent");
  if (evalState) tile.classList.add(evalState);
}

function renderAll() {
  for (let r = 0; r < MAX_ROWS; r++) {
    for (let c = 0; c < WORD_LENGTH; c++) renderTile(r, c);
  }
  renderKeyboard();
}

// ---- Rendering tastiera ----
const KB_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

function buildKeyboard() {
  const kb = document.getElementById("keyboard");
  kb.innerHTML = "";
  KB_ROWS.forEach((rowStr, idx) => {
    const row = document.createElement("div");
    row.className = "kb-row";
    if (idx === 2) {
      row.appendChild(makeKey("invio", "INVIO", true));
    }
    rowStr.split("").forEach((ch) => row.appendChild(makeKey(ch, ch.toUpperCase(), false)));
    if (idx === 2) {
      row.appendChild(makeKey("canc", "⌫", true));
    }
    kb.appendChild(row);
  });
}

function makeKey(key, label, wide) {
  const b = document.createElement("button");
  b.className = "key" + (wide ? " key-wide" : "");
  b.textContent = label;
  b.dataset.key = key;
  b.type = "button";
  b.addEventListener("click", () => handleKey(key));
  return b;
}

function renderKeyboard() {
  document.querySelectorAll("#keyboard .key").forEach((b) => {
    const k = b.dataset.key;
    b.classList.remove("correct", "present", "absent");
    if (keyState[k]) b.classList.add(keyState[k]);
  });
}

function updateKeyState(guess, result) {
  const rank = { absent: 0, present: 1, correct: 2 };
  for (let i = 0; i < WORD_LENGTH; i++) {
    const ch = guess[i];
    const nw = result[i];
    if (!keyState[ch] || rank[nw] > rank[keyState[ch]]) {
      keyState[ch] = nw;
    }
  }
}

// ---- Toast messaggi ----
let toastTimer = null;
function toast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
}

// ---- Gestione input ----
function handleKey(key) {
  if (locked || status !== "playing") return;
  if (key === "invio") return submitGuess();
  if (key === "canc") return deleteLetter();
  if (/^[a-z]$/.test(key)) return addLetter(key);
}

function addLetter(ch) {
  if (currentCol >= WORD_LENGTH) return;
  if (!board[currentRow]) board[currentRow] = [];
  board[currentRow][currentCol] = ch;
  renderTile(currentRow, currentCol);
  const tile = boardEl().querySelector(`.tile[data-row="${currentRow}"][data-col="${currentCol}"]`);
  if (tile) { tile.classList.remove("pop"); void tile.offsetWidth; tile.classList.add("pop"); }
  currentCol++;
}

function deleteLetter() {
  if (currentCol <= 0) return;
  currentCol--;
  board[currentRow][currentCol] = "";
  renderTile(currentRow, currentCol);
}

function submitGuess() {
  if (currentCol < WORD_LENGTH) {
    toast("Parola troppo corta");
    shakeRow();
    return;
  }
  const guess = board[currentRow].join("");
  if (!ACCEPTED.has(guess)) {
    toast("Parola non valida");
    shakeRow();
    return;
  }
  const result = evaluateGuess(guess, _solution);
  evaluations[currentRow] = result;
  updateKeyState(guess, result);

  const isWin = guess === _solution;
  const rowToWin = currentRow;

  if (isWin) {
    // VITTORIA: prima vibrazione (suspense), poi giro verde, poi coriandoli.
    // Le lettere NON rivelano subito il colore: restano ferme e vibrano.
    status = "won";
    locked = true;
    saveState();
    winSequence(rowToWin, result, () => {
      renderKeyboard();
      toast("Bravo!");
      finishGame();
    });
    return;
  }

  // Riga non vincente: rivelazione normale (giro che mostra i colori)
  revealRow(currentRow, result, () => {
    renderKeyboard();
    if (currentRow >= MAX_ROWS - 1) {
      status = "lost";
      locked = true;
      saveState();
      finishGame();
    } else {
      currentRow++;
      currentCol = 0;
      saveState();
    }
  });
}

// Ritmo tranquillo: flip un pochino piu' lento
const FLIP_STEP = 290;   // ritardo tra una lettera e l'altra
const FLIP_HALF = 250;   // meta' giro, applica il colore

function revealRow(r, result, done) {
  const tiles = [];
  for (let c = 0; c < WORD_LENGTH; c++) {
    tiles.push(boardEl().querySelector(`.tile[data-row="${r}"][data-col="${c}"]`));
  }
  tiles.forEach((tile, c) => {
    setTimeout(() => {
      tile.classList.add("flip");
      setTimeout(() => {
        tile.classList.remove("correct", "present", "absent");
        tile.classList.add(result[c]);
      }, FLIP_HALF);
      if (c === WORD_LENGTH - 1) setTimeout(done, 500);
    }, c * FLIP_STEP);
  });
}

// ---- Coreografia di vittoria: vibrazione 3s -> giro verde -> coriandoli ----
function winSequence(r, result, done) {
  const tiles = [];
  for (let c = 0; c < WORD_LENGTH; c++) {
    tiles.push(boardEl().querySelector(`.tile[data-row="${r}"][data-col="${c}"]`));
  }
  // 1) Vibrazione crescente per 3 secondi (lettere ancora non rivelate)
  tiles.forEach((t) => t && t.classList.add("vibrate-win"));
  setTimeout(() => {
    tiles.forEach((t) => t && t.classList.remove("vibrate-win"));
    // 2) Giro che rivela il verde, una lettera alla volta
    revealRow(r, result, () => {
      // 3) Coriandoli
      launchConfetti();
      setTimeout(done, 2600);
    });
  }, 1500);
}

// ---- Coriandoli (canvas leggero, nessuna libreria) ----
function launchConfetti() {
  // Vibrazione del telefono (Android). Su iPhone l'API non è supportata: viene ignorata senza errori.
  try {
    if (navigator.vibrate) navigator.vibrate([0, 90, 60, 90, 60, 160]);
  } catch (_) {}
  const old = document.getElementById("confetti-canvas");
  if (old) old.remove();
  const canvas = document.createElement("canvas");
  canvas.id = "confetti-canvas";
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2000;";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const W = canvas.width = window.innerWidth;
  const H = canvas.height = window.innerHeight;
  const colors = ["#6aaa64", "#c9b458", "#85c0f9", "#f5793a", "#ffffff"];
  const parts = [];
  for (let i = 0; i < 130; i++) {
    parts.push({
      x: Math.random() * W,
      y: -20 - Math.random() * H * 0.3,
      vx: (Math.random() - 0.5) * 3,
      vy: 3 + Math.random() * 4,
      size: 5 + Math.random() * 6,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
    });
  }
  const startT = Date.now();
  const DURATION = 2600;
  function frame() {
    const elapsed = Date.now() - startT;
    ctx.clearRect(0, 0, W, H);
    parts.forEach((p) => {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vy += 0.04;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, 1 - elapsed / DURATION);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    });
    if (elapsed < DURATION) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}

function shakeRow() {
  const row = boardEl().querySelector(`.row[data-row="${currentRow}"]`);
  if (!row) return;
  row.classList.remove("shake");
  void row.offsetWidth;
  row.classList.add("shake");
}

// ---- Fine partita ----
function finishGame() {
  const attempts = status === "won" ? currentRow + 1 : 7;
  if (typeof onGameEnd === "function") {
    onGameEnd({
      status,
      attempts,           // 1..6 se vinto, 7 se perso
      solution: _solution,
      dayOffset: _dayOffset,
    });
  }
}

// ---- API pubblica del motore (per leaderboard.js) ----
export const Game = {
  init(opts = {}) {
    onGameEnd = opts.onGameEnd || null;
    _dayOffset = computeDayOffset();
    _solution = solutionForOffset(_dayOffset);

    board = Array.from({ length: MAX_ROWS }, () => new Array(WORD_LENGTH).fill(""));
    evaluations = Array.from({ length: MAX_ROWS }, () => new Array(WORD_LENGTH).fill(null));
    currentRow = 0;
    currentCol = 0;
    status = "playing";
    locked = false;

    buildBoard();
    buildKeyboard();

    // Ripristina partita del giorno se gia' iniziata
    const saved = loadState(_dayOffset);
    if (saved) {
      board = saved.board;
      evaluations = saved.evaluations;
      currentRow = saved.currentRow;
      status = saved.status;
      // Ricostruisci lo stato tastiera
      for (let r = 0; r < currentRow + 1; r++) {
        if (board[r] && evaluations[r] && evaluations[r][0]) {
          updateKeyState(board[r].join(""), evaluations[r]);
        }
      }
      if (status !== "playing") locked = true;
    }
    renderAll();

    // Input da tastiera fisica
    document.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Ignora se c'è un modale aperto (es. inserimento codice) o se si scrive in un input
      if (document.querySelector(".backdrop.show")) return;
      const tag = (e.target && e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || (e.target && e.target.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "enter") return handleKey("invio");
      if (k === "backspace") return handleKey("canc");
      if (/^[a-z]$/.test(k)) return handleKey(k);
    });

    return { dayOffset: _dayOffset, alreadyFinished: status !== "playing", status };
  },

  // Blocca il gioco (usato da leaderboard se "hai gia' giocato oggi" via server)
  lock() {
    locked = true;
  },

  // Info sicure da esporre (NON la soluzione, salvo a partita finita)
  getPublicState() {
    return {
      dayOffset: _dayOffset,
      status,
      attempts: status === "won" ? currentRow + 1 : status === "lost" ? 7 : null,
      // la soluzione la diamo solo se la partita è finita
      solution: status === "playing" ? null : _solution,
    };
  },

  // Solo per il leaderboard, a fine partita, per il link Treccani
  getSolutionIfFinished() {
    return status === "playing" ? null : _solution;
  },
};
