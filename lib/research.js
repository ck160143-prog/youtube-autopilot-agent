"use strict";

// Research stage: turn a topic into a short, source-backed brief that the story
// writer must stay faithful to.
//
// Design decisions that matter for honesty:
//   1. Only URLs the model actually returned are kept. Nothing is invented, and
//      a claim without a source keeps `sources: []` rather than a fake link.
//   2. A source URL is only accepted when an allowlist of reference domains
//      matches (Wikipedia/Wikidata/Britannica and similar reference sites), so a
//      hallucinated or promotional link cannot be presented as a reference.
//   3. The research step never touches the network itself: it is one text
//      generation call, so it costs nothing and needs no scraping permission.

const MAX_CLAIMS = 12;
const MAX_SOURCES = 8;

// Reference domains that are safe to surface as citations. Deliberately small:
// a general web search would need scraping and licensing decisions, so this
// stays inside openly readable reference material.
const TRUSTED_DOMAINS = [
  "wikipedia.org",
  "wikidata.org",
  "britannica.com",
  "nasa.gov",
  "isro.gov.in",
  "who.int",
  "un.org",
  "unesco.org",
  "worldbank.org",
  "nationalgeographic.com",
  "nie.gov.in",
  "ncert.nic.in",
];

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

function isTrustedUrl(url) {
  const host = hostOf(url);
  if (!host) return false;
  return TRUSTED_DOMAINS.some(domain => host === domain || host.endsWith("." + domain));
}

// Keeps only http(s) links on trusted reference domains, de-duplicated, capped.
function normalizeSources(sources) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(sources) ? sources : []) {
    const raw = typeof item === "string" ? { url: item } : (item || {});
    const url = String(raw.url || "").trim();
    if (!/^https?:\/\//i.test(url) || !isTrustedUrl(url)) continue;
    const key = url.replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url,
      title: String(raw.title || "").slice(0, 160),
      publisher: String(raw.publisher || hostOf(url)).slice(0, 80),
    });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

function clip(value, max) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

// Normalises the model's JSON into a brief the rest of the app can rely on.
// sourceIds that do not resolve to a kept source are dropped, so a claim can
// never point at a link that was filtered out.
function normalizeBrief(parsed, options = {}) {
  const topic = clip(parsed && parsed.topic, 200) || clip(options.topic, 200);
  const sources = normalizeSources(parsed && parsed.sources);
  const byId = new Map(sources.map((source, index) => [String(index + 1), source]));

  const claims = [];
  for (const raw of Array.isArray(parsed && parsed.claims) ? parsed.claims : []) {
    const fact = clip(raw && raw.fact, 300);
    if (!fact) continue;
    const ids = Array.isArray(raw.sourceIds) ? raw.sourceIds.map(String) : [];
    const linked = ids.map(id => byId.get(id)).filter(Boolean).map(s => s.url);
    claims.push({ fact, sourceUrls: Array.from(new Set(linked)) });
    if (claims.length >= MAX_CLAIMS) break;
  }

  return {
    topic,
    summary: clip(parsed && parsed.summary, 1200),
    language: options.language === "English" ? "English" : "हिंदी",
    claims,
    sources,
    // Stated on the object so the UI cannot present an unbacked brief as sourced.
    sourcedClaims: claims.filter(c => c.sourceUrls.length > 0).length,
    researchAt: new Date().toISOString(),
    notice: sources.length
      ? "स्रोत केवल भरोसेमंद संदर्भ साइटों से रखे गए हैं; जिन तथ्यों का लिंक नहीं मिला उन्हें बिना स्रोत के रखा गया है।"
      : "इस शोध में कोई भरोसेमंद स्रोत लिंक नहीं मिला — तथ्यों को सत्यापित न मानें।",
  };
}

function buildResearchPrompt({ topic, language, audience }) {
  const lang = language === "English" ? "English" : "Hindi (Devanagari)";
  return [
    "You are a careful research assistant for a children's educational YouTube channel.",
    "",
    "Topic: " + topic,
    audience ? "Audience: " + audience : "Audience: children aged 6-12 in India",
    "Output language: " + lang,
    "",
    "Rules:",
    "1. Only state facts you are confident are accurate. Never invent numbers, dates or names.",
    "2. Every claim must reference one or more sources by their numeric id.",
    "3. Sources must be real, openly readable reference pages (encyclopaedia, government, science bodies).",
    "   No blog spam, no shopping links, no shortened URLs, no invented URLs.",
    "4. If you cannot support a claim with a real source, leave its sourceIds empty rather than guessing.",
    "5. Prefer 5-8 short, checkable claims over many vague ones.",
    "6. Do not write the story here — this is only the factual brief.",
    "",
    "Return ONLY valid JSON, no markdown fences:",
    '{"topic":"string","summary":"2-3 sentences",' +
      '"claims":[{"fact":"one checkable statement","sourceIds":["1"]}],' +
      '"sources":[{"id":"1","title":"page title","url":"https://...","publisher":"site name"}]}',
  ].filter(Boolean).join("\n");
}

// The brief is injected into the story prompt so the writer stays factual.
function researchContextForPrompt(brief) {
  if (!brief) return "";
  const lines = ["", "VERIFIED RESEARCH BRIEF (stay faithful, do not contradict):"];
  if (brief.summary) lines.push("Summary: " + brief.summary);
  for (const claim of (brief.claims || []).slice(0, MAX_CLAIMS)) {
    lines.push("- " + claim.fact + (claim.sourceUrls.length ? " (source: " + claim.sourceUrls[0] + ")" : " (unsourced)"));
  }
  lines.push("If the brief conflicts with your own recall, follow the brief. Never invent facts the brief does not contain.");
  return lines.join("\n");
}

module.exports = {
  TRUSTED_DOMAINS,
  MAX_CLAIMS,
  MAX_SOURCES,
  hostOf,
  isTrustedUrl,
  normalizeSources,
  normalizeBrief,
  buildResearchPrompt,
  researchContextForPrompt,
};
