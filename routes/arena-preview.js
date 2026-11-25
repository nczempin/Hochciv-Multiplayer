const express = require('express');
const fs = require('node:fs/promises');
const { timingSafeEqual } = require('node:crypto');
const { Game, Replay } = require('../models');
const sessions = require('../sessions');
const arena = require('../utils/arena-preview');
const ladder = require('../async/ladder');
const { USERNAME_RE } = require('../utils/auth');
const { LIVE_TURN_TIMES } = require('../config');

const router = express.Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

async function oldEvents() {
    const journal = process.env.ARENA_PREVIEW_JOURNAL;
    if (!journal) return [];
    try {
        const stored = JSON.parse(await fs.readFile(journal, 'utf8'));
        return Array.isArray(stored) ? stored : [stored];
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

// Scores always come from multiplayer history.
router.get('/tournaments', async (_req, res) => {
    try {
        const events = [...await arena.events(), ...await oldEvents()];
        const live = new Map(sessions.getPublicSessions()
            .filter(game => game.status === 'playing' || game.status === 'placement')
            .map(game => [game.id, game]));
        res.json(await Promise.all(events.map(event => tournament(event, live))));
    } catch (err) {
        console.error('[Arena Preview] Cannot resolve tournament matches:', err);
        res.status(500).json({ error: 'Serverfehler' });
    }
});

router.get('/opt-in', (req, res) => {
    if (req.user?.accountType !== 'bot') return res.status(403).json({ error: 'Nur für Spieler-Bots.' });
    res.json({ optedIn: req.user.arenaOptIn });
});

function requireDirector(req, res, next) {
    if (req.isAuthenticated() && ['admin', 'superadmin', 'tournamentdirector'].includes(req.user.role)) return next();
    res.status(403).json({ error: 'Nur für Administratoren' });
}

router.get('/schedule', requireDirector, async (_req, res) => res.json(await arena.status()));
router.get('/ladder', async (req, res) => res.json(await ladder.report(req.query.version)));
router.get('/ladder/settings', requireDirector, async (_req, res) => res.json(await ladder.settings()));
router.post('/ladder/settings', requireDirector, async (req, res) => {
    const { enabled, turnDays, avoidRematches, sameOwnerRanked } = req.body || {};
    if (![1, 3, 7].includes(turnDays) || [enabled, avoidRematches, sameOwnerRanked].some(v => typeof v !== 'boolean')) {
        return res.status(400).json({ error: 'Ungültige Aktion.' });
    }
    res.json(await ladder.configure({ enabled, turnDays, avoidRematches, sameOwnerRanked }));
});
router.post('/schedule', requireDirector, async (req, res) => {
    const { action, turnSeconds, ranked, doubleHeader, ki = {} } = req.body || {};
    if (action !== 'drain' && (!['start', 'save'].includes(action) || !LIVE_TURN_TIMES.includes(turnSeconds) ||
        !turnSeconds || typeof ranked !== 'boolean' || typeof doubleHeader !== 'boolean' ||
        !ki || typeof ki !== 'object' || Array.isArray(ki) || Object.entries(ki).some(([level, entry]) =>
            !Object.hasOwn(arena.kiLevels, level) || typeof entry?.enabled !== 'boolean' || typeof entry.ranked !== 'boolean'))) {
        return res.status(400).json({ error: 'Ungültige Aktion.' });
    }
    await arena.configure(action, { turnSeconds, ranked, doubleHeader, ki });
    res.json(await arena.status());
});

router.post('/worker/next', async (req, res) => {
    const key = process.env.ARENA_PREVIEW_WORKER_KEY;
    const supplied = Buffer.from(req.get('Authorization') || '');
    const expected = Buffer.from('Bearer ' + key);
    if (!key || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return res.status(403).json({ error: 'Nur für den Arena-Dienst.' });
    }
    const bots = req.body?.bots;
    if (!Array.isArray(bots) || bots.length > 32 ||
        bots.some(bot => typeof bot?.name !== 'string' || !USERNAME_RE.test(bot.name) ||
            typeof bot.build !== 'string' || bot.build.length > 120) ||
        new Set(bots.map(bot => bot.name)).size !== bots.length) {
        return res.status(400).json({ error: 'Ungültige Aktion.' });
    }
    res.json(await arena.next(bots.map(({ name, build }) => ({ name, build }))));
});

async function tournament(event, live) {
    const ids = event.fixtures.map(f => f.gameId).filter(Boolean);
    const [games, replays] = await Promise.all([
        Game.findAll({ where: { id: ids }, attributes: ['id', 'version', 'participants'] }),
        Replay.findAll({ where: { gameId: ids }, attributes: ['gameId'] }),
    ]);
    const history = new Map(games.map(game => [game.id, game]));
    const replayIds = new Set(replays.map(replay => replay.gameId));
    const fixtures = event.fixtures.map(({ a, b, round, pair, leg, gameId, sessionId, ranked }) => {
        const fixture = { a, b, round, pair, leg, ranked: ranked ?? event.ranked };
        const game = history.get(gameId);
        if (!gameId || (event.managed && !game)) {
            const match = live.get(sessionId);
            const watch = match && { code: match.joinCode, password: match.password };
            return { ...fixture, state: watch ? 'live' : 'scheduled', score: null, watch };
        }
        const pa = game?.participants.find(player => player.name === a);
        const pb = game?.participants.find(player => player.name === b);
        const properSeat = (seat, name) => event.ki?.[name] ? seat?.isBot && !seat.botAccount : seat?.botAccount;
        if (game?.version !== event.version || game.participants.length !== 2 || !properSeat(pa, a) || !properSeat(pb, b)) {
            throw new Error('Stored game does not match the fixture: ' + gameId);
        }
        const score = pa.isWinner === pb.isWinner ? 0.5 : Number(pa.isWinner);
        return { ...fixture, state: 'finished', score, replay: replayIds.has(gameId) ? gameId : null };
    });
    return {
        id: event.id, name: event.name, date: event.date, version: event.version,
        turnSeconds: event.turnSeconds, wonders: event.wonders, expCivs: event.expCivs, ranked: event.ranked,
        doubleHeader: event.doubleHeader === true, startedAt: event.startedAt, finishedAt: event.finishedAt,
        entrants: event.entrants, builds: event.builds, fixtures,
        playing: fixtures.some(f => f.state !== 'finished'),
    };
}

module.exports = router;
