//###################################################################################
// src/utils/permissions.js - MOTOR DE CONTROLO DE ACESSOS (RBAC)
//###################################################################################
"use strict";

function normalizeString(s) {
    return String(s || "").trim().toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Remove automaticamente prefixos como "D." ou "D " para facilitar o cruzamento
 */
function stripDeptPrefix(s) {
    let str = normalizeString(s);
    if (str.startsWith("D.") || str.startsWith("D ")) {
        str = str.substring(2).trim();
    }
    return str;
}

/**
 * Verifica se o utilizador tem acesso ao departamento exigido pela regra.
 */
function checkDepartmentAccess(userDepts, requiredDeptStr) {
    const reqStr = normalizeString(requiredDeptStr);
    
    // Acesso livre se a célula estiver vazia ou for pública
    if (!reqStr || reqStr === "TODOS" || reqStr === "PUBLIC" || reqStr === "NENHUM") {
        return { hasAccess: true };
    }

    // Limpa os departamentos da planilha (Ex: "D. LOUVOR; D. COMUNICAÇÃO" -> ["LOUVOR", "COMUNICACAO"])
    const requiredDepts = reqStr.split(/[;,|]+/).map(d => stripDeptPrefix(d)).filter(Boolean);
    
    // Limpa os departamentos que o utilizador tem atribuídos
    const userDeptNames = (userDepts || []).map(d => {
        const name = typeof d === 'object' ? d.nome : d;
        return stripDeptPrefix(name);
    });

    // Bate as duas listas para ver se há correspondência
    const hasAccess = requiredDepts.some(reqDept => userDeptNames.includes(reqDept));

    return { 
        hasAccess, 
        missingDept: requiredDeptStr 
    };
}

module.exports = { checkDepartmentAccess };