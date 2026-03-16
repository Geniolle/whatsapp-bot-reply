//###################################################################################
// src/services/router.js
//###################################################################################
"use strict";

//###################################################################################
// Normalização (matching consistente)
//###################################################################################
function normalizeText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripBom(v) {
  return String(v || "").replace(/^\uFEFF/, "");
}

//###################################################################################
// SPECIAL: FALLBACK / MENU
//###################################################################################
function getSpecial(rules, key) {
  const k = stripBom(key).trim().toUpperCase();
  const r = (rules || []).find((x) => {
    const mt = stripBom(x.matchType).trim().toUpperCase();
    const ch = stripBom(x.chave).trim().toUpperCase();
    return mt === "SPECIAL" && ch === k;
  });
  return r ? String(r.resposta || "").trim() : null;
}

//###################################################################################
// KEYWORDS helpers (separadores: | , ;)
//###################################################################################
function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitKeywords(keyRaw) {
  return stripBom(keyRaw)
    .split(/[|,;]+/g)
    .map((k) => normalizeText(k))
    .filter(Boolean);
}

function hasKeyword(msgN, kwN) {
  if (!kwN) return false;
  if (kwN.includes(" ")) return msgN.includes(kwN);
  const re = new RegExp(`(?:^|\\s)${escapeRegex(kwN)}(?:$|\\s)`, "i");
  return re.test(msgN);
}

//###################################################################################
// Matching: retorna { reply, rule } para debug
//###################################################################################
function decideReplyWithRule(text, rules) {
  const rawMsg = String(text || "").trim();
  const msgN = normalizeText(rawMsg);

  for (const rule of rules || []) {
    const type = stripBom(rule.matchType).trim().toUpperCase();
    const keyRaw = stripBom(rule.chave || "");

    if (type === "SPECIAL") continue;

    if (type === "REGEX") {
      try {
        const re = new RegExp(keyRaw, "i");
        if (re.test(msgN)) return { reply: String(rule.resposta || "").trim(), rule };
      } catch (_) {}
      continue;
    }

    if (type === "KEYWORDS") {
      const kws = splitKeywords(keyRaw);
      if (kws.some((kw) => hasKeyword(msgN, kw))) {
        return { reply: String(rule.resposta || "").trim(), rule };
      }
      continue;
    }

    const keyN = normalizeText(keyRaw);

    if (type === "EXACT") {
      if (msgN === keyN) return { reply: String(rule.resposta || "").trim(), rule };
      continue;
    }

    if (type === "CONTAINS") {
      if (keyN && msgN.includes(keyN)) return { reply: String(rule.resposta || "").trim(), rule };
      continue;
    }
  }

  return { reply: "", rule: null };
}

function decideReply(text, rules) {
  return decideReplyWithRule(text, rules).reply;
}

module.exports = {
  normalizeText,
  getSpecial,
  decideReply,
  decideReplyWithRule,
};