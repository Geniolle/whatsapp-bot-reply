//###################################################################################
// src/services/lockManager.js
//###################################################################################
"use strict";

const audit = require("./audit");

/**
 * Gerenciador de Travas (Locks) para evitar execuções duplicadas
 */
class LockManager {
    constructor() {
        this.locks = new Set();
    }

    /**
     * Tenta adquirir uma trava para uma tarefa específica
     * @param {string} key - Chave única (ex: userId + taskName)
     * @returns {boolean} - True se conseguiu a trava, False se já estiver ocupado
     */
    acquire(key) {
        if (this.locks.has(key)) {
            audit.warn("LOCK_SYSTEM", `Tentativa de execução duplicada bloqueada para: ${key}`);
            return false;
        }
        this.locks.add(key);
        audit.info("LOCK_SYSTEM", `Trava adquirida: ${key}`);
        return true;
    }

    /**
     * Liberta a trava
     * @param {string} key 
     */
    release(key) {
        this.locks.delete(key);
        audit.info("LOCK_SYSTEM", `Trava libertada: ${key}`);
    }
}

module.exports = new LockManager();