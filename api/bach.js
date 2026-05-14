// ═══════════════════════════════════════════════════════════════
// BACH EXPLORER — Fonction serverless (proxy API Anthropic) — v2
// ───────────────────────────────────────────────────────────────
// Chaîne de traitement :
//   1. Si un fichier de cache public/works/bwvXXX.json existe pour
//      la requête, on le sert directement (œuvres longues pré-générées).
//   2. Sinon, appel à l'API Anthropic (Opus 4.7).
//   3. Si le JSON renvoyé est malformé, une seconde requête de
//      réparation est tentée avant d'abandonner.
//
// Endpoint : POST /api/bach   body : { "query": "BWV 140" }
// ═══════════════════════════════════════════════════════════════

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 16000;

// ───────────────────────────────────────────────
// PROMPT SYSTÈME
// ───────────────────────────────────────────────
const SYSTEM_PROMPT = `Tu es un musicologue spécialisé dans l'œuvre vocale et chorale de Jean-Sébastien Bach (cantates sacrées et profanes, Passions, Messes, Magnificat, motets, oratorios).

L'utilisateur te demande une œuvre par son numéro BWV, son titre allemand ou français, ou une occasion liturgique. Tu réponds EXCLUSIVEMENT par un objet JSON valide — aucun texte avant ou après, aucune balise markdown, aucun préambule.

╔═══════════════════════════════════════════════════════╗
║  SCHÉMA JSON ATTENDU                                  ║
╚═══════════════════════════════════════════════════════╝

{
  "work": {
    "bwv": "BWV xxx",
    "titleGerman": "Titre allemand original",
    "titleFrench": "Traduction française du titre",
    "metadata": {
      "date": "Date de composition / création (la plus précise possible)",
      "place": "Lieu (Weimar, Köthen, Leipzig…)",
      "occasion": "Occasion liturgique ou contexte de création",
      "librettist": "Auteur(s) du texte ; préciser les sources (chorals, versets bibliques)",
      "scoring": "Effectif vocal et instrumental détaillé",
      "theological": "Contexte théologique et spirituel : la lecture biblique du jour, le thème dévotionnel, la logique du texte. 2 à 4 phrases.",
      "musical": "Spécificités musicales : forme d'ensemble, tonalité, écriture remarquable, traitement du choral, particularités instrumentales. 2 à 4 phrases.",
      "interpretations": "Interprétations de référence au disque : 2 à 4 versions marquantes (chef, ensemble, époque approximative), avec un mot sur leur parti pris. Privilégier les jalons discographiques reconnus."
    },
    "movements": [
      {
        "number": "1",
        "type": "Chœur | Aria | Récitatif | Choral | Duo | Sinfonia | Arioso…",
        "voice": "Voix concernée(s) — ex. 'Soprano, Basse'",
        "scoring": "Instrumentation du mouvement, brève — ex. 'hautbois d'amore, cordes, continuo'",
        "textGerman": "Texte allemand original complet. Vers séparés par un retour à la ligne simple (\\n). Strophes ou sections séparées par une ligne vide (\\n\\n).",
        "textFrench": "Traduction française complète, fidèle et littéraire. Même découpage en vers et strophes que l'allemand."
      }
    ]
  }
}

╔═══════════════════════════════════════════════════════╗
║  RÈGLES IMPÉRATIVES                                   ║
╚═══════════════════════════════════════════════════════╝

1. JSON STRICTEMENT VALIDE. Toutes les chaînes entre guillemets droits. Tout guillemet droit À L'INTÉRIEUR d'une chaîne doit être échappé (\\"). Les retours à la ligne dans les textes sont encodés \\n. Aucune virgule traînante.

2. FIDÉLITÉ DU TEXTE. Le texte allemand doit être conforme aux éditions de référence (Neue Bach-Ausgabe). Ne jamais paraphraser, moderniser ou inventer. En cas d'incertitude sur un mouvement précis, le signaler dans "musical" plutôt que de combler.

3. TRADUCTION. Française complète, fidèle au sens et au registre liturgique, littéraire sans être un mot-à-mot. Respecter le découpage en vers.

4. DÉCOUPAGE. Vers = \\n simple. Strophe/section = \\n\\n. Ce découpage est essentiel à l'affichage.

5. COMPLÉTUDE. Tous les mouvements, dans l'ordre. Pour les très grandes œuvres, donner autant de mouvements que possible dans l'ordre sans rien omettre au milieu.

6. EN CAS D'ŒUVRE NON IDENTIFIABLE, renvoyer exactement :
   { "error": "Œuvre non identifiée : précisez par numéro BWV ou par titre exact." }
   Ne jamais produire de prose hors du JSON, même pour signaler un problème.

Réponds maintenant uniquement avec le JSON.`;

