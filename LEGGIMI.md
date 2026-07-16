# Sirius Parole 3.0 — Guida al deploy

Versione riscritta da zero. Codice pulito, nessun residuo del vecchio gioco.
Stesso database Firebase (parole-siriusv2), stessi codici, stesso storico.

## Cosa c'è di nuovo rispetto alla versione attuale
- Motore di gioco riscritto da zero (niente più popup statistiche o finestre nascoste di Pietropper)
- Grafica pulita: griglia arrotondata, tema scuro, colori Wordle standard
- Bottone flottante espandibile (Classifica + Ammonizioni), trascinabile
- NUOVO: sistema di ammonizioni (vedi sotto)
- Parola del giorno mascherata (non più leggibile con .solution da console)
- Terza tab "Albo d'oro" nella classifica

## File del progetto
- index.html, style.css — pagina e stile
- game.js — motore di gioco
- words.js — liste parole (1524 soluzioni + 7834 accettate)
- leaderboard.js — classifiche, codici, ammonizioni, Treccani
- manifest.json, service-worker.js — PWA installabile
- firestore.rules — regole database (AGGIORNATE: includono le ammonizioni)
- nightly_job.py + .github/workflows/nightly.yml — job notturno skip
- recovery_job.py + .github/workflows/recovery.yml — recupero manuale
- genera-codici.html — utility codici
- images/, fonts/ — logo, icone, font

## SETUP

### 1. Carica i file su SiriusParole3.0
Carica TUTTO il contenuto di questa cartella nella repo (mantieni la cartella
.github/workflows/ con i due file .yml dentro).

### 2. Attiva GitHub Pages
Settings → Pages → Source: "Deploy from a branch" → main → / (root) → Save.
Il sito sarà su https://nikevan.github.io/SiriusParole3.0/

### 3. Aggiorna le regole Firestore
Firebase Console → parole-siriusv2 → Firestore → Rules.
Incolla il contenuto di firestore.rules e Pubblica.
(Sono le stesse di prima PIÙ la sezione ammonizioni.)

### 4. Configura il Secret per i job (se non già presente su questa repo)
Le GitHub Actions dei job hanno bisogno del Secret FIREBASE_SERVICE_ACCOUNT.
Se lo avevi solo sulla vecchia repo, va ricreato qui:
Settings → Secrets and variables → Actions → New repository secret
Nome: FIREBASE_SERVICE_ACCOUNT
Valore: il JSON della service account (lo stesso di prima).

### 5. Testa
Apri il sito, inserisci un codice (es. NICO-UF3Y), gioca.
Verifica: griglia arrotondata, colori giusti, bottone flottante con le due icone.

## LE AMMONIZIONI (nuova funzione)

Come funzionano:
- Ogni persona può ammonire un'altra UNA volta al giorno (si azzera ogni giorno)
- A 5 ammonizioni ricevute nello stesso giorno: +10 punti di penalità (subito)
- Sotto le 5, chi ha ammonito può RITIRARE la propria ammonizione
- A quota 5 la penalità è definitiva e le ammonizioni si "congelano"
- Cartellino accanto al nome: giallo con numero (1-4), rosso con 5
- Cliccando il cartellino si vede chi ha ammonito e perché
- Motivi: Comportamento scorretto, Ha barato, Ha sentito la parola, Ha visto la parola da qualcuno

Come si usa: bottone flottante → icona triangolo "Ammonizioni" → lista persone →
"Ammonisci" → scegli il motivo. Per ritirare: stesso posto, "Ritira".

## Note importanti
- La parola del giorno è IDENTICA alla versione attuale (stesso offset), quindi
  chi gioca sul vecchio e sul nuovo trova la stessa parola. Fai il cambio quando
  vuoi che tutti passino al nuovo.
- Il database è lo stesso: punteggi, classifiche e albo d'oro esistenti restano.
- Il bot Telegram per le ammonizioni NON è incluso: lo faremo come passo separato.

## Quando fare il cambio
Quando il nuovo è testato e ti soddisfa, puoi:
- puntare i colleghi al nuovo URL (SiriusParole3.0), oppure
- sostituire i file nella repo principale con questi.
Idealmente all'inizio di un mese, per far partire la classifica mensile pulita
sulla nuova versione.
