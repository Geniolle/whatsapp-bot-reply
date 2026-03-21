//###################################################################################
// src/services/aiAssistant.js - VERSÃO CLASSIFICADORA PARA GOOGLE PLACES
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
      .map(r => `[ID: ${r.ID_TABLE || r.id_table || 'N/A'}] CONTEXTO: ${r.CONTEXTO || r.contexto || 'Geral'} | CHAVE: ${r.CHAVE || r.chave} | PROC: ${r.PROCESSO || r.processo || ''} | TEXTO_BASE: ${r.reply || r.RESPOSTA || r.text || ''}`)
      .join("\n");

    const promptSystem = `Você é o assistente da Igreja Verbo da Vida Braga.
Usuário: ${firstName}.

REGRAS RÍGIDAS DE CLASSIFICAÇÃO:
1. SAUDAÇÃO EXCLUSIVA: Apenas "Olá", "Oi", retorne "id_table": "SAUDACAO_DUPLA".
2. ANÁLISE DE CONTEXTO:
   - Livros/Livraria: Olhe APENAS para regras com CONTEXTO "LIVRARIA".
   - Igreja/Departamentos: Olhe APENAS para regras de CONTEXTO "DEPARTAMENTOS" ou "IGREJA".
3. PERGUNTAS DA PLANILHA (FAQ): Use o "TEXTO_BASE" para a resposta. NUNCA inicie com saudações.
4. LISTAS GERAIS E LIVROS: Siga estritamente os IDs numéricos e NUNCA invente títulos de livros no texto.
5. ASSUNTOS EXTERNOS (Braga / Guia Local): Se o usuário perguntar por restaurantes, cafés, hotéis, farmácias, passeios ou dicas da cidade, atue como um classificador de pesquisa.
   - 📍 IMPORTANTE: NÃO dê as sugestões diretamente aqui. O sistema usará o Google Maps.
   - EXTRAIA o tipo de local que o usuário quer e coloque no campo "termo" (ex: "restaurante", "café", "pizzaria", "parque").
   - Retorne obrigatoriamente "id_table": "IA_GENERICA", "contexto": "GUIA", "processo": "SEARCH_GOOGLE_PLACES" e "resposta": "OK".

BASE DE CONHECIMENTO:
${regrasFormatadas}

FORMATO JSON:
{
  "id_table": "NÚMERO DO ID (ou IA_GENERICA)",
  "contexto": "O CONTEXTO",
  "processo": "O PROCESSO (ou SEARCH_GOOGLE_PLACES para guias)",
  "termo": "O Tipo de local extraído da pergunta (ex: restaurante)",
  "resposta": "Sua resposta"
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: promptSystem },
        ...historico,
        { role: "user", content: mensagemUsuario }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1 // Temperatura baixa para não inventar nada, apenas extrair o termo
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (error) { throw error; }
}

module.exports = { analisarComIA };