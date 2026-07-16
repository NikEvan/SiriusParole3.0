#!/usr/bin/env python3
"""
Sirius Parole - RECUPERO one-shot dei giorni passati.

Assegna gli skip (7 tentativi, status "skipped") a chi NON ha giocato nei giorni
di un intervallo, SOLO dove manca il punteggio. Non tocca chi ha gia' un documento
per quel giorno (ne' partite reali, ne' skip gia' scritti, ne' correzioni manuali).

REGOLA ANTI-DOPPIONI: per ogni (giorno, codice), se il documento
leaderboards/{day}/scores/{code} esiste gia' -> SALTA. Quindi lanciarlo due volte
non crea duplicati.

Intervallo controllato dalle variabili d'ambiente:
  RECOVERY_START_OFFSET (default 1857 = 1 luglio 2026)
  RECOVERY_END_OFFSET   (default 1867 = 11 luglio 2026)
"""
import json
import os
import re
import sys
from datetime import date, timedelta

import firebase_admin
from firebase_admin import credentials, firestore

# ====== Config ======
START_DATE = date(2021, 5, 31)
LEADERBOARD_JS_PATH = "leaderboard.js"
SKIP_ATTEMPTS = 7
DEFAULT_SINCE = "2021-05-31"

# Intervallo giorni da recuperare (inclusivo). Default: 1-11 luglio 2026.
RECOVERY_START_OFFSET = int(os.environ.get("RECOVERY_START_OFFSET", "1857"))
RECOVERY_END_OFFSET = int(os.environ.get("RECOVERY_END_OFFSET", "1867"))


def parse_invite_codes(js_path):
    with open(js_path, encoding="utf-8") as f:
        content = f.read()
    m = re.search(r"const\s+INVITE_CODES\s*=\s*\{(.*?)\n\s*\};", content, re.DOTALL)
    if not m:
        m = re.search(r"const\s+INVITE_CODES\s*=\s*\{(.*)\n\s*\};", content, re.DOTALL)
    if not m:
        raise RuntimeError("INVITE_CODES non trovato in leaderboard.js")
    body = m.group(1)

    codes = {}
    obj_re = re.compile(
        r'["“”]([^"“”]+)["“”]\s*:\s*\{[^}]*?'
        r'name\s*:\s*["“”]([^"“”]+)["“”]'
        r'(?:[^}]*?since\s*:\s*["“”]([^"“”]+)["“”])?[^}]*?\}',
        re.DOTALL,
    )
    for code, name, since in obj_re.findall(body):
        codes[code.strip().upper()] = {"name": name.strip(), "since": (since or DEFAULT_SINCE).strip()}

    str_re = re.compile(r'["“”]([^"“”]+)["“”]\s*:\s*["“”]([^"“”]+)["“”]')
    for code, name in str_re.findall(body):
        key = code.strip().upper()
        if key not in codes:
            codes[key] = {"name": name.strip(), "since": DEFAULT_SINCE}
    return codes


def offset_to_date(offset):
    return START_DATE + timedelta(days=offset)


def get_month_key(d):
    return f"{d.year:04d}-{d.month:02d}"


def main():
    sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if not sa_json:
        print("ERRORE: FIREBASE_SERVICE_ACCOUNT non impostata", file=sys.stderr)
        sys.exit(1)
    cred = credentials.Certificate(json.loads(sa_json))
    firebase_admin.initialize_app(cred)
    db = firestore.client()

    codes = parse_invite_codes(LEADERBOARD_JS_PATH)
    print(f"Codici trovati: {len(codes)}")
    print(f"Intervallo recupero: offset {RECOVERY_START_OFFSET} -> {RECOVERY_END_OFFSET}")
    print(f"  = date {offset_to_date(RECOVERY_START_OFFSET)} -> {offset_to_date(RECOVERY_END_OFFSET)}")
    print("")

    # Accumuliamo gli incrementi mensili per codice, per fare una sola scrittura finale
    monthly_add = {}  # {(month_key, code): {"attempts": N}}
    total_skips_added = 0

    for offset in range(RECOVERY_START_OFFSET, RECOVERY_END_OFFSET + 1):
        d = offset_to_date(offset)
        month_key = get_month_key(d)
        scores_col = db.collection("leaderboards").document(str(offset)).collection("scores")
        existing = {doc.id for doc in scores_col.stream()}

        missing = [code for code in codes if code not in existing]
        print(f"Giorno {d} (offset {offset}): {len(existing)} presenti, {len(missing)} mancanti")

        for code in missing:
            name = codes[code]["name"]
            # Scrive lo skip del giorno
            scores_col.document(code).set({
                "name": name,
                "attempts": SKIP_ATTEMPTS,
                "status": "skipped",
                "ts": firestore.SERVER_TIMESTAMP,
            })
            key = (month_key, code)
            monthly_add.setdefault(key, {"attempts": 0, "name": name})
            monthly_add[key]["attempts"] += SKIP_ATTEMPTS
            total_skips_added += 1

    print("")
    print(f"Skip totali aggiunti: {total_skips_added}")
    print("Aggiorno i totali mensili...")

    # Applichiamo gli incrementi mensili (una scrittura per codice/mese)
    for (month_key, code), info in monthly_add.items():
        monthly_ref = db.collection("monthly").document(month_key).collection("players").document(code)
        snap = monthly_ref.get()
        if snap.exists:
            prev = snap.to_dict()
        else:
            prev = {"name": info["name"], "totalAttempts": 0, "games": 0, "wins": 0}
        monthly_ref.set({
            "name": info["name"],
            "totalAttempts": (prev.get("totalAttempts", 0) or 0) + info["attempts"],
            "games": prev.get("games", 0) or 0,   # NON incrementiamo games per gli skip
            "wins": prev.get("wins", 0) or 0,
            "lastTs": firestore.SERVER_TIMESTAMP,
        }, merge=True)
        print(f"  {code} ({info['name']}): +{info['attempts']} -> tot {(prev.get('totalAttempts',0) or 0) + info['attempts']}")

    print("")
    print(f"✅ Recupero completato. {total_skips_added} skip aggiunti, {len(monthly_add)} totali mensili aggiornati.")


if __name__ == "__main__":
    main()
