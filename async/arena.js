'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { AsyncGame, User } = require('../models');
const engine = require('../engine-adapter');
const Bots = require('../utils/bots');
const serverState = require('../utils/serverState');

const ARENA_ENGINE = engine.version();
// v106 is the first arena edition. Later retired editions stay available while their engines ship.
const ARENA_VERSIONS = Object.freeze([ARENA_ENGINE, ...engine.OLD_VERSIONS.filter(v => Number(v.slice(1)) >= 106)]);

function intEnv(key, fallback, min = 1) {
    const n = parseInt(process.env[key], 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
}

const intervalMs = () => intEnv('ARENA_INTERVAL_MS', 60 * 1000, 10);
const ttlMs = () => intEnv('ARENA_TTL_MS', 5 * 60 * 1000, 1);
const maxActive = () => intEnv('ARENA_MAX_ACTIVE', 1, 1);

// userId -> { version, lastSeen }
const pool = new Map();
let timer = null;
let ticking = false;

function prune(now = Date.now()) {
    const ttl = ttlMs();
    for (const [id, entry] of pool) {
        if (now - entry.lastSeen > ttl) pool.delete(id);
    }
}

function optIn(userId, now = Date.now(), version = ARENA_ENGINE, placement = false) {
    if (!userId || !placement || !ARENA_VERSIONS.includes(version)) return false;
    const ttl = ttlMs();
    const cur = pool.get(userId);
    if (cur && cur.version === version && now - cur.lastSeen <= ttl) {
        cur.lastSeen = now;
    } else {
        pool.set(userId, { version, lastSeen: now });
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

function status(userId, now = Date.now()) {
    const optedIn = isOptedIn(userId, now);
    return {
        arena: optedIn,
        arenaVersion: optedIn ? pool.get(userId).version : null,
        arenaOfficialVersion: ARENA_ENGINE,
        arenaVersions: ARENA_VERSIONS,
        arenaPlacementRequired: true,
    };
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
        if (!bot || Bots.botBlockedReason(bot, owner)) {
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
    const readyByVersion = new Map();
    for (const bot of usable) {
        const entry = pool.get(bot.id);
        if (!entry) continue;
        const busy = (arenaActive.get(bot.id) || 0) >= cap
            || (totalActive.get(bot.id) || 0) >= service.MAX_ACTIVE_PER_USER;
        if (busy) continue;
        if (!readyByVersion.has(entry.version)) readyByVersion.set(entry.version, []);
        readyByVersion.get(entry.version).push({ user: bot, entry });
    }

    let matches = 0;
    for (const [version, ready] of readyByVersion) {
        matches += await schedule(ready, version, service);
    }
    return { matches };
}

async function schedule(ready, version, service) {
    for (let i = ready.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [ready[i], ready[j]] = [ready[j], ready[i]];
    }

    let matches = 0;
    for (let i = 0; i + 1 < ready.length; i += 2) {
        const a = ready[i];
        const b = ready[i + 1];
        if (pool.get(a.user.id) !== a.entry || pool.get(b.user.id) !== b.entry) continue;
        const created = await service.createArenaPair(a.user, b.user, version);
        if (created.error) console.warn('[arena] failed to create tiled pair:', created.error);
        else matches++;
    }

    return matches;
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
    optIn,
    optOut,
    isOptedIn,
    status,
    poolSize,
    tick,
    start,
    _resetForTests,
};
