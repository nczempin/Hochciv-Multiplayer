/**
 * RNG state & unrevealed pre-game information sanitization (#1) against the local docker setup:
 *
 *   docker compose -f docker-compose.local.yml up -d --build
 *   npm i --no-save playwright-core
 *   node tests/security/rng-leak.test.js [http://localhost:3000]
 *
 * Unit (all shipped engine adapters current, v106, v100, v98, sessions, async/logic, sockets/game):
 *   · positive [1, 2^31 - 1] CSPRNG seeds everywhere (never 0)
 *   · stateForPlayer strips seed, fixedDice, players[*].kiRng and masks evNext unless pi owns 'orakel'
 *   · ensureOracleEvent pre-rolls evNext on authoritative state when 'orakel' is owned
 *   · sockets/game broadcastState emits evNext only to the 'orakel' owner and never to opponents/spectators
 *   · async/logic view() sanitizes state & draft.V and draws a fresh seed after pre-phases
 *
 * End-to-end HTTP + Socket.IO + Playwright against BASE:
 *   · POST /api/sessions and lobby:config strip client seed / fixedDice from public gameConfig
 *   · live Plättchen placement omits seed and masks other seats (both human and KI); spectator gets { spectator: true }
 *   · #pl-world and #pl-tech work without errors; after placement S has no seed/fixedDice/kiRng
 *   · live Marathon draft omits V.seed and completes cleanly into game:start without S.seed
 *   · finished live replay (?replay=<id> and GET /api/games/:id/replay) works cleanly
 *   · Rundenspiel Oracle ('orakel') shows predicted evNext in World modal only to owner, null to opponent/spectator
 *
 * Test accounts, replays, and games are deleted afterwards. Uses an installed Chrome or Edge;
 * set HOCHCIV_BROWSER to its path if it is not found.
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

const engine = require('../../engine-adapter');
const sessions = require('../../sessions');
const asyncLogic = require('../../async/logic');
const challenge = require('../../utils/challenge');
const registerGameHandlers = require('../../sockets/game');

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const CONTAINER = process.env.HOCHCIV_CONTAINER || 'hochciv-multiplayer-local';
const DB_CONTAINER = process.env.HOCHCIV_DB_CONTAINER || 'hochciv-db';
const BROWSER = process.env.HOCHCIV_BROWSER || [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(p => fs.existsSync(p));

let failed = 0;
const ok = (cond, name, info) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? '  (' + info + ')' : ''}`);
    if (!cond) failed++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isPositiveSeed = n => Number.isInteger(n) && n >= 1 && n <= 0x7fffffff;

const inServer = code => execFileSync('docker', ['exec', '-i', '-w', '/app', CONTAINER, 'node', '-'], { input: code })
    .toString().trim().split('\n').filter(l => !/Engine Adapter/.test(l)).join('\n');
const sql = q => execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'hochciv', '-d', 'hochciv', '-tAc', q])
    .toString().trim();

const PASSWORD = 'Test-' + crypto.randomBytes(6).toString('hex');
function makeUser(prefix = 'rng_') {
    const name = prefix + crypto.randomBytes(3).toString('hex');
    const id = inServer(`const { User } = require('./models'); const bcrypt = require('bcryptjs');
        User.create({ username: '${name}', email: '${name}@example.com', password_hash: bcrypt.hashSync('${PASSWORD}', 10),
            isActive: true, emailOtpEnabled: false, notifyEmail: false })
            .then(u => { console.log(u.id); process.exit(0); })`);
    return { name, id };
}

function unitEngineAndLogic() {
    const versions = ['current', ...engine.OLD_VERSIONS];
    for (const ver of versions) {
        const adapter = ver === 'current' ? engine : engine.forVersion(ver);
        const eng = adapter.getEngine();
        const origNewGame = eng.newGame;
        let seenSeed = null;
        eng.newGame = function (cfg) { seenSeed = cfg.seed; return origNewGame.apply(this, arguments); };
        let s0;
        try {
            s0 = adapter.createGame({
                gameConfig: { mapKey: '0', seed: 0, fixedDice: 123456, events: true, wonders: true, difficulty: 'mittel' },
                players: [
                    { civ: 'griechenland', ability: 'basis', kind: 'human', name: 'P0' },
                    { civ: 'russland', ability: 'basis', kind: 'ki', name: 'P1' },
                    { civ: 'england', ability: 'basis', kind: 'human', name: 'P2' },
                    { civ: 'aegypten', ability: 'basis', kind: 'human', name: 'P3' },
                ],
            });
        } finally {
            eng.newGame = origNewGame;
        }
        ok(isPositiveSeed(seenSeed) && s0.seed !== 0,
            `unit (${ver}): createGame turns seed=0 into positive [1, 2^31-1]`, `initial=${seenSeed}, postNewGame=${s0.seed}`);
        const kiIdx = s0.players.findIndex(p => p.kind === 'ki');
        if (kiIdx >= 0) s0.players[kiIdx].kiRng = 987654321;

        const clean0 = adapter.stateForPlayer(s0, 0);
        ok(clean0.seed === undefined && clean0.fixedDice === undefined && clean0.players.every(p => p.kiRng === undefined)
            && clean0.evNext === null, `unit (${ver}): stateForPlayer strips seed, fixedDice, kiRng, evNext`);

        // Without Oracle owner, evNext stays null on authoritative state
        ok(s0.evNext === null, `unit (${ver}): evNext remains null when nobody owns orakel`);

        // Give seat 0 'orakel' and reset evNext; pre-roll must happen lazily for opponent/spectator views too
        const human0 = s0.players.findIndex(p => p.kind === 'human');
        const human1 = s0.players.findIndex((p, i) => i !== human0 && p.kind === 'human');
        s0.wonders = s0.wonders || [];
        s0.wonders.push({ owner: human0, k: 'orakel', cityId: 0 });
        s0.evNext = null;
        const specView = adapter.stateForPlayer(s0, -1);
        const oppView = adapter.stateForPlayer(s0, human1);
        const ownerView = adapter.stateForPlayer(s0, human0);
        ok(!!s0.evNext && typeof s0.evNext.row === 'number', `unit (${ver}): ensureOracleEvent populates S.evNext on server`);
        ok(specView.evNext === null && oppView.evNext === null, `unit (${ver}): spectator and non-owner get evNext=null even with Oracle active`);
        ok(ownerView.evNext && ownerView.evNext.row === s0.evNext.row && ownerView.evNext.col === s0.evNext.col
            && ownerView.seed === undefined && ownerView.fixedDice === undefined,
            `unit (${ver}): Oracle owner gets evNext while seed & fixedDice remain stripped`);
    }

    // Sessions seed & config sanitization
    const created = sessions.createSession({ mapKey: '0', seed: 0, fixedDice: 77 }, { name: 'H', clientId: 'h0' });
    const sess = sessions.getSession(created.sessionId);
    const seedA = sess.gameConfig.seed;
    ok(isPositiveSeed(seedA), 'unit (sessions): createSession coerces non-positive seed to [1, 2^31-1]', String(seedA));
    sessions.updateConfig(created.sessionId, { seed: 42, fixedDice: 99, map: { x: 1 }, setup: { y: 2 }, wonders: true });
    const pub = sessions.publicGameConfig(sess.gameConfig);
    ok(sess.gameConfig.seed === seedA && sess.gameConfig.fixedDice === 77 && sess.gameConfig.wonders === true
        && pub.seed === undefined && pub.fixedDice === undefined && pub.map === undefined && pub.setup === undefined,
        'unit (sessions): updateConfig ignores seed/fixedDice/map/setup and publicGameConfig strips them');
    sess.players[0].connected = true;
    sess.status = 'finished';
    sessions.resetForRematch(created.sessionId);
    ok(isPositiveSeed(sess.gameConfig.seed) && sess.gameConfig.seed !== seedA,
        'unit (sessions): resetForRematch picks a fresh positive seed');
    sessions.removeSession(created.sessionId);

    // Challenge positive seed
    const chSetup = challenge.setupOf('2026-W45');
    ok(isPositiveSeed(chSetup.seed), 'unit (challenge): setupOf seed is positive in [1, 2^31-1]', String(chSetup.seed));

    // Marathon draft sanitization + finishDraft reseed
    const draftSession = {
        gameConfig: { mapKey: 'marathon', events: true, wonders: true, difficulty: 'mittel' },
        players: [
            { civ: 'griechenland', ability: 'basis', kind: 'human', name: 'D0' },
            { civ: 'russland', ability: 'basis', kind: 'ki', name: 'KI1' },
        ],
    };
    engine.startDraft(draftSession);
    const draftSeed = draftSession.gameConfig.seed;
    const payload = engine.draftPayload(draftSession);
    ok(isPositiveSeed(draftSeed) && payload && payload.V && payload.V.seed === undefined
        && payload.V.fixedDice === undefined && payload.V.players.every(p => p.kiRng === undefined),
        'unit (marathon): draftPayload strips V.seed, V.fixedDice and V.players[*].kiRng');
    const draftStateAfter = engine.finishDraft(draftSession);
    ok(isPositiveSeed(draftSession.gameConfig.seed) && draftSession.gameConfig.seed !== draftSeed && draftStateAfter.seed !== 0,
        'unit (marathon): finishDraft draws a fresh live game seed');

    // Async logic: create, placement reseed, draft sanitization, Oracle view()
    const u0 = { id: '00000000-0000-0000-0000-0000000000a1', username: 'AsyncA' };
    const u1 = { id: '00000000-0000-0000-0000-0000000000a2', username: 'AsyncB' };
    const asyncFixed = asyncLogic.create(u0, { config: { mapKey: '0', civMode: 'random', playerCount: 4, kiCount: 2, events: true, wonders: true } }).g;
    ok(isPositiveSeed(asyncFixed.config.seed), 'unit (async): create() sets positive seed');
    asyncLogic.join(asyncFixed, u1, {});
    const vBefore = asyncLogic.view(asyncFixed, u0.id);
    ok(vBefore.config.seed === undefined && vBefore.config.fixedDice === undefined
        && vBefore.state.seed === undefined && vBefore.state.fixedDice === undefined
        && vBefore.state.players.every(p => p.kiRng === undefined) && vBefore.state.evNext === null,
        'unit (async): view() strips state RNG fields and config seeds');
    const aIdx0 = asyncLogic.stateIndex(asyncFixed, asyncFixed.seats.find(s => s.userId === u0.id).slot);
    asyncFixed.state.wonders.push({ owner: aIdx0, k: 'orakel', cityId: 0 });
    asyncFixed.state.evNext = null;
    const vOwner = asyncLogic.view(asyncFixed, u0.id);
    const vOpp = asyncLogic.view(asyncFixed, u1.id);
    const vSpec = asyncLogic.view(asyncFixed, '00000000-0000-0000-0000-0000000000ff');
    ok(!!vOwner.state.evNext && vOpp.state.evNext === null && vSpec.state.evNext === null,
        'unit (async): Oracle evNext visible only to owner in view()');

    // Async placement reseed
    const asyncTile = asyncLogic.create(u0, { config: { mapKey: 'plaettchen', civMode: 'random', playerCount: 2, kiCount: 0 } }).g;
    const preSeedTile = asyncTile.config.seed;
    asyncLogic.join(asyncTile, u1, {});
    for (const u of [u0, u1]) {
        const seat = asyncLogic.seatOf(asyncTile, u.id);
        const ps = asyncTile.pre.plan.seats.find(s => s.idx === seat.slot);
        let placed = false;
        for (let o = 0; o < 3 && !placed; o++) {
            const opts = engine.getEngine().placeOptions(asyncTile.pre.plan, ps, o);
            const cell = opts.indexOf(true);
            if (cell >= 0) {
                const err = asyncLogic.place(asyncTile, u.id, o, cell);
                if (!err) placed = true;
            }
        }
    }
    ok(asyncTile.status === 'playing' && isPositiveSeed(asyncTile.config.seed)
        && asyncTile.config.seed !== preSeedTile && asyncTile.state.seed !== 0,
        'unit (async): placement transition draws a fresh live game seed');

    // Async marathon draft V sanitization + reseed
    const asyncMar = asyncLogic.create(u0, { config: { mapKey: 'marathon', civMode: 'random', playerCount: 4, kiCount: 2 } }).g;
    const preSeedMar = asyncMar.config.seed;
    asyncLogic.join(asyncMar, u1, {});
    const vDraft = asyncLogic.view(asyncMar, u0.id);
    ok(vDraft.draft && vDraft.draft.V && vDraft.draft.V.seed === undefined
        && vDraft.draft.V.fixedDice === undefined && vDraft.draft.V.players.every(p => p.kiRng === undefined),
        'unit (async): marathon view().draft.V strips seed/fixedDice/kiRng');
    while (asyncMar.status === 'draft') {
        const curSlot = asyncMar.pre.draft.V.players[asyncMar.pre.draft.D.order[asyncMar.pre.draft.D.at]].slot;
        const owner = asyncMar.seats[curSlot].userId;
        const pickId = asyncMar.pre.draft.D.pool[0];
        asyncLogic.draftPick(asyncMar, owner, pickId);
    }
    ok(asyncMar.status === 'playing' && isPositiveSeed(asyncMar.config.seed)
        && asyncMar.config.seed !== preSeedMar && asyncMar.state.seed !== 0,
        'unit (async): marathon transition draws a fresh live game seed');
}

function unitSocketBroadcast() {
    const sockets = new Map();
    const emittedBySocket = new Map();
    const roomBroadcasts = [];
    const handlers = new Set();
    const mockIo = {
        on(ev, fn) { if (ev === 'connection') handlers.add(fn); },
        to(target) {
            return {
                emit(ev, data) {
                    if (sockets.has(target)) emittedBySocket.get(target).push({ ev, data });
                    else roomBroadcasts.push({ target, ev, data });
                },
            };
        },
        sockets: { sockets },
    };
    const makeMockSocket = id => {
        const evHandlers = new Map();
        const sock = {
            id,
            request: { user: null },
            rooms: new Set(),
            join(r) { this.rooms.add(r); },
            leave(r) { this.rooms.delete(r); },
            emit(ev, data) { emittedBySocket.get(id).push({ ev, data }); },
            on(ev, fn) { evHandlers.set(ev, fn); },
            trigger(ev, data) {
                return new Promise(res => {
                    const fn = evHandlers.get(ev);
                    if (!fn) return res(undefined);
                    fn(data, res);
                });
            },
        };
        sockets.set(id, sock);
        emittedBySocket.set(id, []);
        for (const h of handlers) h(sock);
        return sock;
    };

    registerGameHandlers(mockIo);
    const created = sessions.createSession({ mapKey: '0', playerCount: 4, kiCount: 2, events: true, wonders: true }, { name: 'A', clientId: 'sockA', civ: 'griechenland' });
    const joined = sessions.joinSession(created.joinCode, created.password, { name: 'B', clientId: 'sockB', civ: 'russland' });
    const watched = sessions.addSpectator(created.joinCode, created.password, { name: 'Spec', clientId: 'sockW' });
    const s = sessions.getSession(created.sessionId);

    const sA = makeMockSocket('sA');
    const sB = makeMockSocket('sB');
    const sW = makeMockSocket('sW');

    return (async () => {
        try {
            const ackA = await sA.trigger('session:connect', { sessionId: created.sessionId, password: created.password, clientId: 'sockA' });
            const ackB = await sB.trigger('session:connect', { sessionId: created.sessionId, password: created.password, clientId: 'sockB' });
            const ackW = await sW.trigger('session:connect', { sessionId: created.sessionId, password: created.password, clientId: 'sockW' });
            ok(ackA.gameConfig.seed === undefined && ackB.gameConfig.seed === undefined && ackW.gameConfig.seed === undefined,
                'unit (socket): session:connect ack strips gameConfig.seed for players & spectators');

            const startAck = await sA.trigger('game:start', {});
            const st = s.state;
            ok(startAck && startAck.ok && !!st && st.ev, 'unit (socket): game started with events enabled', JSON.stringify(startAck));

            // Give the non-current human player 'orakel' and reset evNext; current player ends turn to trigger broadcastState
            const idxA = engine.stateIndexOf(st, 0, s.players[0]);
            const idxB = engine.stateIndexOf(st, 1, s.players[1]);
            const curSock = st.cur === idxA ? sA : sB;
            const curKey = curSock === sA ? 'sA' : 'sB';
            const ownerKey = curSock === sA ? 'sB' : 'sA';
            const ownerIdx = curSock === sA ? idxB : idxA;
            st.wonders.push({ owner: ownerIdx, k: 'orakel', cityId: 0 });
            st.evNext = null;

            emittedBySocket.get('sA').length = 0;
            emittedBySocket.get('sB').length = 0;
            emittedBySocket.get('sW').length = 0;
            roomBroadcasts.length = 0;

            await curSock.trigger('action', { type: 'endTurn', params: {} });

            const updOwner = emittedBySocket.get(ownerKey).find(e => e.ev === 'state:update');
            const updOpp = emittedBySocket.get(curKey).find(e => e.ev === 'state:update');
            const updW = emittedBySocket.get('sW').find(e => e.ev === 'state:update');
            const roomUpd = roomBroadcasts.find(e => e.ev === 'state:update');
            ok(!roomUpd, 'unit (socket): broadcastState switches to per-recipient emits when Oracle evNext is active');
            ok(!!updOwner && !!updOwner.data.state.evNext && updOwner.data.state.seed === undefined && updOwner.data.state.fixedDice === undefined,
                'unit (socket): Oracle owner receives evNext in state:update without seed');
            ok(!!updOpp && updOpp.data.state.evNext === null && updOpp.data.state.seed === undefined,
                'unit (socket): opponent receives evNext=null in state:update without seed');
            ok(!!updW && updW.data.state.evNext === null && updW.data.state.seed === undefined,
                'unit (socket): spectator receives evNext=null in state:update without seed');
            ok(joined.playerIndex === 1 && watched.spectator === true, 'unit (socket): test setup sanity');
        } finally {
            clearInterval(mockIo.__syncInterval);
            clearInterval(mockIo.__turnInterval);
            sessions.removeSession(created.sessionId);
        }
    })();
}

function getReplayHttp(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }).on('error', reject);
    });
}

async function e2eLivePlacementAndReplay(browser, errors, cleanupGameIds) {
    const newPage = async name => {
        const ctx = await browser.newContext({ locale: 'de-DE' });
        const page = await ctx.newPage();
        page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
        await page.goto(BASE + '/');
        await page.waitForFunction(() => typeof MP !== 'undefined' && typeof io === 'function');
        await page.evaluate(() => MP.showLobby());
        await page.waitForFunction(() => typeof MP.setMode === 'function');
        return page;
    };

    const a = await newPage('PlA'), b = await newPage('PlB'), w = await newPage('PlW');

    // Host creates session via REST explicitly passing untrusted seed/fixedDice to verify server strips them
    const createRes = await a.evaluate(async () => {
        const cid = MP.getClientId();
        const r = await fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                config: { mapKey: '0', seed: 42, fixedDice: 99, isPublic: false },
                host: { name: 'SecA', clientId: cid },
            }),
        });
        return r.json();
    });
    ok(!!createRes.sessionId, 'e2e: created live session with injected seed payload');

    const attachSocketMonitor = async page => page.evaluate(() => {
        window.__secEvents = [];
        const origConnect = MP.connect.bind(MP);
        MP.connect = async function () {
            await origConnect();
            if (!MP.__secHooked && MP.socket) {
                MP.__secHooked = true;
                for (const ev of ['lobby:config:update', 'placement:start', 'draft:update', 'game:start', 'state:update']) {
                    MP.socket.on(ev, payload => window.__secEvents.push({ ev, payload }));
                }
            }
        };
    });
    await Promise.all([attachSocketMonitor(a), attachSocketMonitor(b), attachSocketMonitor(w)]);

    // Connect A to the created session
    const ackA = await a.evaluate(async res => {
        MP.sessionId = res.sessionId;
        MP.joinCode = res.joinCode;
        MP.password = res.password;
        MP.lobbyIndex = 0;
        await MP.connect();
        return new Promise(r => MP.socket.emit('session:connect', {
            sessionId: res.sessionId, clientId: MP.getClientId(), password: res.password,
        }, ack => {
            MP.active = true; MP.spectator = false; MP.players = ack.players; MP.gameConfig = ack.gameConfig;
            MP.hostIndex = ack.hostIndex; MP.showCred(); MP.setMode('waiting');
            r(ack);
        }));
    }, createRes);
    ok(ackA.ok && ackA.gameConfig.seed === undefined && ackA.gameConfig.fixedDice === undefined,
        'e2e: POST /api/sessions + session:connect strip injected seed and fixedDice');

    // B joins and W watches
    await b.evaluate(() => MP.setMode('join'));
    await b.fill('#mp-c', createRes.joinCode);
    await b.fill('#mp-p', createRes.password);
    await b.fill('#mp-n', 'SecB');
    await b.evaluate(() => MP.join());
    await b.waitForSelector('#mp-p-civ-1');

    await w.evaluate(() => MP.setMode('join'));
    await w.fill('#mp-c', createRes.joinCode);
    await w.fill('#mp-p', createRes.password);
    await w.fill('#mp-n', 'SecWatcher');
    await w.click('.mph-code button:has-text("Zuschauen")');
    await w.waitForSelector('text=Du schaust zu');
    ok(await w.evaluate(() => MP.gameConfig.seed === undefined && MP.gameConfig.fixedDice === undefined),
        'e2e: spectator session:connect strips seed & fixedDice');

    // Host injects seed/fixedDice into lobby:config on tile map + 1 KI
    await a.evaluate(() => new Promise(r => MP.socket.emit('lobby:config', {
        mapKey: 'random', playerCount: 3, kiCount: 1, wonders: true, events: true, seed: 77, fixedDice: 88,
    }, r)));
    await Promise.all([
        a.waitForFunction(() => MP.gameConfig.mapKey === 'random' && MP.gameConfig.playerCount === 3),
        b.waitForFunction(() => MP.gameConfig.mapKey === 'random' && MP.gameConfig.playerCount === 3),
        w.waitForFunction(() => MP.gameConfig.mapKey === 'random' && MP.gameConfig.playerCount === 3),
    ]);
    const updEv = await b.evaluate(() => window.__secEvents.find(e => e.ev === 'lobby:config:update').payload);
    ok(updEv.seed === undefined && updEv.fixedDice === undefined && updEv.seed !== 77,
        'e2e: lobby:config:update strips seed & fixedDice');

    // Start Plättchen placement
    await a.evaluate(() => MP.startGame());
    await Promise.all([
        a.waitForFunction(() => document.getElementById('screen-place').classList.contains('show') && typeof placeState === 'object' && placeState),
        b.waitForFunction(() => document.getElementById('screen-place').classList.contains('show') && typeof placeState === 'object' && placeState),
        w.waitForFunction(() => (window.__secEvents || []).some(e => e.ev === 'placement:start')),
    ]);

    const checkPlacementPayload = async (page, label) => page.evaluate(() => {
        const ev = (window.__secEvents || []).find(e => e.ev === 'placement:start');
        const p = ev && ev.payload;
        if (!p || !p.plan || !p.cfg) return { ok: false, p };
        const maskedOthers = p.plan.seats
            .filter(s => s.idx !== MP.lobbyIndex)
            .every(s => s.o === null && s.cell === null);
        return {
            ok: p.seed === undefined && p.cfg.seed === undefined && p.cfg.fixedDice === undefined
                && !!p.setup && maskedOthers && p.plan.seats.some(s => s.idx === MP.lobbyIndex),
            seed: p.seed,
            cfgSeed: p.cfg.seed,
            maskedOthers,
            seats: p.plan.seats,
        };
    }).then(r => ok(r.ok, `e2e: ${label} placement:start omits seed and masks all other seats (human + KI)`, JSON.stringify(r)));

    await checkPlacementPayload(a, 'Host A');
    await checkPlacementPayload(b, 'Player B');
    const wPlace = await w.evaluate(() => (window.__secEvents || []).find(e => e.ev === 'placement:start').payload);
    ok(wPlace && wPlace.spectator === true && wPlace.plan === undefined && wPlace.setup === undefined && wPlace.seed === undefined,
        'e2e: spectator placement:start receives only { spectator: true }', JSON.stringify(wPlace));

    // Verify #pl-world and #pl-tech work cleanly during placement without data.seed
    await a.click('#pl-world');
    await a.waitForSelector('#ov-body .civ-row');
    await a.evaluate(() => closeModal());
    await a.click('#pl-tech');
    await a.waitForSelector('#ov-body');
    await a.evaluate(() => closeModal());

    // Place start tiles on both humans
    const placeMine = async page => {
        await page.evaluate(() => {
            const st = placeState, seat = st.queue[st.at];
            const opts = placeOptions(st.plan, seat, st.o);
            const [r, c] = slotRC(st.plan, seat.slot)[opts.indexOf(true)];
            plTap(r, c);
        });
        await page.click('#pl-ok');
    };
    await placeMine(a);
    await placeMine(b);

    await Promise.all([a, b, w].map(p => p.waitForFunction(
        () => typeof S !== 'undefined' && S && document.getElementById('screen-game').classList.contains('show'),
        null, { timeout: 30000 })));

    for (const [label, p] of [['Host A', a], ['Player B', b], ['Spectator', w]]) {
        const clean = await p.evaluate(() => ({
            seed: S.seed, fixedDice: S.fixedDice, evNext: S.evNext,
            kiRng: S.players.some(pl => pl.kiRng !== undefined),
        }));
        ok(clean.seed === undefined && clean.fixedDice === undefined && !clean.kiRng && clean.evNext === null,
            `e2e: ${label} live S has no seed/fixedDice/kiRng and evNext=null`, JSON.stringify(clean));
    }

    // Finish a 2-human duel cleanly via resign to verify replay still works
    await Promise.all([a.context().close(), b.context().close(), w.context().close()]);

    const da = await newPage('RepA'), db = await newPage('RepB');
    await da.evaluate(() => MP.setMode('host'));
    await da.fill('#mp-n', 'RepHost');
    await da.evaluate(() => MP.host());
    await da.waitForSelector('#mp-p-civ-0');
    const repCred = await da.evaluate(() => ({ code: MP.joinCode, pw: MP.password }));
    await db.evaluate(() => MP.setMode('join'));
    await db.fill('#mp-c', repCred.code); await db.fill('#mp-p', repCred.pw); await db.fill('#mp-n', 'RepGuest');
    await db.evaluate(() => MP.join());
    await db.waitForSelector('#mp-p-civ-1');
    await da.evaluate(() => new Promise(r => MP.socket.emit('lobby:config', { mapKey: 'random', playerCount: 2, kiCount: 0 }, r)));
    await da.waitForFunction(() => MP.gameConfig.mapKey === 'random' && MP.gameConfig.playerCount === 2 && MP.gameConfig.kiCount === 0);
    await da.evaluate(() => MP.startGame());
    await Promise.all([da, db].map(p => p.waitForFunction(
        () => document.getElementById('screen-place').classList.contains('show') && typeof placeState === 'object' && !!placeState,
        null, { timeout: 20000 })));
    await placeMine(da);
    await placeMine(db);
    await Promise.all([da, db].map(p => p.waitForFunction(
        () => typeof S !== 'undefined' && S && document.getElementById('screen-game').classList.contains('show'),
        null, { timeout: 20000 })));
    await db.evaluate(() => new Promise(r => MP.socket.emit('game:resign', {}, r)));
    await da.waitForFunction(() => !!(MP.lastRecord && MP.lastRecord.id), null, { timeout: 20000 });
    const record = await da.evaluate(() => MP.lastRecord);
    if (record && record.id) cleanupGameIds.push(record.id);
    const replayRes = await getReplayHttp(`${BASE}/api/games/${record.id}/replay`);
    let parsedReplay = null;
    try { parsedReplay = JSON.parse(replayRes.body); } catch (_) { }
    ok(replayRes.status === 200 && parsedReplay && Array.isArray(parsedReplay.frames) && parsedReplay.frames.length >= 1,
        'e2e: finished game replay API still serves valid frames', `${replayRes.status} frames=${parsedReplay && parsedReplay.frames && parsedReplay.frames.length}`);

    const rp = await newPage('RepViewer');
    await rp.goto(`${BASE}/?replay=${record.id}`);
    await rp.waitForFunction(() => typeof S !== 'undefined' && S && document.getElementById('screen-game').classList.contains('show'), null, { timeout: 20000 });
    ok(await rp.evaluate(() => document.getElementById('screen-game').classList.contains('show')),
        'e2e: ?replay=<id> viewer opens finished replay without error');

    await Promise.all([da.context().close(), db.context().close(), rp.context().close()]);
}

async function e2eLiveMarathonDraft(browser, errors) {
    const newPage = async name => {
        const ctx = await browser.newContext({ locale: 'de-DE' });
        const page = await ctx.newPage();
        page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
        await page.goto(BASE + '/');
        await page.waitForFunction(() => typeof MP !== 'undefined');
        await page.evaluate(() => MP.showLobby());
        await page.waitForFunction(() => typeof MP.setMode === 'function');
        return page;
    };
    const ma = await newPage('MarA'), mb = await newPage('MarB');
    try {
        for (const page of [ma, mb]) {
            await page.evaluate(() => {
                window.__draftEvents = [];
                const origConnect = MP.connect.bind(MP);
                MP.connect = async function () {
                    await origConnect();
                    if (!MP.__draftHooked && MP.socket) {
                        MP.__draftHooked = true;
                        MP.socket.on('draft:update', p => window.__draftEvents.push(p));
                    }
                };
            });
        }
        await ma.evaluate(() => MP.setMode('host'));
        await ma.fill('#mp-n', 'MarA');
        await ma.evaluate(() => MP.host());
        await ma.waitForSelector('#mp-p-civ-0');
        const cred = await ma.evaluate(() => ({ code: MP.joinCode, pw: MP.password }));
        await mb.evaluate(() => MP.setMode('join'));
        await mb.fill('#mp-c', cred.code); await mb.fill('#mp-p', cred.pw); await mb.fill('#mp-n', 'MarB');
        await mb.evaluate(() => MP.join());
        await mb.waitForSelector('#mp-p-civ-1');
        await mb.selectOption('#mp-p-civ-1', 'russland');
        await ma.waitForFunction(() => MP.players.length === 2 && MP.players[1].civ === 'russland');
        await ma.evaluate(() => new Promise(r => MP.socket.emit('lobby:config', { mapKey: 'marathon', playerCount: 4, kiCount: 2 }, r)));
        await ma.waitForFunction(() => MP.gameConfig.mapKey === 'marathon');
        await ma.evaluate(() => MP.startGame());

        await Promise.all([ma, mb].map(p => p.waitForFunction(
            () => document.getElementById('screen-draft').classList.contains('show') && (window.__draftEvents || []).length > 0,
            null, { timeout: 20000 })));
        const dPay = await ma.evaluate(() => window.__draftEvents[0]);
        ok(dPay && dPay.V && dPay.V.seed === undefined && dPay.V.fixedDice === undefined
            && dPay.V.players.every(p => p.kiRng === undefined),
            'e2e (marathon): draft:update strips V.seed, V.fixedDice, V.players[*].kiRng');

        // Both human players click their available draft picks until game:start arrives
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
            const bothStarted = await Promise.all([ma, mb].map(p => p.evaluate(
                () => typeof S !== 'undefined' && !!S && document.getElementById('screen-game').classList.contains('show'))));
            if (bothStarted.every(Boolean)) break;
            for (const p of [ma, mb]) {
                await p.evaluate(() => {
                    const btn = document.querySelector('#dr-pool [data-ab]:not([disabled])');
                    if (btn) btn.click();
                }).catch(() => { });
            }
            await sleep(150);
        }
        await Promise.all([ma, mb].map(p => p.waitForFunction(
            () => typeof S !== 'undefined' && !!S && document.getElementById('screen-game').classList.contains('show'),
            null, { timeout: 10000 })));
        ok(await ma.evaluate(() => S.seed === undefined && S.fixedDice === undefined),
            'e2e (marathon): game starts cleanly from sanitized draft without S.seed');
    } finally {
        await Promise.all([ma.context().close(), mb.context().close()]);
    }
}

async function e2eAsyncOracle(browser, errors) {
    const ua = makeUser('ora_a_'), ub = makeUser('ora_b_'), uc = makeUser('ora_w_');
    let gameId = null;
    try {
        const loginCtx = async u => {
            const ctx = await browser.newContext({ locale: 'de-DE' });
            const r = await ctx.request.post(BASE + '/api/auth/login', { data: { username: u.name, password: PASSWORD } });
            if (r.status() !== 200) throw new Error('login failed for ' + u.name);
            return ctx;
        };
        const ca = await loginCtx(ua), cb = await loginCtx(ub), cc = await loginCtx(uc);

        const created = await (await ca.request.post(BASE + '/api/async', {
            data: { config: { mapKey: '0', civMode: 'random', playerCount: 4, kiCount: 2, events: true, wonders: true, isPublic: true } },
        })).json();
        gameId = created.id;
        await cb.request.post(`${BASE}/api/async/${gameId}/join`, { data: { code: created.joinCode } });

        // Find whose turn it currently is in DB (`state` JSONB column) and grant that human 'orakel'
        const meta = JSON.parse(sql(`SELECT json_build_object(
            'cur', (state->>'cur')::int,
            'curSlot', (state->'players'->((state->>'cur')::int)->>'slot')::int,
            'aSlot', (SELECT (s->>'slot')::int FROM jsonb_array_elements(data->'seats') s WHERE s->>'userId' = '${ua.id}' LIMIT 1)
        )::text FROM async_games WHERE id = '${gameId}'`));
        const ownerUser = meta.curSlot === meta.aSlot ? ua : ub;
        const ownerCtx = ownerUser === ua ? ca : cb;
        const oppCtx = ownerUser === ua ? cb : ca;

        sql(`UPDATE async_games SET state = jsonb_set(
            jsonb_set(state, '{wonders}', COALESCE(state->'wonders', '[]'::jsonb) || '[{"owner":${meta.cur},"k":"orakel","cityId":0}]'::jsonb),
            '{evNext}', 'null'::jsonb
        ) WHERE id = '${gameId}'`);

        // Restart container once so async/service.js loads updated DB state instead of in-memory cache
        execFileSync('docker', ['restart', CONTAINER]);
        const waitEnd = Date.now() + 30000;
        while (Date.now() < waitEnd) {
            try {
                const ping = await getReplayHttp(BASE + '/');
                if (ping.status === 200) break;
            } catch (_) { }
            await sleep(400);
        }

        const openGame = async (ctx, name) => {
            const p = await ctx.newPage();
            p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
            await p.goto(BASE + '/');
            await p.waitForFunction(() => typeof ASYNC !== 'undefined' && typeof MP !== 'undefined');
            await p.evaluate(() => MP.fetchUser());
            await p.evaluate(id => ASYNC.open(id), gameId);
            await p.waitForFunction(() => typeof ASYNC.view === 'object' && !!ASYNC.view && typeof S !== 'undefined' && !!S
                && document.getElementById('screen-game').classList.contains('show'), null, { timeout: 20000 });
            const view = await p.evaluate(() => ASYNC.view);
            return { p, view };
        };

        const oRes = await openGame(ownerCtx, 'OraOwner');
        const pRes = await openGame(oppCtx, 'OraOpp');
        const wRes = await openGame(cc, 'OraSpec');

        ok(oRes.view.state.seed === undefined && oRes.view.state.fixedDice === undefined
            && oRes.view.state.players.every(pl => pl.kiRng === undefined) && !!oRes.view.state.evNext,
            'e2e (async oracle): owner receives evNext with seed/fixedDice/kiRng stripped',
            JSON.stringify(oRes.view.state.evNext));
        ok(pRes.view.state.seed === undefined && pRes.view.state.evNext === null,
            'e2e (async oracle): opponent receives evNext=null');
        ok(wRes.view.state.seed === undefined && wRes.view.state.evNext === null && wRes.view.myIndex === -1,
            'e2e (async oracle): spectator receives evNext=null');

        // Open World modal on owner page and verify Oracle prediction renders cleanly from server S.evNext
        await oRes.p.evaluate(() => worldModal());
        const worldText = await oRes.p.textContent('#ov-body');
        ok(/Das Orakel sieht für die nächste Runde:/.test(worldText),
            'e2e (async oracle): worldModal renders server-populated evNext without S.seed');

        await Promise.all([ca.close(), cb.close(), cc.close()]);
    } finally {
        if (gameId) sql(`DELETE FROM async_games WHERE id = '${gameId}'`);
        sql(`DELETE FROM users WHERE id IN ('${ua.id}', '${ub.id}', '${uc.id}')`);
    }
}

(async () => {
    try {
        unitEngineAndLogic();
        await unitSocketBroadcast();
    } catch (err) {
        ok(false, 'unit', err.stack || String(err));
    }

    const { chromium } = require('playwright-core');
    const browser = await chromium.launch({ executablePath: BROWSER, args: ['--disable-gpu', '--disable-dev-shm-usage'] });
    const errors = [];
    const cleanupGameIds = [];
    try {
        await e2eLivePlacementAndReplay(browser, errors, cleanupGameIds);
        await e2eLiveMarathonDraft(browser, errors);
        await e2eAsyncOracle(browser, errors);
        ok(errors.length === 0, 'no page errors', errors.join(' | '));
    } catch (err) {
        ok(false, 'e2e', err.stack || String(err));
    } finally {
        await browser.close();
        if (cleanupGameIds.length) {
            const list = cleanupGameIds.map(id => `'${id}'`).join(',');
            sql(`DELETE FROM replays WHERE "gameId" IN (${list})`);
            sql(`DELETE FROM games WHERE id IN (${list})`);
        }
    }
    console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
    process.exit(failed ? 1 : 0);
})();
