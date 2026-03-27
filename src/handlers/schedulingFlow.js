//###################################################################################
// src/handlers/schedulingFlow.js - VERSÃO BLINDADA PARA CONFIRMAÇÕES
//###################################################################################
"use strict";

const { findAllPendingByLeader, updateStatusById, getNextInBatch } = require("../services/appScheduling");
const { simulateTyping, safeSend } = require("./onMessageUtils");

async function handleSchedulingFlow(client, senderId, dbId, bodyRaw, cfg) {
    const textNorm = bodyRaw.trim().toLowerCase();
    try {
        const pendings = await findAllPendingByLeader({ spreadsheetId: cfg.spreadsheetId, leaderChatId: dbId });
        if (pendings.length === 0) return false;

        // 1. Extraímos o número (se existir)
        const requestIdFromMsg = bodyRaw.replace(/\D/g, "");
        
        // 2. Extraímos apenas a palavra
        const textNoNum = textNorm.replace(/[0-9]/g, "").trim(); 
        
        // 3. Verificamos se o utilizador enviou APENAS um número
        const isNumericOnly = /^\d+$/.test(textNorm);

        // 4. Nova lógica com suporte robusto (confirma, confirmo, confirmar)
        const isConfirm = /^(confirmar|confirma|confirmo|aceitar|aceito|ok|sim)$/i.test(textNoNum) || isNumericOnly;
        const isReject = /^(recusar|recuso|nao|não)$/i.test(textNoNum);
        
        if (!isConfirm && !isReject) return false;

        let targetId = null;
        
        if (pendings.length === 1 && !requestIdFromMsg) {
            targetId = pendings[0].id; // Só tem um, auto-seleciona
        } 
        else if (requestIdFromMsg) {
            targetId = requestIdFromMsg; // Tem número na mensagem, usa-o
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
                await simulateTyping(client, senderId, 1000);
                await safeSend(client, senderId, `✅ Feito! O pedido *#${targetId}* foi marcado como *${actionStatus.toUpperCase()}*.`);
                
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