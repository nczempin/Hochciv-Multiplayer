// One real, unranked round robin on a private Arena preview server.
// Usage: node scripts/arena-preview-run.js URL HANS_BINARY_OR_ROSTER.json JOURNAL.json < bot accounts JSON
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { io } = require('socket.io-client');
const engine = require('../engine-adapter');
const { roundRobin } = require('../client/arena-preview-data');

const config = {
    mapKey: 'random', playerCount: 2, kiCount: 0, civMode: 'random', turnOrder: 'random',
    turnTime: 60, wonders: false, expCivs: false, events: false, ranked: false,
    playerBots: true, isPublic: false,
};
const [base, source, journal] = process.argv.slice(2);
const version = engine.version();

async function request(path, cookie, body) {
    const headers = { Cookie: cookie || '' };
    if (body) headers['Content-Type'] = 'application/json';
    for (;;) {
        const response = await fetch(base + path, {
            headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });
        if (response.status === 429) {
            await response.body.cancel();
            await delay(1000 * (Number(response.headers.get('Retry-After')) || 60));
            continue;
        }
        if (!response.ok) throw new Error(path + ' HTTP ' + response.status + ': ' + (await response.text()).slice(0, 400));
        return { body: await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
    }
}

async function emit(socket, event, data) {
    const result = await socket.timeout(10000).emitWithAck(event, data);
    if (!result || result.error) throw new Error(event + ': ' + (result?.error || 'no acknowledgement'));
    return result;
}

function received(socket, event, accept = () => true) {
    return new Promise(resolve => {
        const listener = message => {
            if (!accept(message)) return;
            socket.off(event, listener);
            resolve(message);
        };
        socket.on(event, listener);
    });
}

async function within(promise, ms, description) {
    const control = new AbortController();
    try {
        return await Promise.race([promise, delay(ms, null, { signal: control.signal }).then(() => {
            throw new Error('Timed out waiting for ' + description);
        })]);
    } finally {
        control.abort();
    }
}

async function openSocket(cookie, session, identity) {
    const socket = io(base, {
        forceNew: true, reconnection: false, transports: ['websocket'],
        extraHeaders: { Cookie: cookie, Origin: base },
    });
    try {
        await within(once(socket, 'connect'), 12000, 'socket connect');
        const bound = await emit(socket, 'session:connect', { sessionId: session.sessionId, password: session.password, clientId: identity.clientId });
        return { socket, bound };
    } catch (err) {
        socket.disconnect();
        throw err;
    }
}

function startPolicy(bot) {
    const [binary, ...args] = bot.command;
    const child = spawn(binary, args, {
        cwd: bot.cwd, env: { ...process.env, ...bot.env }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
    });
    const closed = once(child, 'exit').then(([code]) => { throw new Error(bot.name + ' policy exited ' + code); });
    closed.catch(() => {});
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    const read = async (ms = 25000) => {
        const line = await within(Promise.race([lines.next(), closed]), ms, bot.name + ' policy response');
        if (line.done) throw new Error(bot.name + ' policy stopped');
        return JSON.parse(line.value);
    };
    return { send, read, close: () => child.kill() };
}

async function play(fixture, accounts, save) {
    const bots = [accounts.get(fixture.a), accounts.get(fixture.b)];
    const identities = bots.map(bot => ({ name: bot.name, clientId: randomUUID(), civ: 'random', ability: 'random' }));
    const { body: lobby } = await request('/api/sessions', bots[0].cookie, { config, host: identities[0] });
    const sockets = [], policies = [];
    let flag = false, refusals = 0;
    try {
        for (const bot of bots) policies.push(startPolicy(bot));
        await Promise.all(policies.map(async (worker, index) => {
            worker.send({ type: 'hello', protocol: 1, engine: { version } });
            const answer = await worker.read();
            if (answer.type !== 'hello') throw new Error(bots[index].name + ': ' + answer.message);
        }));
        await request('/api/sessions/join', bots[1].cookie, {
            joinCode: lobby.joinCode, password: lobby.password, player: identities[1],
        });
        for (let i = 0; i < bots.length; i++) {
            const { socket } = await openSocket(bots[i].cookie, lobby, identities[i]);
            sockets.push(socket);
            socket.on('turn:timeout', () => { flag = true; });
        }
        const placed = received(sockets[0], 'placement:start');
        const started = sockets.map(socket => received(socket, 'game:start'));
        const recorded = received(sockets[0], 'game:record');
        let lobbyPlayers;
        sockets[0].on('lobby:player:updated', players => { lobbyPlayers = players; });
        // Open spectating only after the two intended accounts have taken their seats.
        await emit(sockets[0], 'lobby:config', { isPublic: true });
        await emit(sockets[0], 'game:start', {});
        fixture.sessionId = lobby.sessionId;
        save();
        const { plan, queue, cfg } = await within(placed, 10000, 'tile placement');
        assert.equal(cfg.turnTime, 60);
        assert.equal(cfg.mapKey, 'random');
        assert.equal(cfg.wonders, false);
        assert.equal(Boolean(cfg.expCivs), false);
        assert.equal(cfg.ranked, config.ranked);
        assert.equal(queue.length, 2);
        assert.equal(lobbyPlayers.length, 2);
        assert(lobbyPlayers.every(player => player.botAccount), 'both seats are player-bot accounts');
        const E = engine.getEngine();
        const setup = engine.rollSetup({ players: lobbyPlayers, gameConfig: cfg }, cfg.seed);
        for (const [index, bot] of bots.entries()) {
            const player = lobbyPlayers.find(p => p.name === bot.name);
            const seat = plan.seats.find(s => s.idx === player.index);
            const error = E.kiPlaceSeat(plan, seat, player, setup);
            if (error) throw new Error('Tile placement for ' + bot.name + ': ' + error);
            await emit(sockets[index], 'placement:action', { o: seat.o, cell: seat.cell });
        }
        const starts = await within(Promise.all(started), 12000, 'game start');
        assert.notEqual(starts[0].yourIndex, starts[1].yourIndex);
        assert.equal(starts[0].turn.total, 60000);
        policies.forEach((worker, index) => worker.send({
            type: 'start', game: lobby.sessionId, players: 2, seat: starts[index].yourIndex,
            settings: { turnTime: config.turnTime, turnCapMs: starts[0].turn.total },
        }));
        let state = starts[0].state, moves = 0;
        let turnDeadline = Date.now() + starts[0].turn.left;
        while (!state.over) {
            assert(!flag, 'a player reached the server turn clock');
            assert(moves < 3000, 'fixture exceeded the maximum driver action count');
            const index = starts.findIndex(start => start.yourIndex === state.cur);
            assert(index >= 0, 'only the two bot accounts take turns');
            const worker = policies[index];
            const leftMs = Math.max(1, turnDeadline - Date.now());
            worker.send({
                type: 'act', game: lobby.sessionId, state, clock: { leftMs, overheadMs: 350 },
                timeout_ms: Math.max(1, leftMs - 350),
            });
            const response = await worker.read(leftMs);
            if (response.type !== 'action') throw new Error(bots[index].name + ': ' + response.message);
            const { action } = response;
            const prior = JSON.stringify(state);
            const next = received(sockets[index], 'state:update', message => JSON.stringify(message.state) !== prior);
            try {
                await emit(sockets[index], 'action', action);
            } catch (err) {
                if (++refusals > 12 || !err.message.startsWith('action:')) throw err;
                worker.send({ type: 'refused', game: lobby.sessionId, action, error: err.message, tries_left: 4 });
                console.warn(bots[index].name + ' rejected ' + action.type + ': ' + err.message);
                continue;
            }
            const updated = await within(next, 10000, 'authoritative state update');
            state = updated.state;
            if (updated.turn?.left != null) turnDeadline = Date.now() + updated.turn.left;
            moves++;
            await delay(40);
        }
        assert(!flag, 'a player reached the server turn clock');
        const record = await within(recorded, 20000, 'stored match and replay');
        assert(record.replay, 'server saved its normal replay');
        const { body: game } = await request('/api/games/' + record.id);
        assert.equal(game.version, version);
        assert.deepEqual(game.players.map(p => p.name).sort(), bots.map(b => b.name).sort());
        assert(game.players.every(p => config.ranked ? typeof p.mmrShift === 'number' : p.mmrShift === null));
        const won = name => Boolean(game.players.find(p => p.name === name)?.isWinner);
        const score = won(fixture.a) === won(fixture.b) ? 0.5 : Number(won(fixture.a));
        return { gameId: record.id, rounds: game.rounds, score, refusals };
    } finally {
        for (const policy of policies) policy.close();
        for (const socket of sockets) socket.disconnect();
    }
}

async function main() {
    if (!base || !source || !journal) throw new Error('Expected URL, bot roster or Hans executable, and journal path');
    assert(new URL(base).port === '8183' || new URL(base).hostname === 'localhost', 'use the private Arena preview');
    const homepage = await fetch(base + '/').then(response => response.text());
    assert(homepage.includes('/client/arena-preview.js'), 'server has the Arena preview enabled');
    const accounts = new Map(JSON.parse(fs.readFileSync(0, 'utf8').trim()).map(bot => [bot.name, bot]));
    assert.equal(accounts.size, 6);
    const roster = source.endsWith('.json') ? JSON.parse(fs.readFileSync(source, 'utf8')) : null;
    if (roster) assert.deepEqual([...accounts.keys()], roster.bots.map(bot => bot.name));
    config.ranked = roster?.ranked === true;
    for (const bot of accounts.values()) {
        Object.assign(bot, roster?.bots.find(spec => spec.name === bot.name) || { command: [source, ...bot.args] });
        const login = await request('/api/auth/bot', null, { token: bot.token });
        assert.equal(login.body.username, bot.name);
        assert(login.cookie, 'server set a bot session cookie');
        bot.cookie = login.cookie;
        if (roster) {
            const entry = await request('/api/arena-preview/opt-in', bot.cookie);
            assert.equal(entry.body.optedIn, true, bot.name + ' must opt in before kickoff');
        }
    }
    const entrants = [...accounts.keys()];
    const event = fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal, 'utf8')) : {
        id: roster?.id || 'lab-round-robin-1', name: roster?.name || 'Lab Round Robin 1', version,
        date: new Date().toISOString().slice(0, 10), turnSeconds: config.turnTime,
        mapKey: config.mapKey, wonders: config.wonders, expCivs: config.expCivs, ranked: config.ranked,
        entrants, builds: Object.fromEntries(roster?.bots.map(bot => [bot.name, bot.build]) || []),
        fixtures: roundRobin(entrants),
    };
    assert.equal(event.version, version);
    assert.equal(event.ranked, config.ranked);
    assert.deepEqual(event.entrants, entrants);
    const save = () => {
        fs.writeFileSync(journal + '.new', JSON.stringify(event, null, 2) + '\n');
        fs.renameSync(journal + '.new', journal);
    };
    save();
    const rounds = Map.groupBy(event.fixtures.filter(fixture => !fixture.gameId), fixture => fixture.round);
    for (const [round, fixtures] of rounds) {
        const outcomes = await Promise.allSettled(fixtures.map(async fixture => {
            const outcome = await play(fixture, accounts, save);
            Object.assign(fixture, outcome);
            save();
            console.log(JSON.stringify({ round, a: fixture.a, b: fixture.b, ...outcome }));
        }));
        const failures = outcomes.filter(outcome => outcome.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(failure => failure.reason), 'Round ' + round + ' did not finish');
    }
    console.log('Finished ' + event.fixtures.length + ' fixtures.');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
