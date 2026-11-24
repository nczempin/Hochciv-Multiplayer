const express = require('express');
const fs = require('node:fs/promises');
const { Game, Replay } = require('../models');
const sessions = require('../sessions');

const router = express.Router();

// The private driver records the schedule and match IDs. Scores come from multiplayer history.
router.get('/tournaments', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const journal = process.env.ARENA_PREVIEW_JOURNAL;
    if (!journal) return res.json([]);
    let journalContents;
    try {
        journalContents = JSON.parse(await fs.readFile(journal, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return res.json([]);
        console.error('[Arena Preview] Cannot load the tournament journal:', err);
        return res.status(500).json({ error: 'Serverfehler' });
    }
    try {
        const events = Array.isArray(journalContents) ? journalContents : [journalContents];
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
    res.set('Cache-Control', 'no-store');
    if (req.user?.accountType !== 'bot') return res.status(403).json({ error: 'Nur für Spieler-Bots.' });
    res.json({ optedIn: req.user.arenaOptIn });
});

async function tournament(event, live) {
    const ids = event.fixtures.map(f => f.gameId).filter(Boolean);
    const [games, replays] = await Promise.all([
        Game.findAll({ where: { id: ids }, attributes: ['id', 'version', 'participants'] }),
        Replay.findAll({ where: { gameId: ids }, attributes: ['gameId'] }),
    ]);
    const history = new Map(games.map(game => [game.id, game]));
    const replayIds = new Set(replays.map(replay => replay.gameId));
    const fixtures = event.fixtures.map(({ a, b, round, gameId, sessionId }) => {
        if (!gameId) {
            const match = live.get(sessionId);
            const watch = match && { code: match.joinCode, password: match.password };
            return { a, b, round, state: watch ? 'live' : 'scheduled', score: null, watch };
        }
        const game = history.get(gameId);
        const pa = game?.participants.find(player => player.name === a);
        const pb = game?.participants.find(player => player.name === b);
        if (game?.version !== event.version || game.participants.length !== 2 || !pa?.botAccount || !pb?.botAccount) {
            throw new Error('Stored game does not match the fixture: ' + gameId);
        }
        const score = pa.isWinner === pb.isWinner ? 0.5 : Number(pa.isWinner);
        return { a, b, round, state: 'finished', score, replay: replayIds.has(gameId) ? gameId : null };
    });
    return {
        id: event.id, name: event.name, date: event.date, version: event.version,
        turnSeconds: event.turnSeconds, wonders: event.wonders, expCivs: event.expCivs, ranked: event.ranked,
        entrants: event.entrants, builds: event.builds, fixtures,
        playing: fixtures.some(f => f.state !== 'finished'),
    };
}

module.exports = router;
