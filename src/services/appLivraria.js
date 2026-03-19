//###################################################################################
// src/services/appLivraria.js
//###################################################################################
"use strict";

const { readRange } = require("./sheets");

function normHeader_v1(h) {
  return String(h || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeTextForSearch(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") 
    .toLowerCase()                   
    .replace(/[^a-z0-9\s]/g, " ")    
    .replace(/\s+/g, " ")            
    .trim();
}

// =================================================================================
// LISTA DE PALAVRAS A IGNORAR NA PESQUISA (Agora com "mais", "detalhes", etc)
// =================================================================================
const STOP_WORDS = new Set([
  "quais", "qual", "os", "as", "o", "a", "um", "uma", "do", "da", "de", "dos", "das", 
  "livro", "livros", "titulo", "titulos", "assunto", "tema", "temas", "fala", "falam", "falar", 
  "quero", "ver", "gostaria", "tem", "temos", "sobre", "por", "favor", 
  "na", "no", "com", "sao", "são", "e", "que", "me", "mostra", "mostre", "lista", "listar", 
  "procurar", "pesquisar", "busca", "buscar", "tens", "queria", "saber", "algo", "algum",
  "mais", "informacao", "informacoes", "informações", "detalhe", "detalhes", "tudo", "todos", "poderia", "gostava"
]);

async function getLivrosEmStock_v1({ spreadsheetId, sheetName, searchTerm }) {
  try {
    const values = await readRange(spreadsheetId, `'${sheetName}'!A:ZZ`);
    if (!values || values.length < 2) return "Ainda não temos livros registados no nosso stock.";

    const header = values[0] || [];
    const idxArtigo = header.findIndex((h) => normHeader_v1(h) === "ARTIGO");
    const idxEditora = header.findIndex((h) => normHeader_v1(h) === "EDITORA");
    const idxTitulos = header.findIndex((h) => normHeader_v1(h) === "TITULOS" || normHeader_v1(h) === "TITULO");
    const idxAutor = header.findIndex((h) => normHeader_v1(h) === "AUTOR");
    const idxValor = header.findIndex((h) => normHeader_v1(h) === "VALORCAPA");
    const idxStock = header.findIndex((h) => normHeader_v1(h) === "STOCKATUAL");

    if (idxTitulos < 0 || idxStock < 0) {
      return "Não foi possível ler as colunas de stock corretamente. Verifique se as colunas TITULOS e STOCK ATUAL existem.";
    }

    const livrosDisponiveis = [];
    const searchN = normalizeTextForSearch(searchTerm); 
    
    let searchWords = [];
    if (searchN) {
      searchWords = searchN.split(" ").filter(word => {
        if (STOP_WORDS.has(word)) return false; 
        if (word.length === 1 && isNaN(Number(word))) return false; 
        return true;
      });
    }

    if (searchN && searchWords.length === 0) {
       return `Desculpa, não consegui extrair o nome de um autor ou título da frase "${searchTerm}".\n\nPara ser mais rápido, tenta escrever apenas o nome que procuras (Ex: "Rhema", "Lucado", "Fé")! 👇`;
    }

    for (let r = 1; r < values.length; r++) {
      const row = values[r] || [];
      const stockVal = Number(String(row[idxStock] || "0").trim());

      if (!isNaN(stockVal) && stockVal > 0) {
        const artigo = idxArtigo >= 0 ? String(row[idxArtigo] || "").trim() : "";
        const editora = idxEditora >= 0 ? String(row[idxEditora] || "").trim() : "";
        const titulo = String(row[idxTitulos] || "").trim();
        const autor = idxAutor >= 0 ? String(row[idxAutor] || "").trim() : "";
        
        let valor = idxValor >= 0 ? String(row[idxValor] || "").trim() : "";
        if (valor && !valor.includes("€")) valor += "€";

        if (titulo) {
          if (searchWords.length > 0) {
            const combinedText = normalizeTextForSearch(`${titulo} ${autor} ${editora} ${artigo}`);
            const combinedWords = combinedText.split(/\s+/);
            
            // Só aprova se a palavra pesquisada existir "POR INTEIRO"
            const matchesAll = searchWords.every(word => combinedWords.includes(word));
            
            if (!matchesAll) continue; 
          }
          livrosDisponiveis.push({ artigo, editora, titulo, autor, valor });
        }
      }
    }

    if (livrosDisponiveis.length === 0) {
      if (searchN) return `Não encontrei nenhum livro, autor ou editora com a expressão "${searchWords.join(" ").toUpperCase()}" em stock. 😔\n\nPodes tentar pesquisar com outro termo, pedir a lista de *Autores*, ou escrever *Sair* para cancelar.`;
      return "Neste momento não temos livros disponíveis em stock. 😔";
    }

    const lines = [];
    if (searchN) {
      lines.push(`🔍 *RESULTADOS DA PESQUISA PARA:* "${searchWords.join(" ").toUpperCase()}"\n`);
    } else {
      lines.push(`📚 *LISTA DE LIVROS DISPONÍVEIS - VERBO SHOP* 📚\n`);
    }
    
    for (const livro of livrosDisponiveis) {
      lines.push(`📖 *Título:* ${livro.titulo}`);
      if (livro.autor) lines.push(`👤 *Autor:* ${livro.autor}`);
      if (livro.editora) lines.push(`🏢 *Editora:* ${livro.editora}`);
      if (livro.artigo) lines.push(`🔖 *Categoria:* ${livro.artigo}`);
      if (livro.valor) lines.push(`💶 *Valor:* ${livro.valor}`);
      lines.push(`〰️〰️〰️〰️〰️〰️〰️〰️`);
    }

    if (searchN) {
      lines.push("\nSe desejares pesquisar outro, basta digitar o nome! Para finalizar a pesquisa escreve *Sair*.");
    } else {
      lines.push("\nSe desejares adquirir algum destes livros, basta dizeres-me qual o título pretendido! 🙏");
    }

    return lines.join("\n");

  } catch (e) {
    console.log("[LIVRARIA_ERR]", e?.message || e);
    return "Desculpa, ocorreu um erro ao consultar o stock dos livros.";
  }
}

async function getListasLivraria_v1({ spreadsheetId, sheetName, tipo }) {
  try {
    const values = await readRange(spreadsheetId, `'${sheetName}'!A:ZZ`);
    if (!values || values.length < 2) return "Ainda não temos livros registados no nosso stock.";

    const header = values[0] || [];
    const idxAutor = header.findIndex((h) => normHeader_v1(h) === "AUTOR");
    const idxEditora = header.findIndex((h) => normHeader_v1(h) === "EDITORA");
    const idxStock = header.findIndex((h) => normHeader_v1(h) === "STOCKATUAL");

    if (idxStock < 0 || (tipo === "AUTORES" && idxAutor < 0) || (tipo === "EDITORAS" && idxEditora < 0)) {
      return "Não foi possível ler as colunas corretamente. Verifique se as colunas existem.";
    }

    const items = new Set();

    for (let r = 1; r < values.length; r++) {
      const row = values[r] || [];
      const stockVal = Number(String(row[idxStock] || "0").trim());

      if (!isNaN(stockVal) && stockVal > 0) {
        if (tipo === "AUTORES") {
          const autor = String(row[idxAutor] || "").trim();
          if (autor) items.add(autor); 
        } else if (tipo === "EDITORAS") {
          const editora = String(row[idxEditora] || "").trim();
          if (editora) items.add(editora); 
        }
      }
    }

    const sortedItems = Array.from(items).sort((a, b) => a.localeCompare(b, "pt-PT", { sensitivity: "base" }));

    if (sortedItems.length === 0) {
      return `Neste momento não temos ${tipo.toLowerCase()} com livros disponíveis em stock.`;
    }

    const lines = [];
    if (tipo === "AUTORES") {
      lines.push("✍️ *AUTORES DISPONÍVEIS EM STOCK:*\n");
    } else {
      lines.push("🏢 *EDITORAS DISPONÍVEIS EM STOCK:*\n");
    }

    for (const item of sortedItems) {
      lines.push(`▫️ ${item}`);
    }

    lines.push(`\nPara veres os livros de um deles, basta escrever o nome correspondente aqui em baixo! 👇 (Ou escreve "Sair" para cancelar)`);

    return lines.join("\n");

  } catch (e) {
    console.log("[LIVRARIA_ERR]", e?.message || e);
    return "Desculpa, ocorreu um erro ao consultar a lista solicitada.";
  }
}

// =================================================================================
// NOVA FUNÇÃO: PESQUISA EXCLUSIVA POR AUTOR OU EDITORA
// =================================================================================
async function getLivrosExclusivos_v1({ spreadsheetId, sheetName, tipoFiltro, termoPesquisa }) {
  try {
    const values = await readRange(spreadsheetId, `'${sheetName}'!A:ZZ`);
    if (!values || values.length < 2) return "Ainda não temos livros registados no nosso stock.";

    const header = values[0] || [];
    const idxArtigo = header.findIndex((h) => normHeader_v1(h) === "ARTIGO");
    const idxEditora = header.findIndex((h) => normHeader_v1(h) === "EDITORA");
    const idxTitulos = header.findIndex((h) => normHeader_v1(h) === "TITULOS" || normHeader_v1(h) === "TITULO");
    const idxAutor = header.findIndex((h) => normHeader_v1(h) === "AUTOR");
    const idxValor = header.findIndex((h) => normHeader_v1(h) === "VALORCAPA");
    const idxStock = header.findIndex((h) => normHeader_v1(h) === "STOCKATUAL");

    if (idxTitulos < 0 || idxStock < 0) {
      return "Não foi possível ler as colunas de stock corretamente.";
    }

    const livrosFiltrados = [];
    
    // Removemos STOP_WORDS da pesquisa também aqui para evitar que a IA mande "livros do rick renner" e a pesquisa falhe
    const searchN = normalizeTextForSearch(termoPesquisa);
    let searchWords = [];
    if (searchN) {
      searchWords = searchN.split(" ").filter(word => {
        if (STOP_WORDS.has(word)) return false; 
        if (word.length === 1 && isNaN(Number(word))) return false; 
        return true;
      });
    }

    if (searchWords.length === 0) {
        return `Desculpa, não consegui extrair o nome do ${tipoFiltro.toLowerCase()} da sua pesquisa. Tente novamente apenas com o nome.`;
    }

    const termoLimpoFinal = searchWords.join(" "); // Ex: "rick renner"

    for (let r = 1; r < values.length; r++) {
      const row = values[r] || [];
      const stockVal = Number(String(row[idxStock] || "0").trim());

      if (!isNaN(stockVal) && stockVal > 0) {
        const autor = idxAutor >= 0 ? String(row[idxAutor] || "").trim() : "";
        const editora = idxEditora >= 0 ? String(row[idxEditora] || "").trim() : "";
        
        let matchEncontrado = false;

        if (tipoFiltro === "AUTOR" && autor) {
            const autorLimpo = normalizeTextForSearch(autor);
            // Verifica se TODAS as palavras pesquisadas existem no nome do autor (não precisa de estar por ordem exata)
            matchEncontrado = searchWords.every(word => autorLimpo.includes(word));
        }
        else if (tipoFiltro === "EDITORA" && editora) {
            const editoraLimpo = normalizeTextForSearch(editora);
            matchEncontrado = searchWords.every(word => editoraLimpo.includes(word));
        }

        if (matchEncontrado) {
          const artigo = idxArtigo >= 0 ? String(row[idxArtigo] || "").trim() : "";
          const titulo = String(row[idxTitulos] || "").trim();
          let valor = idxValor >= 0 ? String(row[idxValor] || "").trim() : "";
          if (valor && !valor.includes("€")) valor += "€";

          livrosFiltrados.push({ artigo, editora, titulo, autor, valor });
        }
      }
    }

    if (livrosFiltrados.length === 0) {
      return `Não encontrei nenhum livro associado a ${tipoFiltro.toLowerCase()} "${termoPesquisa.toUpperCase()}" em stock neste momento. 😔`;
    }

    const lines = [];
    lines.push(`📚 *LIVROS EXCLUSIVOS - ${tipoFiltro}: ${termoLimpoFinal.toUpperCase()}* 📚\n`);
    
    for (const livro of livrosFiltrados) {
      lines.push(`📖 *Título:* ${livro.titulo}`);
      if (livro.autor) lines.push(`👤 *Autor:* ${livro.autor}`);
      if (livro.editora) lines.push(`🏢 *Editora:* ${livro.editora}`);
      if (livro.artigo) lines.push(`🔖 *Categoria:* ${livro.artigo}`);
      if (livro.valor) lines.push(`💶 *Valor:* ${livro.valor}`);
      lines.push(`〰️〰️〰️〰️〰️〰️〰️〰️`);
    }

    lines.push("\nSe desejares adquirir algum destes livros, basta dizeres-me qual o título pretendido! 🙏");

    return lines.join("\n");

  } catch (e) {
    console.log("[LIVRARIA_ERR]", e?.message || e);
    return "Desculpa, ocorreu um erro ao consultar os livros exclusivos.";
  }
}

module.exports = { getLivrosEmStock_v1, getListasLivraria_v1, getLivrosExclusivos_v1 };