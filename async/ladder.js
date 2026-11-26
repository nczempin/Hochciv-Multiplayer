/**
 * The bot ladder of the Rundenspiele: bot accounts whose owner opted them in (users.arenaLadderOptIn,
 * routes/bots.js) are paired automatically, as long as an admin has the ladder switched on
 * (routes/admin.js GET/POST /ladder, stored in the `settings` table).
 *
 * A ladder game is an ordinary Rundenspiel between two bot accounts on the tile map, nations and
 * turn order random (async/logic.js createLadderGame), public to watch. It follows the usual rules:
 * a bot that doesn't play in time is replaced by the KI and loses. A finished game counts for the
 * standings.
 *
 *   seen(bot)            – a bot asked for its games (async/service.js list): it is there to play
 *   tick()               – pair the bots that are there, opted in, allowed to play and without a
 *                          running ladder game; at the admin's pairing interval
 *   report(version)      – standings and the latest games of one game version (GET /api/async/ladder)
 *   settings/configure   – { enabled, turnDays, avoidRematches, sameOwnerRanked, pairingIntervalSeconds, placement }
 */
const { Op } = require('sequelize');
const { AsyncGame, Setting, User, sequelize } = require('../models');
const { version } = require('../engine-adapter');
const { botBlockedReason } = require('../utils/bots');
const serverState = require('../utils/serverState');

const key = 'arena-correspondence-ladder';
const defaults = { enabled: false, turnDays: 3, avoidRematches: true, sameOwnerRanked: false,
    pairingIntervalSeconds: 15, placement: 'leaderboard' };
const presence = new Map();
const readyForMs = 5 * 60 * 1000;          // a bot counts as there this long after its last request
const testTickMs = Number(process.env.LADDER_TICK_MS);
const TURN_DAYS = [1, 3, 7];
let timer;
let timerMs;
let running = false;

function seen(bot) {
    if (bot.arenaLadderOptIn) presence.set(bot.id, Date.now());
    else presence.delete(bot.id);
}

async function settings() {
    const row = await Setting.findByPk(key);
    return row ? { ...defaults, ...JSON.parse(row.value) } : defaults;
}

/** @returns the stored settings, or { error } */
async function configure(body, by) {
    const { enabled, turnDays, avoidRematches, sameOwnerRanked, pairingIntervalSeconds, placement } = body || {};
    if (!TURN_DAYS.includes(turnDays) || [enabled, avoidRematches, sameOwnerRanked].some(v => typeof v !== 'boolean')
        || (pairingIntervalSeconds !== undefined && (!Number.isInteger(pairingIntervalSeconds)
            || pairingIntervalSeconds < 5 || pairingIntervalSeconds > 300))
        || (placement !== undefined && !['leaderboard', 'main-menu'].includes(placement))) {
        return { error: 'Ungültiger Wert.' };
    }
    const saved = pairingIntervalSeconds === undefined || placement === undefined ? await settings() : defaults;
    const options = { enabled, turnDays, avoidRematches, sameOwnerRanked,
        pairingIntervalSeconds: pairingIntervalSeconds ?? saved.pairingIntervalSeconds,
        placement: placement ?? saved.placement };
    await Setting.upsert({ key, value: JSON.stringify(options), updatedBy: by || null });
    schedule(options.pairingIntervalSeconds);
    return options;
}

async function ladderGames() {
    return AsyncGame.findAll({
        where: { data: { [Op.contains]: { config: { arenaLadder: true } } } },
        attributes: ['id', 'status', 'participantIds', 'createdAt', 'round',
            [sequelize.literal("data->>'engine'"), 'version'],
            [sequelize.literal("data->'config'->'ranked'"), 'ranked'],
            [sequelize.literal("data->'config'->'turnDays'"), 'turnDays'],
            [sequelize.literal("data->'result'"), 'result'],
            [sequelize.literal("data->'seats'"), 'seats']],
        order: [['createdAt', 'ASC'], ['id', 'ASC']], raw: true,
    });
}

const ended = g => ['finished', 'cancelled'].includes(g.status);
const counted = game => game.status === 'finished' && !!game.result?.gameId;       // booked (async/service.js processResult)
const opponentKey = (a, b) => [a, b].sort().join('/');

/**
 * Who plays whom next: the bots with the fewest counted games first, each against the opponent
 * it has met least often (then the one with fewer games, then the closest MMR). With
 * avoidRematches nobody gets the opponent of its last game again right away.
 */
