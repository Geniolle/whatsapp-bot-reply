//###################################################################################
// src/handlers/schedulingFlow.js - VERSÃO DIRETA COM FIX DE MINÚSCULAS
//###################################################################################
"use strict";

const { findAllPendingByLeader, updateStatusById, getNextInBatch } = require("../services/appScheduling");
const { simulateTyping, safeSend } = require("./onMessageUtils");

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
                    // 👇 A MÁGICA ESTÁ AQUI: Vai buscar diretamente à sua coluna ID_NUMBER considerando a limpeza do normHeader 👇
                    const contatoSolicitante = data.idnumber || validPending.idnumber || data.ID_NUMBER || data.id_number || data.idNumber || validPending.ID_NUMBER || validPending.id_number || validPending.idNumber;
                    
                    if (contatoSolicitante) {
                        // Limpa o "+" (caso exista) e garante a formatação correta para o WhatsApp
                        const numeroLimpo = String(contatoSolicitante).replace('+', '').trim();
                        const formatId = numeroLimpo.includes('@c.us') ? numeroLimpo : `${numeroLimpo}@c.us`;
                        
                        const msgFeedback = `🔔 *ATUALIZAÇÃO DE PEDIDO*\n\nOlá *${data.solicitante || validPending.solicitante}*! O seu pedido de apoio *#${targetId}* acabou de ser avaliado.\n\n👤 *Apoio:* ${data.apoio || validPending.apoio}\n📊 *Status:* ${actionStatus}`;
                        await safeSend(client, formatId, msgFeedback);
                    } else {
                        console.log(`[AVISO] Coluna ID_NUMBER não encontrada ou vazia para o pedido #${targetId}.`);
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