//###################################################################################
// src/handlers/schedulingFlow.js - VERSÃO COM VLOOKUP NA WS_COMUNICACAO
//###################################################################################
"use strict";

const { findAllPendingByLeader, updateStatusById, getNextInBatch } = require("../services/appScheduling");
const { simulateTyping, safeSend } = require("./onMessageUtils");
const { readRange } = require("../services/sheets"); // Importamos o leitor do Excel

// 👇 NOVA FUNÇÃO: Vai à folha WS_COMUNICACAO procurar o ID_NUMBER pelo Nome 👇
async function findPhoneByNome(spreadsheetId, nomeSolicitante) {
    if (!nomeSolicitante) return null;
    try {
        const sheetName = process.env.SHEET_NAME_BP || "WS_COMUNICACAO";
        const values = await readRange(spreadsheetId, `'${sheetName}'!A:Z`);
        
        if (!values || values.length < 2) return null;

        const headers = values[0].map(h => String(h || "").trim().toUpperCase());
        // Procura a coluna do nome (NOME) e do contacto (ID_NUMBER)
        const idxNome = headers.findIndex(h => h === "NOME" || h === "NOME_COMPLETO" || h.includes("NOME"));
        const idxPhone = headers.findIndex(h => h === "ID_NUMBER");

        if (idxNome < 0 || idxPhone < 0) return null;

        const target = String(nomeSolicitante).trim().toLowerCase();
        
        for (let i = 1; i < values.length; i++) {
            const rowName = String(values[i][idxNome] || "").trim().toLowerCase();
            // Verifica se o nome coincide
            if (rowName === target) {
                const phone = String(values[i][idxPhone] || "").trim();
                if (phone) return phone;
            }
        }
    } catch (e) {
        console.error("[LOOKUP_PHONE_ERR]", e.message);
    }
    return null;
}

async function handleSchedulingFlow(client, senderId, dbId, bodyRaw, cfg) {
    const textNorm = bodyRaw.trim().toLowerCase();
    try {
        const pendings = await findAllPendingByLeader({ spreadsheetId: cfg.spreadsheetId, leaderChatId: dbId });
        if (pendings.length === 0) return false;

        const requestIdFromMsg = bodyRaw.replace(/\D/g, "");
        const textNoNum = textNorm.replace(/[0-9]/g, "").trim(); 
        const isNumericOnly = /^\d+$/.test(textNorm);

        const isConfirm = /^(confirmar|confirma|confirmo|aceitar|aceito|ok|sim)$/i.test(textNoNum) || isNumericOnly;
        const isReject = /^(recusar|recuso|nao|não)$/i.test(textNoNum);
        
        if (!isConfirm && !isReject) return false;

        let targetId = null;
        
        if (pendings.length === 1 && !requestIdFromMsg) {
            targetId = pendings[0].id;
        } 
        else if (requestIdFromMsg) {
            targetId = requestIdFromMsg;
        } 
        else if (pendings.length > 1 && !requestIdFromMsg) {
            const listagem = pendings.map(p => `#${p.id}`).join(", ");
            await simulateTyping(client, senderId, 1500);
            await safeSend(client, senderId, `⚠️ Tens ${pendings.length} pedidos pendentes na tua lista (${listagem}).\n\nPor favor, responde dizendo qual queres processar. (Ex: *"confirmar ${pendings[0].id}"* ou apenas escreve *"${pendings[0].id}"*)`);
            return true; 
        }

        if (targetId) {
            const validPending = pendings.find(p => String(p.id) === String(targetId));
            if (!validPending) {
                await safeSend(client, senderId, `Desculpa, não encontrei o pedido #${targetId} na tua lista de pendentes.`);
                return true;
            }

            const actionStatus = isConfirm ? "Confirmado ✅" : "Recusado ❌";
            const data = await updateStatusById({ spreadsheetId: cfg.spreadsheetId, requestId: targetId, newStatus: actionStatus });
            
            if (data) {
                // 1. Avisa o Apoio
                await simulateTyping(client, senderId, 1000);
                await safeSend(client, senderId, `✅ Feito! O pedido *#${targetId}* foi marcado como *${actionStatus.toUpperCase()}*.`);
                
                // 2. Feedback ao Solicitante
                try {
                    // Primeiro tenta ver se já veio com a data, senão, vai à WS_COMUNICACAO procurar o nome do Solicitante
                    let contatoSolicitante = data.chatIdSolicitante || data.telefoneSolicitante || validPending.telefoneSolicitante;
                    
                    if (!contatoSolicitante) {
                        const nomeParaBuscar = data.solicitante || validPending.solicitante;
                        contatoSolicitante = await findPhoneByNome(cfg.spreadsheetId, nomeParaBuscar);
                    }
                    
                    if (contatoSolicitante) {
                        const formatId = String(contatoSolicitante).includes('@c.us') ? contatoSolicitante : `${contatoSolicitante}@c.us`;
                        const msgFeedback = `🔔 *ATUALIZAÇÃO DE PEDIDO*\n\nOlá *${data.solicitante || validPending.solicitante}*! O seu pedido de apoio *#${targetId}* acabou de ser avaliado.\n\n👤 *Apoio:* ${data.apoio || validPending.apoio}\n📊 *Status:* ${actionStatus}`;
                        await safeSend(client, formatId, msgFeedback);
                    } else {
                        console.log(`[AVISO] Não foi possível encontrar o ID_NUMBER do solicitante "${data.solicitante}" na folha WS_COMUNICACAO.`);
                    }
                } catch (err) {
                    console.error("[NOTIFY_ERR]", err);
                }
                
                // 3. Procura o próximo pedido
                const proximo = await getNextInBatch(cfg.spreadsheetId, cfg.sheetNameScheduling, data.solicitante, data.apoio);
                if (proximo) {
                    const nextMsg = `Encontrei outro pedido do mesmo solicitante (*${proximo.solicitante}*):\n\n🆔 *ID:* ${proximo.id}\n📝 *Detalhes:* ${proximo.detalhes}\n\nDeseja *CONFIRMAR* ou *RECUSAR*?`;
                    await simulateTyping(client, senderId, 2000);
                    await safeSend(client, senderId, nextMsg);
                } else {
                    await simulateTyping(client, senderId, 1000);
                    await safeSend(client, senderId, "Não restam mais pedidos pendentes deste lote. Obrigado! 🙏");
                }
                return true;
            }
        }
    } catch (e) { 
        console.error("[SCHED_ERR]", e); 
    }
    return false;
}

module.exports = { handleSchedulingFlow };