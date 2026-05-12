# Bach Explorer

Explorateur interactif des œuvres chorales de Jean-Sébastien Bach
(cantates, Passions, Messes, Motets, Oratorios) — pensé pour la
consultation en concert sur iPhone.

## Architecture

- **`public/`** : front statique (HTML, CSS, JS vanilla)
- **`api/bach.js`** : fonction serverless Vercel servant de proxy
  vers l'API Anthropic. La clé API n'est jamais exposée côté client.

## Configuration

Variable d'environnement requise sur Vercel :

- `ANTHROPIC_API_KEY` : clé API Anthropic (format `sk-ant-api03-…`)

## Usage

Recherche par numéro BWV, par titre allemand ou français, ou par
occasion liturgique via le calendrier.

Affichage bilingue allemand / français côte à côte, optimisé pour
la lecture en pénombre.
