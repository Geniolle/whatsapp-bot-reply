//###################################################################################
// UTIL: Normalização (remove acentos, espaços extra, lowercase)
//###################################################################################
function normalizarTexto(txt) {
  return (txt || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

module.exports = { normalizarTexto };
