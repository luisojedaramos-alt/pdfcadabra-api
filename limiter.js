class QueueError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

// Limita cuántas tareas pesadas corren a la vez: maxConcurrent huecos, cola FIFO con tope,
// timeout de espera, cancelación y posición en cola. Cada tarea ocupa `weight` huecos (un
// archivo grande ocupa dos; nunca más de maxConcurrent). La cola es FIFO estricta: si la
// primera no cabe, esperan también las de detrás, aunque quepan (si no, una tarea de dos
// huecos podía esperar para siempre detrás de las de uno).
function createLimiter({ maxConcurrent, maxQueue, queueTimeoutMs }) {
    const tickets = new Map(); // id -> ticket (solo en cola o ejecutando)
    const waiting = [];        // tickets en espera, en orden FIFO
    let used = 0;              // huecos ocupados

    const dropWaiting = (ticket) => {
        const i = waiting.indexOf(ticket);
        if (i !== -1) waiting.splice(i, 1);
    };

    const start = (ticket) => {
        clearTimeout(ticket.timer);
        ticket.state = 'running';
        used += ticket.weight;
        let released = false;
        ticket.resolve(() => {
            if (released) return;
            released = true;
            used -= ticket.weight;
            tickets.delete(ticket.id);
            drain();
        });
    };

    // Arranca las primeras de la cola mientras quepan.
    const drain = () => {
        while (waiting.length > 0 && used + waiting[0].weight <= maxConcurrent) start(waiting.shift());
    };

    const cancelQueued = (ticket, err) => {
        if (ticket.state !== 'queued') return false;
        ticket.state = 'cancelled';
        clearTimeout(ticket.timer);
        dropWaiting(ticket);
        tickets.delete(ticket.id);
        ticket.reject(err);
        // Si era la primera y no cabía, las de detrás quizá sí.
        drain();
        return true;
    };

    const has = (id) => tickets.has(id);

    // Devuelve una promesa con `release` (idempotente). Rechaza con QueueError
    // QUEUE_FULL, QUEUE_TIMEOUT o CANCELLED.
    const acquire = (id, weight = 1) => {
        if (has(id)) {
            return Promise.reject(new QueueError('DUPLICATE_ID', `Id ya en uso: ${id}`));
        }
        const w = Math.min(Math.max(1, weight), maxConcurrent);
        const fitsNow = waiting.length === 0 && used + w <= maxConcurrent;
        if (!fitsNow && waiting.length >= maxQueue) {
            return Promise.reject(new QueueError('QUEUE_FULL', 'Cola de procesamiento llena.'));
        }

        return new Promise((resolve, reject) => {
            const ticket = { id, weight: w, state: 'queued', timer: null, resolve, reject };
            tickets.set(id, ticket);
            if (fitsNow) return start(ticket);
            waiting.push(ticket);
            ticket.timer = setTimeout(() => {
                cancelQueued(ticket, new QueueError('QUEUE_TIMEOUT', 'Tiempo máximo de espera en cola agotado.'));
            }, queueTimeoutMs);
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

    // Ocupación (huecos ocupados más peticiones en cola) y cuántas caben en total: server.js
    // las usa para rechazar una subida antes de recibirla si ya no habría sitio. Cuenta huecos
    // y no peticiones: una grande ocupa dos. Con alguien en cola, los huecos libres no los
    // puede usar una petición nueva (FIFO estricto), así que cuentan como ocupados. Así load
    // llega a capacity justo cuando acquire rechazaría con QUEUE_FULL a una de peso 1.
    const load = () => (waiting.length > 0 ? maxConcurrent : used) + waiting.length;
    const capacity = maxConcurrent + maxQueue;
    // Huecos ocupados (una tarea grande cuenta por dos).
    const slotsInUse = () => used;

    return { acquire, cancel, has, getStatus, load, capacity, slotsInUse };
}

module.exports = { createLimiter, QueueError };
