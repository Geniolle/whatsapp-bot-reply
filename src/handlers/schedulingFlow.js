//###################################################################################
// src/handlers/schedulingFlow.js - VERSÃO COM FEEDBACK AO SOLICITANTE
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

        // 4. Lógica de decisão
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
            
            // Aqui ele vai ao Excel guardar o estado
            const data = await updateStatusById({ spreadsheetId: cfg.spreadsheetId, requestId: targetId, newStatus: actionStatus });
            
            if (data) {
                // 1. Avisa o Apoio (o líder)
                await simulateTyping(client, senderId, 1000);
                await safeSend(client, senderId, `✅ Feito! O pedido *#${targetId}* foi marcado como *${actionStatus.toUpperCase()}*.`);
                
                // 👇 2. NOVO: AVISA O SOLICITANTE (Feedback) 👇
                try {
                    // Ele tenta usar a coluna do telefone/chatId que vier do Excel (data)
                    const contatoSolicitante = data.chatIdSolicitante || data.telefoneSolicitante || data.telefone || validPending.telefoneSolicitante; 
                    
                    if (contatoSolicitante) {
                        // Garante que o ID tem a terminação do WhatsApp
                        const formatId = String(contatoSolicitante).includes('@c.us') ? contatoSolicitante : `${contatoSolicitante}@c.us`;
                        
                        const msgFeedback = `🔔 *ATUALIZAÇÃO DE PEDIDO*\n\nOlá *${data.solicitante || 'Líder'}*! O seu pedido de apoio *#${targetId}* acabou de ser avaliado.\n\n👤 *Apoio:* ${data.apoio || validPending.apoio}\n📊 *Status:* ${actionStatus}`;
                        
                        // Envia a mensagem para o telemóvel de quem pediu!
                        await safeSend(client, formatId, msgFeedback);
                    } else {
                        console.log(`[AVISO] Pedido #${targetId} alterado, mas não encontrámos a coluna com o número de WhatsApp do solicitante no Excel para lhe enviar o feedback.`);
                    }
                } catch (err) {
                    console.error("[NOTIFY_ERR]", err);
                }
                // 👆 FIM DA NOVIDADE 👆
                
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