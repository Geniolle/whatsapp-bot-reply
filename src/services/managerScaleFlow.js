//###################################################################################
// src/services/managerScaleFlow.js - FLUXO CONVERSACIONAL DE ESCALA PARA MANAGERS
//###################################################################################
"use strict";

const { getDialogState, setDialogState, clearDialogState } = require("./memoryManager");
const { getMinhasEscalas_v1 } = require("./appEscala");
const { getEscalaEquipePorDepartamento_v1 } = require("./appEscalaEquipe");

//###################################################################################
// Helpers
//###################################################################################
function normalizeText(v) {
  return String(v || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function normalizeDept(v) {
  return normalizeText(v)
    .replace(/^D\.\s*/i, "")
    .replace(/^D\s+/i, "")
    .trim();
}

function detectInitialScaleIntent(v) {
  const s = normalizeText(v);

  const hasTeam =
    s.includes("EQUIPA") ||
    s.includes("MINHA EQUIPA") ||
    s.includes("DEPARTAMENTO") ||
    s.includes("DA EQUIPA") ||
    s.includes("DO DEPARTAMENTO") ||
    s.includes("TIME");

  const hasOwn =
    s.includes("ESTOU ESCALADO") ||
    s.includes("ESTOU ESCALADA") ||
    s.includes("MEUS DIAS") ||
    s.includes("MINHA ESCALA") ||
    s.includes("MINHAS ESCALAS") ||
    s.includes("EU ESTOU") ||
    s.includes("QUE ESTOU ESCALADO") ||
    s.includes("QUE ESTOU ESCALADA");

  if (hasTeam) return "TEAM";
  if (hasOwn) return "OWN";

  return "ASK";
}

function parseScopeChoice(v) {
  const s = normalizeText(v);

  if (
    s.includes("MINHA") ||
    s.includes("MINHAS") ||
    s.includes("PROPRIA") ||
    s.includes("PROPRIAS") ||
    s === "EU" ||
    s === "1"
  ) {
    return "OWN";
  }

  if (
    s.includes("EQUIPA") ||
    s.includes("TIME") ||
    s.includes("DEPARTAMENTO") ||
    s.includes("DA EQUIPA") ||
    s === "2"
  ) {
    return "TEAM";
  }

  return "";
}

function parseMonthNameToNumber(v) {
  const s = normalizeText(v);

  const map = {
    JANEIRO: 1,
    FEVEREIRO: 2,
    MARCO: 3,
    ABRIL: 4,
    MAIO: 5,
    JUNHO: 6,
    JULHO: 7,
    AGOSTO: 8,
    SETEMBRO: 9,
    OUTUBRO: 10,
    NOVEMBRO: 11,
    DEZEMBRO: 12,
  };

  for (const [name, num] of Object.entries(map)) {
    if (s.includes(name)) return num;
  }

  return 0;
}

function monthNamePt(monthNumber) {
  const names = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
  ];
  return names[(monthNumber || 1) - 1] || "";
}

function parsePeriodChoice(v) {
  const raw = String(v || "").trim();
  const s = normalizeText(v);

  if (
    s.includes("PROXIMO CULTO") ||
    s.includes("PRÓXIMO CULTO") ||
    s === "PROXIMO" ||
    s === "PRÓXIMO" ||
    s === "1"
  ) {
    return { ok: true, periodo: { type: "NEXT_CULTO" }, label: "Próximo culto" };
  }

  const mDate = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mDate) {
    return {
      ok: true,
      periodo: { type: "DATE", date: raw },
      label: raw,
    };
  }

  if (s === "HOJE") {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const yyyy = String(now.getFullYear());
    const dt = `${dd}/${mm}/${yyyy}`;

    return {
      ok: true,
      periodo: { type: "DATE", date: dt },
      label: dt,
    };
  }

  const mMonthYear = raw.match(/^(\d{1,2})\/(\d{4})$/);
  if (mMonthYear) {
    const month = Number(mMonthYear[1]);
    const year = Number(mMonthYear[2]);

    if (month >= 1 && month <= 12) {
      return {
        ok: true,
        periodo: { type: "MONTH", month, year },
        label: `${monthNamePt(month)}/${year}`,
      };
    }
  }

  const monthNumber = parseMonthNameToNumber(raw);
  if (monthNumber > 0) {
    const yearMatch = raw.match(/\b(20\d{2})\b/);
    const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();

    return {
      ok: true,
      periodo: { type: "MONTH", month: monthNumber, year },
      label: `${monthNamePt(monthNumber)}/${year}`,
    };
  }

  if (s === "3" || s.includes("MES") || s.includes("MÊS")) {
    return { ok: false, needsMonthDetail: true };
  }

  return { ok: false };
}

