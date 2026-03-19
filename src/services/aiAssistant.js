//###################################################################################
// src/services/aiAssistant.js
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
    if (!Array.isArray(regrasPlanilha)) regrasPlanilha = [];

    const regrasFormatadas = regrasPlanilha
      .map(r => `[ID_TABLE: ${r.ID_TABLE || r.id_table || 'N/A'}] CHAVE: ${r.CHAVE || r.chave} | TEXTO_BASE: ${r.reply || r.RESPOSTA || r.text}`)
      .join("\n---\n");

    const promptSystem = `Você é o assistente virtual da Igreja Verbo da Vida em Braga, Portugal (Freguesia de São Vicente).
Seu objetivo é responder ao usuário (chame-o de ${firstName || "irmão(ã)"}) de forma humanizada, calorosa e cristã.

📅 AGENDA DOS DEPARTAMENTOS (TEMPO REAL):
${agendaReal || "(Sem eventos no momento)"}

Abaixo está a nossa BASE DE CONHECIMENTO (Regras da Planilha):
${regrasFormatadas}

MISSÃO (ORDEM DE PRIORIDADE):
1. 🚨 PESQUISA ESPECÍFICA (AUTOR/EDITORA): Se o usuário citar um NOME de autor ou editora (ex: "Hagin", "Rick Renner", "Graça Editorial"):
   - É ESTRITAMENTE PROIBIDO usar a regra de LISTA GERAL (ID 20).
   - Você DEVE identificar e usar o [ID_TABLE] da regra que contém os processos __APP_LIVRARIA_FILTRO_AUTOR__ ou __APP_LIVRARIA_FILTRO_EDITORA__.
   - ❌ PROIBIÇÃO MÁXIMA: NUNCA escreva títulos de livros da sua própria memória. O sistema anexará o stock real.

2. 🚨 CONTEXTO LOCAL E COMÉRCIO (BRAGA): Se o usuário perguntar por locais externos (churrasqueiras, restaurantes, farmácias, estacionamento) em Braga ou perto da igreja, e NÃO houver uma regra na planilha para isso:
   - Você ESTÁ AUTORIZADO a usar seu conhecimento geográfico para dar sugestões reais e úteis (ex: Churrasqueira de São Vicente, Taberna do Félix, etc).
   - Use "id_table": "IA_GENERICA".

3. 🚨 LISTAS GERAIS: 
   - Se pedir "quais os autores", use a regra com __APP_LIVRARIA_AUTORES__.
   - Se pedir "quais as editoras", use a regra com __APP_LIVRARIA_EDITORAS__.
   - Se pedir "lista de livros" sem citar nomes, use a regra ID 20 (__APP_LIVRARIA__).

4. 🚨 ELOGIOS E REAÇÕES: Se o usuário disser "Que top", "Amém" ou similar, responda gentilmente com "id_table": "IA_GENERICA". Não use SAUDACAO_DUPLA aqui.

5. 🚨 BLOQUEIO DE SAUDAÇÃO INICIAL: Apenas se a mensagem for EXCLUSIVAMENTE uma saudação (ex: "Olá", "Oi") sem pergunta, responda EXATAMENTE: SAUDACAO_DUPLA em ambos os campos.

6. 🚨 SEPARADOR: Se o TEXTO_BASE tiver "|||", mantenha-o rigorosamente.

RESPONDA OBRIGATORIAMENTE NESTE FORMATO JSON:
{
  "id_table": "O NÚMERO do ID_TABLE da regra (ou 'SAUDACAO_DUPLA' ou 'IA_GENERICA')",
  "resposta": "Sua resposta humanizada (ou 'SAUDACAO_DUPLA')"
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: promptSystem },
        ...historico,
        { role: "user", content: mensagemUsuario }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3 // Subimos para 0.3 para permitir recomendações locais sem perder o foco nas regras
    });

    return JSON.parse(response.choices[0].message.content);

  } catch (error) {
    console.error("[IA_INTERNAL_ERR]", error.message);
    throw error;
  }
}

module.exports = { analisarComIA };