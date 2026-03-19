//###################################################################################
// src/services/aiAssistant.js - VERSÃO COM BUSCA POR TÍTULO/ASSUNTO
//###################################################################################
"use strict";
const { OpenAI } = require("openai");

let openai;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function analisarComIA(mensagemUsuario, firstName, historico = [], regrasPlanilha = [], agendaReal = "") {
  if (!openai) return { id_table: "ERR", resposta: "Erro: API Key não configurada." };

  try {
    const regrasFormatadas = regrasPlanilha
      .map(r => `[ID: ${r.ID_TABLE || r.id_table || 'N/A'}] CHAVE: ${r.CHAVE || r.chave} | PROC: ${r.PROCESSO || r.processo || ''}`)
      .join("\n");

    const promptSystem = `Você é o assistente da Igreja Verbo da Vida Braga.
Usuário: ${firstName}.

REGRAS RÍGIDAS DE CLASSIFICAÇÃO:
1. SAUDAÇÃO EXCLUSIVA: Apenas "Olá", "Oi", retorne "id_table": "SAUDACAO_DUPLA".
2. LISTAS GERAIS: Se perguntar "quais os autores" ou "quais as editoras", retorne o ID de __APP_LIVRARIA_AUTORES__ ou __APP_LIVRARIA_EDITORAS__. Deixe "termo" vazio ("").
3. FILTROS DE NOME (Autor/Editora): Se pedir livros de uma editora ou autor específico (ex: "Rhema", "Tony Cooke"), extraia o NOME no campo "termo" e use o ID de __APP_LIVRARIA_FILTRO_EDITORA__ ou __APP_LIVRARIA_FILTRO_AUTOR__.
4. BUSCA POR TÍTULO/ASSUNTO: Se o usuário pedir livros sobre um tema ou contendo uma palavra (ex: "livros de fé", "sobre cura", "livro família"), extraia APENAS a palavra-chave (ex: "fé", "cura", "família") no campo "termo". Use o [ID] onde o PROC é __APP_LIVRARIA_SEARCH__.
5. PROIBIÇÃO: NUNCA liste títulos de livros na sua introdução.

BASE DE CONHECIMENTO:
${regrasFormatadas}

FORMATO JSON:
{
  "id_table": "NÚMERO DO ID",
  "termo": "Palavra-chave, Autor ou Editora (ou vazio)",
  "resposta": "Sua introdução humanizada"
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: promptSystem },
        ...historico,
        { role: "user", content: mensagemUsuario }
      ],
      response_format: { type: "json_object" },
      temperature: 0.0
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (error) { throw error; }
}

module.exports = { analisarComIA };