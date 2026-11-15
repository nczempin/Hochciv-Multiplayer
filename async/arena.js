'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { AsyncGame, User } = require('../models');
const engine = require('../engine-adapter');
const Bots = require('../utils/bots');
const serverState = require('../utils/serverState');

// Pin MVP arena matches to v106 while supported so bots can rely on stable rules;
// fall back to the server's current engine only if v106 is removed later.
const TARGET_ENGINE = 'v106';
const ARENA_ENGINE = (engine.version() === TARGET_ENGINE || (engine.OLD_VERSIONS || []).includes(TARGET_ENGINE))
    ? TARGET_ENGINE
    : engine.version();

const ARENA_CONFIG = Object.freeze({
    mapKey: '0',
    civMode: 'random',
    playerCount: 2,
    difficulty: 'schwer',
    events: false,
    wonders: false,
    hexTiles: false,
    ranked: false,
    isPublic: true,
    turnDays: 1,
    playerBots: true,
});

function intEnv(key, fallback, min = 1) {
    const n = parseInt(process.env[key], 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
}

const intervalMs = () => intEnv('ARENA_INTERVAL_MS', 60 * 1000, 10);
const ttlMs = () => intEnv('ARENA_TTL_MS', 5 * 60 * 1000, 1);
const kiWaitMs = () => intEnv('ARENA_KI_WAIT_MS', 2 * 60 * 1000, 0);
const maxActive = () => intEnv('ARENA_MAX_ACTIVE', 1, 1);

// userId -> { joinedAt, lastSeen, idleSince }
const pool = new Map();
let timer = null;
let ticking = false;

function prune(now = Date.now()) {
    const ttl = ttlMs();
    for (const [id, entry] of pool) {
        if (now - entry.lastSeen > ttl) pool.delete(id);
    }
}

function optIn(userId, now = Date.now()) {
    if (!userId) return false;
    const ttl = ttlMs();
    const cur = pool.get(userId);
    if (cur && now - cur.lastSeen <= ttl) {
        cur.lastSeen = now;
    } else {
        pool.set(userId, { joinedAt: now, lastSeen: now, idleSince: now });
    }
    return true;
}

function optOut(userId) {
    if (!userId) return false;
    return pool.delete(userId);
}

function isOptedIn(userId, now = Date.now()) {
    if (!userId) return false;
    const entry = pool.get(userId);
    if (!entry) return false;
    if (now - entry.lastSeen > ttlMs()) {
        pool.delete(userId);
        return false;
    }
    return true;
}

function poolSize(now = Date.now()) {
    prune(now);
    return pool.size;
}

async function runTick(now) {
    if (serverState.state && serverState.state.maintenanceMode) {
        return { matches: 0, maintenance: true };
    }
    prune(now);
    if (!pool.size) return { matches: 0 };

    const service = require('./service');
    const ids = [...pool.keys()];
    const bots = await User.findAll({ where: { id: ids, accountType: 'bot' } });
    const botById = new Map(bots.map(b => [b.id, b]));
    const ownerIds = [...new Set(bots.map(b => b.ownerId).filter(Boolean))];
    const owners = ownerIds.length ? await User.findAll({ where: { id: ownerIds } }) : [];
    const ownerById = new Map(owners.map(o => [o.id, o]));

    const usable = [];
    for (const id of ids) {
        const bot = botById.get(id);
        const owner = bot && bot.ownerId ? ownerById.get(bot.ownerId) : null;
        if (!bot || Bots.botUsable(bot, owner)) {
            pool.delete(id);
            continue;
        }
        usable.push(bot);
    }
    if (!usable.length) return { matches: 0 };

    const usableIds = usable.map(b => b.id);
    const usableSet = new Set(usableIds);
    const activeRows = await AsyncGame.findAll({
        where: {
            status: { [Op.in]: service.ACTIVE },
            participantIds: { [Op.overlap]: usableIds },
        },
        attributes: ['id', 'participantIds', 'data'],
    });

    const arenaActive = new Map();
    const totalActive = new Map();
    for (const row of activeRows) {
        const isArena = !!(row.data && row.data.config && row.data.config.arena);
        for (const uid of row.participantIds || []) {
            if (!usableSet.has(uid)) continue;
            totalActive.set(uid, (totalActive.get(uid) || 0) + 1);
            if (isArena) arenaActive.set(uid, (arenaActive.get(uid) || 0) + 1);
        }
    }

    const cap = maxActive();
    const ready = [];
    for (const bot of usable) {
        const entry = pool.get(bot.id);
        if (!entry) continue;
        const busy = (arenaActive.get(bot.id) || 0) >= cap
            || (totalActive.get(bot.id) || 0) >= service.MAX_ACTIVE_PER_USER;
        if (busy) {
            entry.idleSince = null;
            continue;
        }
        if (entry.idleSince == null) entry.idleSince = now;
        ready.push({ user: bot, entry });
    }
    if (!ready.length) return { matches: 0 };

    for (let i = ready.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [ready[i], ready[j]] = [ready[j], ready[i]];
    }

    let matches = 0;
    let i = 0;
    for (; i + 1 < ready.length; i += 2) {
        const a = ready[i];
        const b = ready[i + 1];
        const created = await service.create(
            a.user,
            { config: { ...ARENA_CONFIG, kiCount: 0 } },
            { arena: true, engine: ARENA_ENGINE }
        );
        if (!created || created.error || !created.id) {
            console.warn('[arena] failed to create duel:', created && created.error);
            continue;
        }
        const joined = await service.join(b.user, created.id, { code: created.joinCode });
        if (joined && joined.error) {
            console.warn('[arena] second bot failed to join duel:', joined.error);
            continue;
        }
        a.entry.idleSince = null;
        b.entry.idleSince = null;
        matches++;
    }

    if (i < ready.length) {
        const solo = ready[i];
        if (now - solo.entry.idleSince >= kiWaitMs()) {
            const created = await service.create(
                solo.user,
                { config: { ...ARENA_CONFIG, kiCount: 1 } },
                { arena: true, engine: ARENA_ENGINE }
            );
            if (created && !created.error && created.id) {
                solo.entry.idleSince = null;
                matches++;
            } else {
                console.warn('[arena] failed to create KI match:', created && created.error);
            }
        }
    }

    return { matches };
}

async function tick(now = Date.now()) {
    if (ticking) return { skipped: true };
    ticking = true;
    try {
        return await runTick(now);
    } finally {
        ticking = false;
    }
}

function start() {
    if (timer) return timer;
    timer = setInterval(() => {
        tick().catch(err => console.error('[arena] tick error:', err.message));
    }, intervalMs());
    timer.unref();
    return timer;
}

function _resetForTests() {
    pool.clear();
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    ticking = false;
}

module.exports = {
    ARENA_ENGINE,
    ARENA_CONFIG,
    optIn,
    optOut,
    isOptedIn,
    poolSize,
    tick,
    start,
    _resetForTests,
};