const REPAIR_PROMPT = `Le texte suivant devait être un objet JSON valide mais ne l'est pas (erreur de syntaxe : guillemet non échappé, virgule traînante, accolade manquante, retour à la ligne non encodé…).

Renvoie UNIQUEMENT le même contenu corrigé en JSON strictement valide — aucun texte avant ou après, aucune balise markdown. Ne modifie pas le fond, corrige seulement la syntaxe. Si le contenu est tronqué, ferme proprement les structures ouvertes en conservant ce qui est exploitable.

TEXTE À RÉPARER :
`;

// ───────────────────────────────────────────────
// UTILITAIRES
// ───────────────────────────────────────────────

// Extrait un identifiant de cache à partir de la requête.
// "BWV 244" / "bwv244" / "244" -> "bwv244"  ; sinon null.
function cacheKeyFromQuery(query) {
  const m = query.toLowerCase().match(/(?:bwv\s*)?(\d{1,3})(?:\.\d+)?/);
  if (!m) return null;
  return "bwv" + m[1];
}

// Tente de lire un fichier de cache. Retourne l'objet parsé ou null.
async function tryCache(query) {
  const key = cacheKeyFromQuery(query);
  if (!key) return null;
  try {
    // Les fichiers de cache sont déposés dans public/works/
    const path = join(process.cwd(), "public", "works", key + ".json");
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (e) {
    // Fichier absent ou illisible : on retombe sur l'appel API.
    return null;
  }
}

// Nettoie une réponse modèle : retire d'éventuelles balises markdown.
function stripFences(text) {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  return t;
}

// Appel générique à l'API Anthropic. Retourne le texte concaténé.
async function callAnthropic(apiKey, { system, messages }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`API Anthropic ${res.status}`);
    err.detail = errText;
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  let text = "";
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === "text" && block.text) text += block.text;
    }
  }
  return text;
}

// ───────────────────────────────────────────────
// HANDLER
// ───────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Méthode non autorisée. Utilisez POST." });
  }

  // Lecture de la requête
  let query = "";
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    query = (body && body.query) ? String(body.query).trim() : "";
  } catch (e) {
    return res.status(400).json({ error: "Requête mal formée." });
  }
  if (!query) {
    return res.status(400).json({ error: "Requête vide." });
  }

  // ── Étape 1 : cache statique ─────────────────────────────────
  const cached = await tryCache(query);
  if (cached) {
    // On marque la provenance pour un éventuel usage côté client.
    if (cached.work) cached.source = "cache";
    return res.status(200).json(cached);
  }

  // ── Étape 2 : appel API ──────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY non configurée.");
    return res.status(500).json({ error: "Configuration serveur incomplète." });
  }

  let rawText;
  try {
    rawText = await callAnthropic(apiKey, {
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: query }],
    });
  } catch (err) {
    console.error("Erreur appel API:", err.status, err.detail || err.message);
    return res.status(502).json({
      error: "Le service de génération est momentanément indisponible. Réessayez dans un instant.",
    });
  }

  if (!rawText || !rawText.trim()) {
    return res.status(502).json({ error: "Réponse vide du service de génération." });
  }

  // ── Étape 3 : parsing, avec réparation si nécessaire ─────────
  let cleaned = stripFences(rawText);
  let parsed = null;

  try {
    parsed = JSON.parse(cleaned);
  } catch (e1) {
    // Première tentative échouée : on demande au modèle de réparer.
    console.warn("JSON malformé, tentative de réparation…");
    try {
      const repaired = await callAnthropic(apiKey, {
        system: "Tu es un réparateur de JSON. Tu renvoies uniquement du JSON valide.",
        messages: [{ role: "user", content: REPAIR_PROMPT + cleaned }],
      });
      parsed = JSON.parse(stripFences(repaired));
      console.warn("Réparation réussie.");
    } catch (e2) {
      console.error("Réparation échouée:", e2.message);
      return res.status(502).json({
        error: "La réponse n'a pas pu être interprétée. Réessayez, ou précisez votre requête.",
      });
    }
  }

  // Validation minimale du contenu
  if (parsed && parsed.error) {
    return res.status(200).json(parsed); // { error: "Œuvre non identifiée…" }
  }
  if (!parsed || !parsed.work) {
    return res.status(502).json({ error: "Réponse incomplète du service de génération." });
  }

  parsed.source = "api";
  return res.status(200).json(parsed);
}
