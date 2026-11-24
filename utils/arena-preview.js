const { randomInt, randomUUID } = require('node:crypto');
const { Op } = require('sequelize');
const { Game, Setting, User, sequelize } = require('../models');
const engine = require('../engine-adapter');
const sessions = require('../sessions');
const { roundRobin } = require('../client/arena-preview-data');
const { botBlockedReason } = require('./bots');
const serverState = require('./serverState');

const scheduleKey = 'arena-preview-schedule';
const eventPrefix = 'arena-preview-event-';
const defaults = {
    enabled: false, active: null, sequence: 1,
    options: { turnSeconds: 60, ranked: true, doubleHeader: false },
};

async function changeSchedule(update) {
    await Setting.findOrCreate({ where: { key: scheduleKey }, defaults: { value: JSON.stringify(defaults) } });
    return sequelize.transaction(async transaction => {
        const row = await Setting.findByPk(scheduleKey, { transaction, lock: transaction.LOCK.UPDATE });
        const schedule = JSON.parse(row.value);
        const result = await update(schedule, transaction);
        await row.update({ value: JSON.stringify(schedule) }, { transaction });
        return result;
    });
}

async function configure(action, options) {
    return changeSchedule(schedule => {
        if (action === 'drain') schedule.enabled = false;
        else {
            schedule.options = options;
            if (action === 'start') schedule.enabled = true;
        }
        return schedule;
    });
}

async function events() {
    const rows = await Setting.findAll({ where: { key: { [Op.startsWith]: eventPrefix } }, order: [['createdAt', 'DESC']] });
    return rows.map(row => JSON.parse(row.value));
}

async function completed(fixtures, transaction) {
    return new Set((await Game.findAll({
        where: { id: fixtures.map(f => f.gameId) }, attributes: ['id'], transaction,
    })).map(game => game.id));
}

async function status() {
    const row = await Setting.findByPk(scheduleKey);
    const { enabled, active, options, waiting } = row ? JSON.parse(row.value) : defaults;
    if (!active) return { enabled, options, waiting, active: null };
    const { id, name, fixtures, startedAt, turnSeconds, ranked, doubleHeader, entrants } =
        JSON.parse((await Setting.findByPk(eventPrefix + active)).value);
    const results = await completed(fixtures);
    return { enabled, options, waiting, active: {
        id, name, startedAt, turnSeconds, ranked, doubleHeader, entrants, games: fixtures.length, finished: results.size,
    } };
}

async function optedIn(workerBots, transaction) {
    const bots = await User.findAll({ where: {
        username: workerBots.map(bot => bot.name), accountType: 'bot', arenaOptIn: true, isActive: true,
    }, transaction });
    const owners = await User.findAll({ where: { id: bots.map(bot => bot.ownerId).filter(Boolean) }, transaction });
    const byOwner = new Map(owners.map(owner => [owner.id, owner]));
    const allowed = new Map(bots.filter(bot => !botBlockedReason(bot, byOwner.get(bot.ownerId))).map(bot => [bot.username, bot.id]));
    return workerBots.filter(bot => allowed.has(bot.name)).map(bot => ({ ...bot, userId: allowed.get(bot.name) }));
}

function makeEvent(sequence, options, bots) {
    const id = 'lab-family-round-robin-' + sequence;
    const entrants = bots.map(bot => bot.name);
    const fixtures = roundRobin(entrants).flatMap(({ a, b, round }, index) => {
        const pair = index + 1;
        const seed = randomInt(2 ** 31);
        const first = randomInt(2) ? { a, b } : { a: b, b: a };
        const leg = (seats, number) => ({ ...seats, round, pair, leg: number, seed, gameId: randomUUID() });
        return options.doubleHeader
            ? [leg(first, 1), leg({ a: first.b, b: first.a }, 2)]
            : [leg(first, 1)];
    });
    const startedAt = new Date().toISOString();
    return {
        id, name: 'Family Round Robin ' + sequence, version: engine.version(),
        date: startedAt.slice(0, 10), startedAt, ...options, managed: true,
        mapKey: 'random', wonders: false, expCivs: false, entrants,
        builds: Object.fromEntries(bots.map(bot => [bot.name, bot.build])),
        userIds: Object.fromEntries(bots.map(bot => [bot.name, bot.userId])),
        fixtures,
    };
}

function lobbyFor(event, fixture) {
    let session = sessions.getSession(fixture.sessionId);
    if (!session) {
        const players = [fixture.a, fixture.b].map(name => ({
            name, clientId: randomUUID(), civ: 'random', ability: 'random', botUserId: event.userIds[name],
        }));
        const created = sessions.createSession({
            mapKey: event.mapKey, playerCount: 2, kiCount: 0, civMode: 'random', turnOrder: 'pick',
            turnTime: event.turnSeconds, wonders: event.wonders, expCivs: event.expCivs, events: false,
            ranked: event.ranked, playerBots: true, isPublic: false, seed: fixture.seed,
        }, players[0]);
        if (typeof created === 'string') throw new Error(created);
        const joined = sessions.joinSession(created.joinCode, created.password, players[1], { trusted: true });
        if (typeof joined === 'string') {
            sessions.removeSession(created.sessionId);
            throw new Error(joined);
        }
        fixture.sessionId = created.sessionId;
        session = sessions.getSession(fixture.sessionId);
        session.players.forEach((player, index) => { player.pos = index; });
        session.arenaPreview = { gameId: fixture.gameId };
    }
    return {
        ...fixture,
        lobby: { sessionId: session.id, password: session.password, status: session.status },
        identities: [fixture.a, fixture.b].map(name => {
            const player = session.players.find(p => p.name === name);
            return { name, clientId: player.clientId };
        }),
    };
}

async function next(workerBots) {
    return changeSchedule(async (schedule, transaction) => {
        let event, row, done;
        if (schedule.active) {
            row = await Setting.findByPk(eventPrefix + schedule.active, { transaction });
            event = JSON.parse(row.value);
            done = await completed(event.fixtures, transaction);
            if (done.size === event.fixtures.length) {
                event.finishedAt = new Date().toISOString();
                await row.update({ value: JSON.stringify(event) }, { transaction });
                schedule.active = null;
                event = null;
            }
        }
        delete schedule.waiting;
        if (serverState.state.maintenanceMode) {
            schedule.waiting = 'maintenance';
            return { fixtures: [] };
        }
        if (!event && schedule.enabled) {
            const bots = await optedIn(workerBots, transaction);
            if (bots.length < 2) {
                schedule.waiting = 'bots';
                return { fixtures: [] };
            }
            event = makeEvent(++schedule.sequence, schedule.options, bots);
            row = await Setting.create({ key: eventPrefix + event.id, value: JSON.stringify(event) }, { transaction });
            schedule.active = event.id;
            done = new Set();
        }
        if (!event) return { fixtures: [] };
        const pending = event.fixtures.filter(fixture => !done.has(fixture.gameId));
        const round = Math.min(...pending.map(f => f.round));
        const leg = Math.min(...pending.filter(f => f.round === round).map(f => f.leg));
        const wave = pending.filter(f => f.round === round && f.leg === leg);
        const fixtures = wave.filter(f => sessions.getSession(f.sessionId)?.status !== 'finished').map(f => lobbyFor(event, f));
        await row.update({ value: JSON.stringify(event) }, { transaction });
        return { version: event.version, turnSeconds: event.turnSeconds, ranked: event.ranked, fixtures };
    });
}

module.exports = { configure, status, events, next };