function buildDepartmentQuestion(managerDepts) {
  const lines = [];
  lines.push("És manager de mais do que um departamento.");
  lines.push("Para qual departamento queres ver a escala da equipa?");
  lines.push("");

  managerDepts.forEach((d, i) => {
    lines.push(`${i + 1}. ${d}`);
  });

  lines.push("");
  lines.push("Podes responder com o nome do departamento ou com o número da lista.");

  return lines.join("\n");
}

function buildPeriodQuestion(departamento) {
  return (
    `Perfeito. Vamos analisar a equipa do departamento *${departamento}*.\n\n` +
    `Qual o período da análise?\n\n` +
    `1. Próximo culto\n` +
    `2. Um dia específico (responde no formato DD/MM/AAAA)\n` +
    `3. Um mês específico (ex: Maio ou 05/2026)`
  );
}

function resolveDepartmentChoice(bodyRaw, managerDepts) {
  const raw = String(bodyRaw || "").trim();
  const norm = normalizeDept(raw);

  const asNumber = Number(raw);
  if (!Number.isNaN(asNumber) && asNumber >= 1 && asNumber <= managerDepts.length) {
    return managerDepts[asNumber - 1];
  }

  const found = managerDepts.find((d) => normalizeDept(d) === norm);
  return found || "";
}

//###################################################################################
// Início do fluxo
//###################################################################################
async function startEscalaFlow_v1({
  chatId,
  accData,
  cfg,
  bodyRaw,
}) {
  const isManager = !!accData?.isManager;
  const managerDepts = accData?.managerDepts || [];

  if (!isManager || !managerDepts.length) {
    return { handled: false };
  }

  const initialIntent = detectInitialScaleIntent(bodyRaw);

  if (initialIntent === "OWN") {
    const sheetNameBpService = String(cfg?.sheetNameBp || process.env.SHEET_NAME_BP || process.env.SHEET_NAME_BP_SERVICE || "").trim();
    const sheetNameEscala = String(process.env.SHEET_NAME_ESCALA || "BP ESCALA").trim();

    const rawText = await getMinhasEscalas_v1({
      spreadsheetId: cfg.spreadsheetId,
      sheetNameBpService,
      sheetNameEscala,
      chatId,
    });

    return {
      handled: true,
      rawText,
      origem: "DB_ESCALAS",
      processTag: "__ESCALAS__",
      matchedRuleOverride: "__ESCALAS__",
    };
  }

  if (initialIntent === "TEAM") {
    if (managerDepts.length === 1) {
      const departamento = managerDepts[0];

      setDialogState(chatId, {
        flow: "ESCALA_MANAGER",
        step: "AWAIT_PERIOD",
        selectedDept: departamento,
      });

      return {
        handled: true,
        rawText: buildPeriodQuestion(departamento),
        origem: "FLOW_ESCALA_MANAGER_PERIOD",
      };
    }

    setDialogState(chatId, {
      flow: "ESCALA_MANAGER",
      step: "AWAIT_DEPARTMENT",
    });

    return {
      handled: true,
      rawText: buildDepartmentQuestion(managerDepts),
      origem: "FLOW_ESCALA_MANAGER_DEPARTMENT",
    };
  }

  setDialogState(chatId, {
    flow: "ESCALA_MANAGER",
    step: "AWAIT_SCOPE",
  });

  return {
    handled: true,
    rawText:
      "Queres ver a *tua própria escala* ou a *escala da equipa*?\n\n" +
      "1. Minhas escalas\n" +
      "2. Escala da equipa",
    origem: "FLOW_ESCALA_MANAGER_SCOPE",
  };
}