function selectMatchups(bots, games, avoidRematches) {
    const past = new Map(), last = new Map(), count = new Map();
    for (const game of games) {
        if (!counted(game)) continue;
        const [a, b] = game.participantIds;
        last.set(a, b);
        last.set(b, a);
        count.set(a, (count.get(a) || 0) + 1);
        count.set(b, (count.get(b) || 0) + 1);
        const k = opponentKey(a, b);
        past.set(k, (past.get(k) || 0) + 1);
    }
    const pool = [...bots].sort((a, b) => (count.get(a.id) || 0) - (count.get(b.id) || 0));
    const matches = [];
    while (pool.length >= 2) {
        const a = pool.shift();
        const choices = pool.filter(b => !avoidRematches || last.get(a.id) !== b.id || last.get(b.id) !== a.id);
        choices.sort((b, c) => (past.get(opponentKey(a.id, b.id)) || 0) - (past.get(opponentKey(a.id, c.id)) || 0)
            || (count.get(b.id) || 0) - (count.get(c.id) || 0)
            || Math.abs(a.mmr - b.mmr) - Math.abs(a.mmr - c.mmr));
        if (!choices.length) continue;
        const b = choices[0];
        pool.splice(pool.indexOf(b), 1);
        matches.push([a, b]);
    }
    return matches;
}

async function tick() {
    if (running || serverState.state.maintenanceMode) return;
    running = true;
    try {
        const options = await settings();
        schedule(options.pairingIntervalSeconds);
        if (!options.enabled) return;
        const now = Date.now();
        for (const [id, lastSeen] of presence) if (now - lastSeen > readyForMs) presence.delete(id);
        if (presence.size < 2) return;
        const service = require('./service');
        const rules = version();              // ladder games are played with the current game version
        const [games, bots, active] = await Promise.all([
            ladderGames(),
            User.findAll({ where: { id: [...presence.keys()], arenaLadderOptIn: true, accountType: 'bot', isActive: true } }),
            AsyncGame.findAll({ where: { status: service.ACTIVE, participantIds: { [Op.overlap]: [...presence.keys()] } },
                attributes: ['participantIds'] }),
        ]);
        const busy = new Set(games.filter(game => !ended(game)).flatMap(game => game.participantIds));
        const total = new Map();
        for (const game of active) for (const id of game.participantIds) total.set(id, (total.get(id) || 0) + 1);
        const owners = await User.findAll({ where: { id: bots.map(bot => bot.ownerId).filter(Boolean) } });
        const byId = new Map(owners.map(owner => [owner.id, owner]));
        const ready = bots.filter(bot => !busy.has(bot.id) && (total.get(bot.id) || 0) < service.MAX_ACTIVE_PER_USER
            && !botBlockedReason(bot, byId.get(bot.ownerId)));
        for (const [a, b] of selectMatchups(ready, games.filter(g => g.version === rules), options.avoidRematches)) {
            const ranked = a.ownerId !== b.ownerId || options.sameOwnerRanked;
            const result = await service.createLadderGame(a, b, { ranked, turnDays: options.turnDays });
            if (result.error) console.error('[Ladder]', result.error);
            else console.log(`[Ladder] ${a.username} – ${b.username}: game ${result.id}`);
        }
    } finally {
        running = false;
    }
}

function schedule(seconds) {
    const ms = testTickMs > 0 ? testTickMs : seconds * 1000;
    if (timerMs === ms) return;
    clearInterval(timer);
    timerMs = ms;
    timer = setInterval(() => tick().catch(error => console.error('[Ladder]', error.message)), ms).unref();
}

function start() {
    settings().then(options => schedule(options.pairingIntervalSeconds), error => {
        console.error('[Ladder]', error.message);
        schedule(defaults.pairingIntervalSeconds);
    });
}

/** The standings over the games of one game version: every bot that played, the best score rate first. */
function standingsOf(field) {
    const scores = new Map();
    for (const game of field) for (const { userId, name } of game.seats) {
        if (!scores.has(userId)) scores.set(userId, { name, games: 0, wins: 0, draws: 0 });
    }
    for (const game of field.filter(counted)) for (const { userId, name, replaced } of game.seats) {
        const score = scores.get(userId);
        score.games++;
        if (replaced) continue;             // the KI finished the game for this bot: a loss, whatever the KI made of it
        if (game.result.winners.length !== 1) score.draws++;
        else if (game.result.winners.includes(name)) score.wins++;
    }
    return [...scores.values()].map(row => ({ ...row, score: row.games ? (row.wins + row.draws / 2) / row.games : null }))
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.games - a.games || a.name.localeCompare(b.name));
}

async function report(requestedVersion) {
    const games = await ladderGames();
    const editions = [...new Set([version(), ...games.map(g => g.version)])].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
    const rules = editions.includes(requestedVersion) ? requestedVersion : version();
    const field = games.filter(game => game.version === rules);
    const standings = standingsOf(field);
    const publicGame = ({ id, status, round, ranked, turnDays, result, seats }) => ({
        id, status, round, ranked, turnDays, names: seats.map(seat => seat.name),
        winners: result?.winners || [], replay: result?.replay && result.gameId,
    });
    return { version: rules, editions, standings, games: field.slice(-30).reverse().map(publicGame) };
}

module.exports = { settings, configure, seen, start, tick, report, selectMatchups, standingsOf };
