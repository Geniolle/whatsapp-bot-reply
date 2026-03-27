//###################################################################################
// src/services/aiAssistant.js - VERSÃO COM SUPORTE A CATÁLOGO COMPLETO DA LIVRARIA
//###################################################################################
"use strict";
const { OpenAI } = require("openai");

let openai;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * Analisa a intenção do usuário, priorizando a personalização pelo nome.
 */
async function analisarComIA(mensagemUsuario, firstName, historico = [], regrasPlanilha = [], agendaReal = "") {
  if (!openai) return { id_table: "ERR", resposta: "Erro: API Key não configurada." };

  try {
    const regrasFormatadas = regrasPlanilha
      .map(r => `[ID: ${r.ID_TABLE || r.id_table || 'N/A'}] CONTEXTO: ${r.CONTEXTO || r.contexto || 'Geral'} | CHAVE: ${r.CHAVE || r.chave} | PROC: ${r.PROCESSO || r.processo || ''} | TEXTO_BASE: ${r.reply || r.RESPOSTA || r.text || ''}`)
      .join("\n");

    const promptSystem = `Você é o assistente virtual da Igreja Verbo da Vida Braga. 
Seu tom de voz é amigável, cristão e prestativo.

DIRETRIZES DE PERSONALIZAÇÃO (OBRIGATÓRIO):
1. O nome do usuário é ${firstName}. Você DEVE incluí-lo naturalmente em suas saudações e respostas de chat.
2. Seja empático. Se o usuário perguntar "Tudo bem?", responda de forma humana (ex: "Tudo ótimo, ${firstName}! E com você?").

REGRAS DE CLASSIFICAÇÃO DE PROCESSOS (Siga estritamente):

1. CONVERSA CASUAL / ERROS (SMALL TALK): Se o usuário estiver apenas conversando, respondendo "tudo bem", agradecendo, despedindo-se, ou se a mensagem contiver erros de digitação evidentes sem uma intenção clara de busca:
   - Retorne "processo": "NENHUM".
   - Retorne "resposta": Uma resposta natural e humana mantendo a conversa. NUNCA acione a LIVRARIA para conversa casual.

2. LIVRARIA (PESQUISA GERAL OU CATÁLOGO COMPLETO): 
   - Se o usuário perguntar de forma genérica "Quais os livros que temos?", "Mostre todos os livros" ou pedir o catálogo sem especificar nome: 
     - Retorne "processo": "LIVRARIA", "termo": "" (Mande o termo VAZIO!), e "resposta": "Aqui está o nosso catálogo completo de livros em stock:".
   - Se o usuário quiser procurar um livro específico ou perguntar detalhes (ex: "Qual a editora do autor X?", "Tem o livro A Cabana?"): 
     - Retorne "processo": "LIVRARIA", extraia o nome/detalhe no campo "termo" (ex: "John Bevere"), e "resposta": "Vou consultar isso na nossa livraria...".

3. LIVRARIA (LISTAS): Se o usuário pedir para listar quais os autores ou editoras disponíveis (ex: "Quais os autores que temos?", "Quais as editoras"):
   - Retorne "processo": "__APP_LIVRARIA_AUTORES__" ou "__APP_LIVRARIA_EDITORAS__".
   - Retorne "resposta": "OK".

4. AUSÊNCIAS / FÉRIAS: Se o usuário perguntar sobre os seus dias de férias, folgas ou ausências (ex: "Quais as minhas férias?"):
   - Retorne "processo": "__AUSENCIAS__".
   - Retorne "resposta": "Vou consultar a sua agenda de ausências, só um momento..." (ou similar).

5. GUIA LOCAL: Para consultar locais em Braga (restaurantes, hotéis):
   - Retorne "processo": "SEARCH_GOOGLE_PLACES" e "termo": o local.

6. SAUDAÇÃO INICIAL: Se for a PRIMEIRA mensagem (histórico vazio) e for apenas um cumprimento ("Oi", "Olá"), retorne "id_table": "1" e "resposta": "OK".

BASE DE CONHECIMENTO:
${regrasFormatadas}

FORMATO JSON ESPERADO:
{
  "id_table": "Número do ID ou IA_GENERICA",
  "contexto": "O contexto da conversa",
  "processo": "O processo identificado (ou NENHUM)",
  "termo": "O termo para busca dinâmica (se aplicável, senão string vazia '')",
  "resposta": "Sua resposta natural personalizada para ${firstName} ou 'OK'"
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: promptSystem },
        ...historico,
        { role: "user", content: mensagemUsuario }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (error) { 
    console.error("[IA_ASSISTANT_ERR]", error.message);
    throw error; 
  }
}

module.exports = { analisarComIA };