//###################################################################################
// Continuação do fluxo
//###################################################################################
async function handlePendingEscalaFlow_v1({
  chatId,
  bodyRaw,
  accData,
  cfg,
}) {
  const state = getDialogState(chatId);
  if (!state || state.flow !== "ESCALA_MANAGER") {
    return { handled: false };
  }

  const managerDepts = accData?.managerDepts || [];

  if (state.step === "AWAIT_SCOPE") {
    const scope = parseScopeChoice(bodyRaw);

    if (!scope) {
      return {
        handled: true,
        rawText:
          "Não percebi. Queres ver a *tua própria escala* ou a *escala da equipa*?\n\n" +
          "1. Minhas escalas\n" +
          "2. Escala da equipa",
        origem: "FLOW_ESCALA_MANAGER_SCOPE_REASK",
      };
    }

    if (scope === "OWN") {
      clearDialogState(chatId);

      const sheetNameBpService = String(cfg?.sheetNameBp || process.env.SHEET_NAME_BP || process.env.SHEET_NAME_BP_SERVICE || "").trim();
      const sheetNameEscala = String(process.env.SHEET_NAME_ESCALA || "BP ESCALA").trim();

      const rawText = await getMinhasEscalas_v1({
        spreadsheetId: cfg.spreadsheetId,
        sheetNameBpService,
        sheetNameEscala,
        chatId,
      });

      return {
        handled: true,
        rawText,
        origem: "DB_ESCALAS",
        processTag: "__ESCALAS__",
        matchedRuleOverride: "__ESCALAS__",
      };
    }

    if (scope === "TEAM") {
      if (managerDepts.length === 1) {
        const departamento = managerDepts[0];
        setDialogState(chatId, {
          flow: "ESCALA_MANAGER",
          step: "AWAIT_PERIOD",
          selectedDept: departamento,
        });

        return {
          handled: true,
          rawText: buildPeriodQuestion(departamento),
          origem: "FLOW_ESCALA_MANAGER_PERIOD",
        };
      }

      setDialogState(chatId, {
        flow: "ESCALA_MANAGER",
        step: "AWAIT_DEPARTMENT",
      });

      return {
        handled: true,
        rawText: buildDepartmentQuestion(managerDepts),
        origem: "FLOW_ESCALA_MANAGER_DEPARTMENT",
      };
    }
  }

  if (state.step === "AWAIT_DEPARTMENT") {
    const departamento = resolveDepartmentChoice(bodyRaw, managerDepts);

    if (!departamento) {
      return {
        handled: true,
        rawText: buildDepartmentQuestion(managerDepts),
        origem: "FLOW_ESCALA_MANAGER_DEPARTMENT_REASK",
      };
    }

    setDialogState(chatId, {
      flow: "ESCALA_MANAGER",
      step: "AWAIT_PERIOD",
      selectedDept: departamento,
    });

    return {
      handled: true,
      rawText: buildPeriodQuestion(departamento),
      origem: "FLOW_ESCALA_MANAGER_PERIOD",
    };
  }

  if (state.step === "AWAIT_PERIOD") {
    const departamento = state.selectedDept || "";
    const parsed = parsePeriodChoice(bodyRaw);

    if (!departamento) {
      clearDialogState(chatId);
      return {
        handled: true,
        rawText: "O fluxo da escala da equipa expirou. Podes pedir novamente a escala.",
        origem: "FLOW_ESCALA_MANAGER_RESET",
      };
    }

    if (!parsed.ok) {
      return {
        handled: true,
        rawText:
          `Não percebi o período.\n\n` +
          buildPeriodQuestion(departamento),
        origem: "FLOW_ESCALA_MANAGER_PERIOD_REASK",
      };
    }

    clearDialogState(chatId);

    const rawText = await getEscalaEquipePorDepartamento_v1({
      spreadsheetId: cfg.spreadsheetId,
      sheetNameFuncoes: String(process.env.SHEET_NAME_BP_FUNCAO || "BP FUNÇÃO").trim(),
      sheetNameEscala: String(process.env.SHEET_NAME_ESCALA || "BP ESCALA").trim(),
      departamento,
      periodo: parsed.periodo,
    });

    return {
      handled: true,
      rawText,
      origem: "DB_ESCALA_EQUIPE",
      processTag: "__ESCALAS__",
      matchedRuleOverride: "__ESCALAS__",
    };
  }

  return { handled: false };
}

module.exports = {
  startEscalaFlow_v1,
  handlePendingEscalaFlow_v1,
};