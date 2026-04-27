//###################################################################################
// src/handlers/processDispatcher.js - ORQUESTRADOR DE REGRAS DE NEGÓCIO (SRP)
//###################################################################################
"use strict";

const audit = require("../services/audit");
const lockManager = require("../services/lockManager");

/**
 * Roteia a intenção detetada para o serviço correspondente.
 * Implementa Lock por utilizador/processo para evitar sobrecarga de I/O em duplicado.
 */
async function executeProcess(aiData, bodyRaw, cfg, isColab, dbId, fullName, accData) {
    let rawText = "";
    let origem = "AI_GENERICA";
    
    // Chave de lock específica para processos de I/O (evita que o mesmo utilizador dispare 2 pesquisas)
    const processLockKey = `proc_${dbId}`;

    try {
        // 1. PESQUISA GERAL DE LIVRARIA
        if (
            aiData?.processo === "LIVRARIA" ||
            (aiData?.processo?.includes("LIVRARIA") &&
                !aiData?.processo?.includes("AUTORES") &&
                !aiData?.processo?.includes("EDITORAS") &&
                !aiData?.processo?.includes("PESQUISA_"))
        ) {
            if (!lockManager.acquire(processLockKey)) return { rawText: "Já estou a pesquisar os livros para ti, um momento...", origem: "WAIT_LOCK" };
            
            try {
                const libService = require("../services/appLivraria");
                const targetSheet = (cfg.sheetNameLivraria || process.env.SHEET_NAME_LIVRARIA || "DB_STOCK").trim();
                const livrariaSpreadsheetId = process.env.SPREADSHEET_LIVRARIA_ID || cfg.spreadsheetLivrariaId;

                if (!livrariaSpreadsheetId) throw new Error("SPREADSHEET_LIVRARIA_ID ausente");

                const termoFinal = aiData.termo ?? bodyRaw;
                rawText = await libService.getLivrosEmStock_v1({
                    spreadsheetId: livrariaSpreadsheetId,
                    sheetName: targetSheet,
                    searchTerm: termoFinal
                });
                origem = "DB_LIVRARIA";
            } finally {
                lockManager.release(processLockKey);
            }
        }

        // 2. LISTAGEM DE AUTORES OU EDITORAS
        else if (aiData?.processo === "__APP_LIVRARIA_AUTORES__" || aiData?.processo === "__APP_LIVRARIA_EDITORAS__") {
            const libService = require("../services/appLivraria");
            const livrariaSpreadsheetId = process.env.SPREADSHEET_LIVRARIA_ID || cfg.spreadsheetLivrariaId;
            const tipoLista = aiData.processo === "__APP_LIVRARIA_AUTORES__" ? "AUTORES" : "EDITORAS";

            rawText = await libService.getListasLivraria_v1({
                spreadsheetId: livrariaSpreadsheetId,
                sheetName: (cfg.sheetNameLivraria || "DB_STOCK").trim(),
                tipo: tipoLista
            });
            origem = `DB_LIVRARIA_${tipoLista}`;
        }

        // 4. AUSÊNCIAS / FÉRIAS
        else if (aiData?.processo === "__AUSENCIAS__") {
            try {
                const ausenciasService = require("../services/appAusencias");
                rawText = await ausenciasService.getMinhasAusencias_v1({
                    chatId: dbId,
                    fullName: fullName
                });
                origem = "DB_AUSENCIAS";
            } catch (e) {
                audit.error("PROC_AUSENCIAS", e.message, { dbId });
                rawText = "Ocorreu um erro ao consultar as tuas ausências.";
            }
        }

        // 5. ENSAIO
        else if (aiData?.processo === "__APP_ENSAIO__") {
            try {
                const mod = require("../services/appEnsaio");
                const sheetNameEnsaio = String(cfg?.sheetNameEnsaio || process.env.SHEET_NAME_ENSAIO || "").trim();

                const out = await mod.getLatestEnsaio_v1({
                    spreadsheetId: cfg.spreadsheetId,
                    sheetNameEnsaio
                });

                if (typeof out === "string") {
                    rawText = out;
                } else {
                    const data = out?.ENSAIO || out?.data || "—";
                    const responsavel = out?.RESPONSÁVEL || out?.responsavel || "—";
                    rawText = `O próximo ensaio está marcado para ${data} com o líder ${responsavel}.`;
                }
                origem = "DB_ENSAIO";
            } catch (e) {
                audit.error("PROC_ENSAIO", e.message);
                rawText = "Não consegui verificar os ensaios agora.";
            }
        }

        // 6. AGENDA
        else if (aiData?.processo === "__APP_AGENDA_FULL__") {
            const mod = require("../services/appAgenda");
            const payload = await mod.getAgendaDepartamentos_v1({
                spreadsheetId: cfg.spreadsheetId,
                sheetNameAgenda: cfg.sheetNameAgenda,
                cacheSeconds: cfg.cacheAgendaSeconds
            });
            rawText = mod.formatAgendaDepartamentosText_v1(payload, "Europe/Lisbon");
            origem = "DB_AGENDA";
        }

        // 7. ESCALAS
        else if (aiData?.processo === "__ESCALAS__" || aiData?.processo === "__ESCALA__") {
            if (!lockManager.acquire(processLockKey)) return { rawText: "Estou a verificar a tua escala, um segundo...", origem: "WAIT_LOCK" };
            
            try {
                const escalaService = require("../services/appEscala");
                const managerScaleFlow = require("../services/managerScaleFlow");

                if (accData?.isManager) {
                    const flowStart = await managerScaleFlow.startEscalaFlow_v1({
                        chatId: dbId, accData, cfg, bodyRaw
                    });
                    if (flowStart?.handled) return { rawText: flowStart.rawText, origem: flowStart.origem };
                }

                rawText = await escalaService.getMinhasEscalas_v1({
                    spreadsheetId: cfg.spreadsheetId,
                    sheetNameBpService: cfg.sheetNameBp,
                    sheetNameEscala: process.env.SHEET_NAME_ESCALA || "BP ESCALA",
                    chatId: dbId
                });
                origem = "DB_ESCALAS";
            } finally {
                lockManager.release(processLockKey);
            }
        }

    } catch (error) {
        audit.error("PROCESS_DISPATCHER", `Falha crítica no processo ${aiData?.processo}`, { error: error.message });
        rawText = "Tive um problema ao aceder à base de dados. Podes tentar daqui a pouco?";
    }

    return { rawText, origem };
}

module.exports = { executeProcess };