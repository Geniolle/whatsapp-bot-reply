//###################################################################################
// src/services/aiAssistant.js - VERSÃO COM FUNIL DE CONTEXTO
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
    // 🚨 Agora lemos a coluna CONTEXTO (ou contexto) da planilha
    const regrasFormatadas = regrasPlanilha
      .map(r => `[ID: ${r.ID_TABLE || r.id_table || 'N/A'}] CONTEXTO: ${r.CONTEXTO || r.contexto || 'Geral'} | CHAVE: ${r.CHAVE || r.chave} | PROC: ${r.PROCESSO || r.processo || ''} | TEXTO_BASE: ${r.reply || r.RESPOSTA || r.text || ''}`)
      .join("\n");

    const promptSystem = `Você é o assistente da Igreja Verbo da Vida Braga.
Usuário: ${firstName}.

REGRAS RÍGIDAS DE CLASSIFICAÇÃO:
1. SAUDAÇÃO EXCLUSIVA: Apenas "Olá", "Oi", retorne "id_table": "SAUDACAO_DUPLA".
2. ANÁLISE DE CONTEXTO (MUITO IMPORTANTE): Primeiro, defina o assunto principal da pergunta do usuário.
   - Se ele falar de "livros", "ler", "autores", "editoras" ou "comprar": Olhe APENAS para as regras com CONTEXTO "LIVRARIA".
   - Se ele falar de "cultos", "oração", "ministérios", "centro de cura": Olhe APENAS para as regras com CONTEXTO "DEPARTAMENTOS" ou "IGREJA".
   - Isso evita confundir "livros sobre cura" (Livraria) com "departamento de cura" (Departamentos).
3. PERGUNTAS GERAIS (FAQ): Use o "TEXTO_BASE" para a resposta. NUNCA inicie com saudações.
4. LISTAS GERAIS: Se perguntar "quais as editoras" ou "autores", retorne o ID numérico correspondente do contexto LIVRARIA.
5. BUSCA DE LIVROS: Se pedir livros de um Autor/Editora ou de um Tema (ex: "fé", "cura"), extraia a palavra no "termo" e use o NÚMERO DO [ID] correspondente ao processo (AUTOR, EDITORA ou SEARCH).
6. PROIBIÇÃO: NUNCA liste títulos de livros no seu texto.

BASE DE CONHECIMENTO:
${regrasFormatadas}

FORMATO JSON:
{
  "id_table": "NÚMERO DO ID",
  "contexto": "O CONTEXTO da regra que você escolheu",
  "termo": "Palavra-chave, Autor ou Editora (ou vazio)",
  "resposta": "Sua resposta com base no TEXTO_BASE ou introdução"
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: promptSystem },
        ...historico,
        { role: "user", content: mensagemUsuario }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1 
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (error) { throw error; }
}

module.exports = { analisarComIA };