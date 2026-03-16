//###################################################################################
// src/router.js
//###################################################################################

//###################################################################################
// Normalização
//###################################################################################
function normalizeText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove acentos
    .toLowerCase()                   // Passa tudo a minúsculas
    .replace(/[^a-z0-9\s]/g, " ")    // Remove caracteres especiais
    .replace(/\s+/g, " ")            // Remove espaços duplos
    .trim();
}

//###################################################################################
// Helpers: pegar SPECIAL
//###################################################################################
function getSpecial(rules, key) {
  const k = String(key || "").toUpperCase();
  const r = (rules || []).find(
    (x) =>
      String(x.matchType || "").toUpperCase() === "SPECIAL" &&
      String(x.chave || "").toUpperCase() === k
  );
  return r ? String(r.resposta || "").trim() : null;
}

//###################################################################################
// Helpers: KEYWORDS
// - aceita separadores: | , ;
// - faz match por "palavra" (quando 1 termo) ou por "frase" (quando contém espaço)
//###################################################################################
function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitKeywords(keyRaw) {
  return String(keyRaw || "")
    .split(/[|,;]+/g)
    .map((k) => normalizeText(k)) // Normaliza as keywords da sheet
    .filter(Boolean);
}

function hasKeyword(msgN, kwN) {
  if (!kwN) return false;

  // se for frase (contém espaço), usa contains simples
  if (kwN.includes(" ")) {
    return msgN.includes(kwN);
  }

  // se for palavra única, garante fronteira por espaço/início/fim
  const re = new RegExp(`(?:^|\\s)${escapeRegex(kwN)}(?:$|\\s)`, "i");
  return re.test(msgN);
}

//###################################################################################
// Router: match
//###################################################################################
function decideReply(text, rules) {
  // rawMsg: Mensagem exata como o utilizador enviou (com acentos e maiúsculas)
  const rawMsg = String(text || "").trim();
  // msgN: Mensagem completamente limpa (sem acentos, sem pontuação, tudo minúsculo)
  const msgN = normalizeText(rawMsg);

  for (const rule of rules) {
    const type = String(rule.matchType || "").toUpperCase();
    const keyRaw = String(rule.chave || "");

    // ignora SPECIAL no matching normal
    if (type === "SPECIAL") continue;

    if (type === "REGEX") {
      try {
        const re = new RegExp(keyRaw, "i"); // "i" garante que ignora maiúsculas/minúsculas
        // Testa a regra do REGEX tanto na mensagem limpa como na original
        if (re.test(msgN) || re.test(rawMsg)) {
          return String(rule.resposta || "").trim();
        }
      } catch (_) {}
      continue;
    }

    if (type === "KEYWORDS") {
      const kws = splitKeywords(keyRaw);
      // Aqui só precisa de testar contra o msgN, pois as keywords também já foram limpas
      if (kws.some((kw) => hasKeyword(msgN, kw))) {
        return String(rule.resposta || "").trim();
      }
      continue;
    }

    // Normaliza a chave (da folha de cálculo) para EXACT ou CONTAINS
    const keyN = normalizeText(keyRaw);

    if (type === "EXACT") {
      if (msgN === keyN) return String(rule.resposta || "").trim();
    } else if (type === "CONTAINS") {
      if (msgN.includes(keyN)) return String(rule.resposta || "").trim();
    }
  }

  return null;
}

module.exports = { decideReply, getSpecial, normalizeText };