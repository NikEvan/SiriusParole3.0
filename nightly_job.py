#!/usr/bin/env python3
"""
Sirius Parole - Job notturno (eseguito da GitHub Actions ogni notte).

Per ogni codice in leaderboard.js:
  - se NON ha giocato IERI, assegna 7 tentativi con status "skipped"
    (uniforme con la sconfitta: chi non gioca = chi gioca e perde) e aggiorna il
    totale mensile.

Inoltre, ogni notte aggiorna l'albo d'oro (winners/{YYYY-MM}) con il leader del
mese di ieri. Quando ieri è l'ultimo giorno del mese, il vincitore viene marcato
come definitivo (final=True): è quello che resta nello storico dopo l'azzeramento.
"""
import json
import os
import re
import sys
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import firebase_admin
from firebase_admin import credentials, firestore

# ====== Config ======
START_DATE = date(2021, 5, 31)  # = new Date(2021, 4, 31) in wordle-it.js (mese 0-based)
LEADERBOARD_JS_PATH = "leaderboard.js"
SKIP_ATTEMPTS = 7  # tentativi per i giorni non giocati (uniforme con la sconfitta)
ROME = ZoneInfo("Europe/Rome")
DEFAULT_SINCE = "2021-05-31"  # veterani senza "since" esplicito -> nessun backfill
# Data di inizio stagione: deve combaciare con SEASON_START in leaderboard.js.
# I mesi PRIMA di questo (pre-season) non producono un vincitore nell'albo d'oro.
SEASON_START = date(2026, 7, 1)


def get_yesterday_day_offset():
    """Calcola dayOffset di IERI in ora italiana (gestisce automaticamente l'ora legale)."""
    italian_today = datetime.now(ROME).date()
    yesterday = italian_today - timedelta(days=1)
    diff = (yesterday - START_DATE).days
    return diff, yesterday


def parse_invite_codes(js_path):
    """Estrae i codici da leaderboard.js: ritorna {CODE: {"name": str, "since": str}}.

    Supporta sia la nuova forma:
        "CODE": { name: "Nome", since: "YYYY-MM-DD" }
    sia la vecchia:
        "CODE": "Nome"
    """
    with open(js_path, encoding="utf-8") as f:
        content = f.read()
    m = re.search(r"const\s+INVITE_CODES\s*=\s*\{(.*?)\n\};", content, re.DOTALL)
    if not m:
        # fallback: primo blocco { ... }
        m = re.search(r"const\s+INVITE_CODES\s*=\s*\{([^}]*\}?[^}]*)\}", content, re.DOTALL)
    if not m:
        raise RuntimeError("INVITE_CODES non trovato in leaderboard.js")
    body = m.group(1)

    codes = {}
    # Forma a oggetto: "CODE": { name: "Nome", since: "YYYY-MM-DD" }
    obj_re = re.compile(
        r'["“”]([^"“”]+)["“”]\s*:\s*\{[^}]*?'
        r'name\s*:\s*["“”]([^"“”]+)["“”]'
        r'(?:[^}]*?since\s*:\s*["“”]([^"“”]+)["“”])?[^}]*?\}',
        re.DOTALL,
    )
    for code, name, since in obj_re.findall(body):
        codes[code.strip().upper()] = {"name": name.strip(), "since": (since or DEFAULT_SINCE).strip()}

    # Forma a stringa: "CODE": "Nome"  (solo per codici non già presi sopra)
    str_re = re.compile(
        r'["“”]([^"“”]+)["“”]\s*:\s*'
        r'["“”]([^"“”]+)["“”]'
    )
    for code, name in str_re.findall(body):
        key = code.strip().upper()
        if key not in codes:
            codes[key] = {"name": name.strip(), "since": DEFAULT_SINCE}

    return codes


def get_month_key(d):
    return f"{d.year:04d}-{d.month:02d}"


def month_backfill_attempts(month_key, since_str):
    """7 tentativi per ogni giorno del mese (dall'inizio gara) precedente all'ingresso.
    Identico a monthBackfillAttempts() in leaderboard.js."""
    if not since_str:
        return 0
    try:
        sy, sm, sd = [int(x) for x in since_str.split("-")]
        since = date(sy, sm, sd)
    except Exception:
        return 0
    y, m = [int(x) for x in month_key.split("-")]
    month_start = date(y, m, 1)
    next_month = date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)
    # Si conteggiano solo i giorni DOPO l'inizio gara (no giorni "vuoti" pre-lancio).
    start_ref = max(SEASON_START, month_start)
    if since <= start_ref:
        return 0
    if since >= next_month:
        return 0
    return (since - start_ref).days * SKIP_ATTEMPTS


def is_last_day_of_month(d):
    return (d + timedelta(days=1)).month != d.month


