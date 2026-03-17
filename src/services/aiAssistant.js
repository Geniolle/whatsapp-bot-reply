//###################################################################################
// src/services/aiAssistant.js
//###################################################################################
"use strict";

const { OpenAI } = require("openai");

// Inicializa a OpenAI apenas se a chave existir no .env
let openai;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function analisarComIA(mensagemUsuario, firstName) {
  if (!openai) {
    console.log("[IA] Chave OPENAI_API_KEY não encontrada no .env");
    return { acao: "FALHA" };
  }

  try {
    // "Ferramentas" que a IA pode usar para aceder à sua base de dados
    const tools = [
      {
        type: "function",
        function: {
          name: "pesquisar_livros_verbo_shop",
          description: "Pesquisa livros no stock da igreja. Use isto quando o utilizador quiser procurar um livro, autor ou tema.",
          parameters: {
            type: "object",
            properties: {
              termo: {
                type: "string",
                description: "A palavra-chave pura da busca (ex: 'Fé', 'Renner', 'Casamento'). Se o utilizador disser 'livros do Renner', extraia apenas 'Renner'. Não inclua palavras como 'mais', 'sobre', 'livros'."
              }
            },
            required: ["termo"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "consultar_agenda",
          description: "Mostra a agenda de eventos da igreja.",
          parameters: {
            type: "object",
            properties: {
              tipo: {
                type: "string",
                enum: ["MENSAL", "DEPARTAMENTOS"],
                description: "Escolha DEPARTAMENTOS se a pessoa pedir por ministérios/departamentos. Caso contrário, escolha MENSAL."
              }
            },
            required: ["tipo"]
          }
        }
      }
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // O modelo mais rápido e económico
      messages: [
        {
          role: "system",
          content: `Você é o assistente virtual da igreja Verbo da Vida.
O primeiro nome do utilizador é ${firstName || "amigo"}.
Seja empático, amável e cristão. Responda de forma muito natural e breve (máximo 2-3 frases).
Se a pessoa pedir informações de agenda ou procurar livros, utilize obrigatoriamente as funções (tools) disponíveis. Nunca invente dados de livros ou eventos.`
        },
        {
          role: "user",
          content: mensagemUsuario
        }
      ],
      tools: tools,
      tool_choice: "auto",
      temperature: 0.3
    });

    const msg = response.choices[0].message;

    // Se a IA decidiu usar uma ferramenta (Livraria ou Agenda)
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const tool = msg.tool_calls[0].function;
      const args = JSON.parse(tool.arguments);

      if (tool.name === "pesquisar_livros_verbo_shop") {
        return { acao: "LIVRARIA", termo: args.termo || "" };
      }
      if (tool.name === "consultar_agenda") {
        return { acao: args.tipo === "DEPARTAMENTOS" ? "AGENDA_DEPT" : "AGENDA_MENSAL" };
      }
    }

    // Se a IA apenas quis responder com texto (conversa normal)
    return { acao: "TEXTO", resposta: msg.content };

  } catch (error) {
    console.error("[IA_ERROR]", error.message);
    return { acao: "FALHA" };
  }
}

module.exports = { analisarComIA };