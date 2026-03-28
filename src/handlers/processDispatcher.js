//###################################################################################
// src/handlers/processDispatcher.js - ORQUESTRADOR DE REGRAS DE NEGÓCIO (SRP)
//###################################################################################
"use strict";

const { logAudit } = require("../services/auditLogger");

/**
 * Roteia a intenção detetada para o serviço correspondente (Livraria, Ausências, Ensaios, etc.)
 */
async function executeProcess(aiData, bodyRaw, cfg, isColab, dbId, fullName) {
    let rawText = "";
    let origem = "AI_GENERICA";

    // 1. PESQUISA GERAL DE LIVRARIA
    if (
        aiData?.processo === "LIVRARIA" || 
        (aiData?.processo?.includes("LIVRARIA") && !aiData?.processo?.includes("AUTORES") && !aiData?.processo?.includes("EDITORAS") && !aiData?.processo?.includes("PESQUISA_"))
    ) {
        try {
            const libService = require("../services/appLivraria");
            const targetSheet = (cfg.sheetNameLivraria || process.env.SHEET_NAME_LIVRARIA || "DB_STOCK").trim();
            const livrariaSpreadsheetId = process.env.SPREADSHEET_LIVRARIA_ID || cfg.spreadsheetLivrariaId;

            if (!livrariaSpreadsheetId) throw new Error("SPREADSHEET_LIVRARIA_ID não configurado no .env");

            const termoFinal = (aiData.termo !== undefined && aiData.termo !== null) ? aiData.termo : bodyRaw;

            rawText = await libService.getLivrosEmStock_v1({
                spreadsheetId: livrariaSpreadsheetId,
                sheetName: targetSheet,
                searchTerm: termoFinal
            });
            origem = "DB_LIVRARIA";
        } catch (e) {
            logAudit({ type: "ERRO", error: `Proc Livraria: ${e.message}`, isColab });
        }
    } 
    // 2. LISTAGEM DE AUTORES OU EDITORAS
    else if (aiData?.processo === "__APP_LIVRARIA_AUTORES__" || aiData?.processo === "__APP_LIVRARIA_EDITORAS__") {
        try {
            const libService = require("../services/appLivraria");
            const targetSheet = (cfg.sheetNameLivraria || process.env.SHEET_NAME_LIVRARIA || "DB_STOCK").trim();
            const livrariaSpreadsheetId = process.env.SPREADSHEET_LIVRARIA_ID || cfg.spreadsheetLivrariaId;

            if (!livrariaSpreadsheetId) throw new Error("SPREADSHEET_LIVRARIA_ID não configurado no .env");

            const tipoLista = aiData.processo === "__APP_LIVRARIA_AUTORES__" ? "AUTORES" : "EDITORAS";

            rawText = await libService.getListasLivraria_v1({
                spreadsheetId: livrariaSpreadsheetId,
                sheetName: targetSheet,
                tipo: tipoLista
            });
            origem = `DB_LIVRARIA_${tipoLista}`;
        } catch (e) {
            logAudit({ type: "ERRO", error: `Proc Livraria Listas: ${e.message}`, isColab });
        }
    }
    // 3. PESQUISA EXCLUSIVA POR AUTOR OU EDITORA
    else if (aiData?.processo === "__APP_LIVRARIA_PESQUISA_AUTOR__" || aiData?.processo === "__APP_LIVRARIA_PESQUISA_EDITORA__") {
        try {
            const libService = require("../services/appLivraria");
            const targetSheet = (cfg.sheetNameLivraria || process.env.SHEET_NAME_LIVRARIA || "DB_STOCK").trim();
            const livrariaSpreadsheetId = process.env.SPREADSHEET_LIVRARIA_ID || cfg.spreadsheetLivrariaId;

            if (!livrariaSpreadsheetId) throw new Error("SPREADSHEET_LIVRARIA_ID não configurado no .env");

            const tipoFiltro = aiData.processo === "__APP_LIVRARIA_PESQUISA_AUTOR__" ? "AUTOR" : "EDITORA";
            const termoFinalExclusivo = (aiData.termo !== undefined && aiData.termo !== null) ? aiData.termo : bodyRaw;

            rawText = await libService.getLivrosExclusivos_v1({
                spreadsheetId: livrariaSpreadsheetId,
                sheetName: targetSheet,
                tipoFiltro: tipoFiltro,
                termoPesquisa: termoFinalExclusivo
            });
            origem = `DB_LIVRARIA_EXCLUSIVO_${tipoFiltro}`;
        } catch (e) {
            logAudit({ type: "ERRO", error: `Proc Livraria Exclusiva: ${e.message}`, isColab });
        }
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
            logAudit({ type: "ERRO", error: `Proc Ausências: ${e.message}`, isColab });
            rawText = "Desculpa, ocorreu um erro ao consultar as tuas ausências na base de dados.";
        }
    }
    // 5. ENSAIO (NOVO/MIGRADO)
    else if (aiData?.processo === "__APP_ENSAIO__") {
        try {
            const mod = require("../services/appEnsaio");
            const sheetNameEnsaio = String(cfg?.sheetNameEnsaio || process.env.SHEET_NAME_ENSAIO || "").trim();
            
            if (!sheetNameEnsaio) throw new Error("Aba de Ensaios não configurada.");

            const out = await mod.getLatestEnsaio_v1({ 
                spreadsheetId: cfg.spreadsheetId, 
                sheetNameEnsaio 
            });

            if (typeof out === "string" && out.trim()) {
                rawText = out.trim();
            } else {
                const data = String(out?.ENSAIO || out?.data || out?.DATA || "").trim();
                const horarioRaw = String(out?.HORARIO || out?.horario || out?.HORA || out?.["HORÁRIO"] || "").trim();
                const responsavel = String(out?.["RESPONSÁVEL"] || out?.RESPONSAVEL || out?.responsavel || "").trim();
                
                let horario = horarioRaw;
                const m = horarioRaw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
                if (m) horario = `${m[1].padStart(2, "0")}:${m[2]}`;
                
                if (data || horario || responsavel) {
                    rawText = `A data do último ensaio no sistema é no dia ${data || "—"} às ${horario || "—"} horas e o responsável é o vocal líder ${responsavel || "—"}.`;
                } else {
                    rawText = "Não encontrei informações de ensaio neste momento.";
                }
            }
            origem = "DB_ENSAIO";
        } catch (e) {
            logAudit({ type: "ERRO", error: `Proc Ensaio: ${e.message}`, isColab });
            rawText = "Não consegui consultar o ensaio neste momento.";
        }
    }
    // 6. AGENDA (NOVO/MIGRADO)
    else if (aiData?.processo === "__APP_AGENDA_FULL__") {
        try {
            const mod = require("../services/appAgenda");
            const sheetNameAgenda = String(cfg?.sheetNameAgenda || process.env.SHEET_NAME_AGENDA || "").trim();
            
            if (!sheetNameAgenda) throw new Error("Aba de Agenda não configurada.");

            const payload = await mod.getAgendaDepartamentos_v1({ 
                spreadsheetId: cfg.spreadsheetId, 
                sheetNameAgenda, 
                cacheSeconds: cfg.cacheAgendaSeconds, 
                timeZone: "Europe/Lisbon" 
            });
            rawText = mod.formatAgendaDepartamentosText_v1(payload, "Europe/Lisbon");
            origem = "DB_AGENDA";
        } catch (e) {
            logAudit({ type: "ERRO", error: `Proc Agenda: ${e.message}`, isColab });
            rawText = "Não consegui consultar a agenda dos departamentos neste momento.";
        }
    }
    
    return { rawText, origem };
}

module.exports = { executeProcess };