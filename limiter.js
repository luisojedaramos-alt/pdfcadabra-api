const pLimit = require('p-limit');

class QueueError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

// Limita cuántas tareas pesadas corren a la vez. p-limit aporta la cola FIFO y
// los huecos; aquí se añade lo que p-limit no tiene: tope de cola, timeout de
// espera, cancelación y posición en cola.
function createLimiter({ maxConcurrent, maxQueue, queueTimeoutMs }) {
    const limit = pLimit(maxConcurrent);
    const tickets = new Map(); // id -> ticket (solo en cola o ejecutando)
    const waiting = [];        // tickets en espera, en orden FIFO
    // Propio y síncrono: limit.activeCount de p-limit se actualiza de forma
    // asíncrona y justo tras un release aún cuenta el hueco como ocupado.
    let active = 0;

    const dropWaiting = (ticket) => {
        const i = waiting.indexOf(ticket);
        if (i !== -1) waiting.splice(i, 1);
    };

    // p-limit no permite sacar una tarea de su cola: se marca como cancelada y,
    // cuando le toque, libera el hueco al instante sin hacer nada.
    const cancelQueued = (ticket, err) => {
        if (ticket.state !== 'queued') return false;
        ticket.cancelled = true;
        ticket.state = 'cancelled';
        clearTimeout(ticket.timer);
        dropWaiting(ticket);
        tickets.delete(ticket.id);
        ticket.reject(err);
        return true;
    };

    const has = (id) => tickets.has(id);

    // Devuelve una promesa con `release` (idempotente). Rechaza con QueueError
    // QUEUE_FULL, QUEUE_TIMEOUT o CANCELLED.
    const acquire = (id) => {
        if (has(id)) {
            return Promise.reject(new QueueError('DUPLICATE_ID', `Id ya en uso: ${id}`));
        }
        if (waiting.length >= maxQueue && active >= maxConcurrent) {
            return Promise.reject(new QueueError('QUEUE_FULL', 'Cola de procesamiento llena.'));
        }

        return new Promise((resolve, reject) => {
            const ticket = { id, state: 'queued', cancelled: false, timer: null, reject };
            tickets.set(id, ticket);
            waiting.push(ticket);

            ticket.timer = setTimeout(() => {
                cancelQueued(ticket, new QueueError('QUEUE_TIMEOUT', 'Tiempo máximo de espera en cola agotado.'));
            }, queueTimeoutMs);

            limit(() => new Promise((freeSlot) => {
                if (ticket.cancelled) return freeSlot();
                clearTimeout(ticket.timer);
                dropWaiting(ticket);
                ticket.state = 'running';
                active++;

                let released = false;
                resolve(() => {
                    if (released) return;
                    released = true;
                    active--;
                    tickets.delete(id);
                    freeSlot();
                });
            }));
        });
    };

    // Saca de la cola una petición que aún no ha empezado (p. ej. el cliente se
    // desconectó). Si ya está ejecutando no hace nada: la libera su handler.
    const cancel = (id) => {
        const ticket = tickets.get(id);
        return ticket ? cancelQueued(ticket, new QueueError('CANCELLED', 'Petición cancelada.')) : false;
    };

    const getStatus = (id) => {
        const ticket = tickets.get(id);
        if (!ticket) return { state: 'unknown' };
        if (ticket.state === 'queued') return { state: 'queued', position: waiting.indexOf(ticket) + 1 };
        return { state: 'running' };
    };

    return { acquire, cancel, has, getStatus };
}

module.exports = { createLimiter, QueueError };
