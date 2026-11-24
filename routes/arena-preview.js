const express = require('express');
const fs = require('node:fs/promises');
const { Game, Replay } = require('../models');

const router = express.Router();

// The private driver records the schedule and match IDs. Scores come from multiplayer history.
router.get('/tournaments', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const journal = process.env.ARENA_PREVIEW_JOURNAL;
    if (!journal) return res.json([]);
    let event;
    try {
        event = JSON.parse(await fs.readFile(journal, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return res.json([]);
        console.error('[Arena Preview] Cannot load the tournament journal:', err);
        return res.status(500).json({ error: 'Serverfehler' });
    }
    try {
        const ids = event.fixtures.map(f => f.gameId).filter(Boolean);
        const [games, replays] = await Promise.all([
            Game.findAll({ where: { id: ids }, attributes: ['id', 'version', 'participants'] }),
            Replay.findAll({ where: { gameId: ids }, attributes: ['gameId'] }),
        ]);
        const history = new Map(games.map(game => [game.id, game]));
        const replayIds = new Set(replays.map(replay => replay.gameId));
        const fixtures = event.fixtures.map(({ a, b, round, gameId }) => {
            if (!gameId) return { a, b, round, state: 'scheduled', score: null };
            const game = history.get(gameId);
            const pa = game?.participants.find(player => player.name === a);
            const pb = game?.participants.find(player => player.name === b);
            if (game?.version !== event.version || game.participants.length !== 2 || !pa?.botAccount || !pb?.botAccount) {
                throw new Error('Stored game does not match the fixture: ' + gameId);
            }
            const score = pa.isWinner === pb.isWinner ? 0.5 : Number(pa.isWinner);
            return { a, b, round, state: 'finished', score, replay: replayIds.has(gameId) ? gameId : null };
        });
        res.json([{
            id: event.id, name: event.name, date: event.date, version: event.version,
            turnSeconds: event.turnSeconds, wonders: event.wonders, expCivs: event.expCivs, ranked: event.ranked,
            entrants: event.entrants, fixtures, playing: fixtures.some(f => f.state !== 'finished'),
        }]);
    } catch (err) {
        console.error('[Arena Preview] Cannot resolve tournament matches:', err);
        res.status(500).json({ error: 'Serverfehler' });
    }
});

module.exports = router;
