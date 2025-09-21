# Bombs
Tap on the bombs to defuse them
# Bombe — prototipo MVP

Progetto di prototipo per il gioco di riflessi "Bombe".  
Questo repository contiene un MVP frontend (HTML/CSS/JS) che implementa le meccaniche base:
- Bombe appaiono in posizioni casuali.
- Ogni bomba ha un valore (numero di tocchi richiesti).
- Click/tap decrementa il valore; a 0 la bomba si disinnesca (si rimpicciolisce) e rilascia possibili bonus.
- Se il timer di una bomba scade, esplode: effetto visivo/sonoro e penalità (dimezzamento punteggio salvo scudo).
- Ogni livello ha un tempo fisso (configurabile) e un obiettivo (formula lineare R(L) = R0 + deltaR*(L-1)).
- HUD: punteggio, timer, contatore disinnescate/obiettivo.

## Struttura