def update_hall_of_fame(db, month_key, codes, is_final):
    """Calcola il leader del mese (con backfill, stesso ordinamento del client) e lo
    salva in winners/{month_key}. final=True quando il mese è concluso."""
    players_col = db.collection("monthly").document(month_key).collection("players")
    items = []
    for d in players_col.stream():
        data = d.to_dict() or {}
        since = codes.get(d.id, {}).get("since") if codes.get(d.id) else None
        backfill = month_backfill_attempts(month_key, since)
        items.append({
            "code": d.id,
            "name": data.get("name", "Anon"),
            "displayAttempts": (data.get("totalAttempts", 0) or 0) + backfill,
            "wins": data.get("wins", 0) or 0,
            "games": data.get("games", 0) or 0,
        })
    if not items:
        print("  (nessun giocatore nel mese: nessun vincitore da salvare)")
        return

    # Ordinamento: displayAttempts ASC, wins DESC, games DESC, nome ASC
    items.sort(key=lambda it: (it["displayAttempts"], -it["wins"], -it["games"], str(it["name"]).lower()))
    winner = items[0]

    db.collection("winners").document(month_key).set({
        "name": winner["name"],
        "code": winner["code"],
        "totalAttempts": winner["displayAttempts"],
        "wins": winner["wins"],
        "games": winner["games"],
        "final": bool(is_final),
        "updatedTs": firestore.SERVER_TIMESTAMP,
    })
    print(f"  🏆 Albo d'oro {month_key}: {winner['name']} ({winner['displayAttempts']} tentativi) "
          f"[final={is_final}]")


def main():
    # Init Firebase con service account
    sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if not sa_json:
        print("ERRORE: variabile FIREBASE_SERVICE_ACCOUNT non impostata", file=sys.stderr)
        sys.exit(1)
    try:
        sa_dict = json.loads(sa_json)
    except json.JSONDecodeError as e:
        print(f"ERRORE: FIREBASE_SERVICE_ACCOUNT non è JSON valido: {e}", file=sys.stderr)
        sys.exit(1)
    cred = credentials.Certificate(sa_dict)
    firebase_admin.initialize_app(cred)
    db = firestore.client()

    # Calcola dayOffset di ieri (ora italiana)
    yesterday_offset, yesterday_date = get_yesterday_day_offset()
    month_key = get_month_key(yesterday_date)
    print(f"Processo ieri: data={yesterday_date}, dayOffset={yesterday_offset}, mese={month_key}")

    # Parse codici invito
    codes = parse_invite_codes(LEADERBOARD_JS_PATH)
    print(f"Codici trovati: {len(codes)}")

    # Per ogni codice, controlla se ha giocato ieri
    scores_col = db.collection("leaderboards").document(str(yesterday_offset)).collection("scores")
    existing = {d.id for d in scores_col.stream()}
    print(f"Hanno giocato ieri: {len(existing)} su {len(codes)}")

    missing = [(code, meta) for code, meta in codes.items() if code not in existing]
    print(f"Da segnare come 'skipped': {len(missing)}")

    # Per ognuno: scrivi punteggio "skipped" daily + aggiorna monthly (increment atomico)
    for code, meta in missing:
        name = meta["name"]
        print(f"  → {code} ({name})")
        # Daily: 7 tentativi, status="skipped" (NON appare in classifica giornaliera lato
        # client perché lì filtriamo gli "skipped")
        scores_col.document(code).set({
            "name": name,
            "attempts": SKIP_ATTEMPTS,
            "status": "skipped",
            "ts": firestore.SERVER_TIMESTAMP,
        })

        # Monthly: incrementa solo i tentativi (NON le partite: games conta solo i giorni
        # realmente giocati). wins invariato.
        monthly_ref = db.collection("monthly").document(month_key).collection("players").document(code)
        monthly_ref.set({
            "name": name,
            "totalAttempts": firestore.Increment(SKIP_ATTEMPTS),
            "lastTs": firestore.SERVER_TIMESTAMP,
        }, merge=True)

    if not missing:
        print("Tutti hanno giocato ieri, nessuno skip da registrare.")

    # Albo d'oro: aggiorna il leader del mese di ieri (definitivo se il mese è concluso).
    # I mesi di pre-season (precedenti all'inizio stagione) non producono un vincitore.
    season_month_key = get_month_key(SEASON_START)
    if month_key >= season_month_key:
        update_hall_of_fame(db, month_key, codes, is_final=is_last_day_of_month(yesterday_date))
    else:
        print(f"  (pre-season {month_key}: nessun vincitore registrato nell'albo d'oro)")

    print(f"\n✅ Completato. {len(missing)} skip registrati per {yesterday_date}.")


if __name__ == "__main__":
    main()
