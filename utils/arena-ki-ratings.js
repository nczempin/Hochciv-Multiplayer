const { Op } = require('sequelize');
const { Game, Setting, sequelize } = require('../models');
const { calculateMMR, BASE_MMR } = require('./mmr');

const entrants = {
    leicht: { id: '00000000-0000-4000-8000-000000000001', username: 'KI Leicht' },
    mittel: { id: '00000000-0000-4000-8000-000000000002', username: 'KI Mittel' },
    schwer: { id: '00000000-0000-4000-8000-000000000003', username: 'KI Schwer' },
};
const eventPrefix = 'arena-preview-event-';
const key = 'arena-preview-ki-ratings';

function isEntrant(id) {
    return Object.values(entrants).some(entrant => entrant.id === id);
}

function applyResult(ratings, level, change, won, matchDate) {
    const state = ratings[level] ||= { mmr: BASE_MMR, seasons: {} };
    const seasonId = require('./seasons').quarterOf(matchDate).id;
    const stats = state.seasons[seasonId] ||= { games: 0, wins: 0 };
    state.mmr = Math.max(0, state.mmr + change);
    stats.games++;
    if (won) stats.wins++;
}

// Recover the old KI side of ratings from managed fixtures and the MMR inputs
// saved with each result. Historical player-bot ratings and game records stay intact.
async function historicalRatings(transaction) {
    const events = await Setting.findAll({
        where: { key: { [Op.startsWith]: eventPrefix } }, attributes: ['value'], transaction,
    });
    const levels = new Map();
    for (const row of events) {
        const event = JSON.parse(row.value);
        for (const fixture of event.fixtures) {
            const ki = event.ki?.[fixture.a] || event.ki?.[fixture.b];
            if (ki && (fixture.ranked ?? event.ranked)) levels.set(fixture.gameId, ki.level);
        }
    }
    const games = await Game.findAll({
        where: { id: [...levels.keys()] }, attributes: ['id', 'matchDate', 'participants'],
        order: [['matchDate', 'ASC'], ['id', 'ASC']], transaction,
    });
    const ratings = {};
    for (const game of games) {
        const level = levels.get(game.id);
        const seats = game.participants;
        const index = seats.findIndex(p => p.isBot && !p.botAccount && p.name === entrants[level]?.username);
        if (seats.length !== 2 || index < 0 || !Number.isInteger(seats[1 - index].oldMmr)) continue;
        const result = calculateMMR(seats.map((p, i) => ({ ...p, mmr: i === index ? BASE_MMR : p.oldMmr })))[index];
        applyResult(ratings, level, result.mmrChange, seats[index].isWinner, game.matchDate);
    }
    return ratings;
}

let initializing;
function ensure() {
    if (process.env.ARENA_PREVIEW !== 'on') return;
    initializing ||= sequelize.transaction(async transaction => {
        const [row, created] = await Setting.findOrCreate({ where: { key }, defaults: { value: '{}' }, transaction });
        if (created) await row.update({ value: JSON.stringify(await historicalRatings(transaction)) }, { transaction });
    }).catch(error => {
        initializing = null;
        throw error;
    });
    return initializing;
}

function lock(transaction) {
    return Setting.findByPk(key, { transaction, lock: transaction.LOCK.UPDATE });
}

async function record(row, level, change, won, matchDate, transaction) {
    const ratings = JSON.parse(row.value);
    applyResult(ratings, level, change, won, matchDate);
    await row.update({ value: JSON.stringify(ratings) }, { transaction });
}

async function entries(seasonId, { row, transaction } = {}) {
    if (process.env.ARENA_PREVIEW !== 'on') return [];
    const setting = row || await Setting.findByPk(key, { transaction });
    const ratings = setting ? JSON.parse(setting.value) : {};
    return Object.entries(ratings).map(([level, { mmr, seasons }]) => ({
        ...entrants[level], mmr, arenaKi: true, ...(seasons[seasonId] ?? { games: 0, wins: 0 }),
    }));
}

async function reset(row, transaction) {
    if (!row) return;
    const ratings = JSON.parse(row.value);
    for (const state of Object.values(ratings)) state.mmr = Math.round((state.mmr + BASE_MMR) / 2);
    await row.update({ value: JSON.stringify(ratings) }, { transaction });
}

module.exports = { entrants, eventPrefix, isEntrant, ensure, lock, record, entries, reset };
