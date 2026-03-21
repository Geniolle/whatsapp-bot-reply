//###################################################################################
// src/services/aiAssistant.js - VERSÃO COM GUIA DE BRAGA PROFISSIONAL
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
5. ASSUNTOS EXTERNOS (Braga / Guia Local): Se o usuário perguntar por restaurantes, cafés, hotéis ou dicas da cidade, atue como um guia local experiente. 
   - 📍 IMPORTANTE: A Igreja fica na Praceta Beato Inácio de Azevedo, 7, São Vicente, Braga.
   - Recomende APENAS estabelecimentos REAIS e verdadeiros em Braga. NUNCA invente nomes.
   - OBRIGATÓRIO FORMATAR COMO UM GUIA PROFISSIONAL. Para cada local, use este formato exato:
     🍽️ *[Nome do Local]*
     📍 Morada: [Rua e Zona exata em Braga]
     🚶 Distância: [Estimativa a pé ou de carro a partir da igreja em São Vicente]
     💡 Detalhe: [Tipo de comida, especialidade ou dica do local]
   - Retorne "id_table": "IA_GENERICA", "contexto": "GUIA" e coloque o texto na "resposta".

BASE DE CONHECIMENTO:
${regrasFormatadas}

FORMATO JSON:
{
  "id_table": "NÚMERO DO ID (ou IA_GENERICA)",
  "contexto": "O CONTEXTO",
  "termo": "Palavra-chave (ou vazio)",
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
      temperature: 0.3 // Temperatura ideal para ser simpática mas aterrada à realidade
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (error) { throw error; }
}

module.exports = { analisarComIA };