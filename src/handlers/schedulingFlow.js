"use strict";

const { findAllPendingByLeader, updateStatusById, getNextInBatch } = require("../services/appScheduling");
const { simulateTyping, safeSend } = require("./onMessageUtils");

async function handleSchedulingFlow(client, senderId, dbId, bodyRaw, cfg) {
    const textNorm = bodyRaw.trim().toLowerCase();
    try {
        const pendings = await findAllPendingByLeader({ spreadsheetId: cfg.spreadsheetId, leaderChatId: dbId });
        if (pendings.length === 0) return false;

        const isConfirm = ["confirmar", "confirmo", "aceito", "ok", "sim"].includes(textNorm);
        const isReject = ["recusar", "recuso", "nao", "não"].includes(textNorm);
        const requestIdFromMsg = bodyRaw.replace(/\D/g, "");

        let targetId = null;
        if (pendings.length === 1) targetId = pendings[0].id;
        else if (requestIdFromMsg) targetId = requestIdFromMsg;

        if (targetId && (isConfirm || isReject)) {
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
                    await safeSend(client, senderId, "Não restam mais pedidos pendentes deste lote. Obrigado! 🙏");
                }
                return true;
            }
        }
    } catch (e) { console.error("[SCHED_ERR]", e); }
    return false;
}

module.exports = { handleSchedulingFlow };