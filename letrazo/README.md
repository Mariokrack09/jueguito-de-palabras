# Letrazo

Juego multijugador de palabras tipo Boggle. Node + Express + Socket.IO.

## Local
    npm install
    npm start        # http://localhost:3000

## Render
1. Sube esta carpeta a un repo de GitHub.
2. En Render: New > Web Service > tu repo (o New > Blueprint, usa render.yaml).
3. Build: `npm install` · Start: `npm start`.

## Diccionario
- Si existe `words.txt` (una palabra por línea) se usa ese.
- Si no, se intenta cargar el paquete npm `an-array-of-spanish-words`.
- Si no hay diccionario, el juego acepta cualquier palabra que se pueda formar en el tablero.

El estado de las partidas vive en memoria: usa una sola instancia.
