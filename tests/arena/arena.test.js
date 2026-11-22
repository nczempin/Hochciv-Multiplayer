/**
 * Tiled Bot Arena against the local docker setup:
 *
 *   Run a private server with ARENA_INTERVAL_MS=200 and ARENA_TTL_MS=3000.
 *   Install playwright-core and set HOCHCIV_ARENA_TEST_BOT to the native Hans binary.
 *   node tests/arena/arena.test.js http://localhost:3000
 *
 * Two bot accounts use the normal opt-in and Socket.IO paths. They choose the
 * start tiles, play both legs and verify the shared deal from the stored replays.
 */
const { execFileSync, spawn } = require('child_process');
const { once } = require('events');
const { createInterface } = require('readline');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const zlib = require('zlib');
const adapter = require('../../engine-adapter');
const officialVersion = adapter.version();

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const CONTAINER = process.env.HOCHCIV_CONTAINER || 'hochciv-multiplayer-local';
const DB_CONTAINER = process.env.HOCHCIV_DB_CONTAINER || 'hochciv-db';
const BOT = process.env.HOCHCIV_ARENA_TEST_BOT;
const BROWSER = process.env.HOCHCIV_BROWSER || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(p => fs.existsSync(p));

let failed = 0;
const ok = (cond, name, info) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
    if (!cond) failed++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000, step = 150) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = await fn().catch(() => null);
        if (v) return v;
        await sleep(step);
    }
    return null;
}
const inServer = code => execFileSync('docker', ['exec', '-i', '-w', '/app', CONTAINER, 'node', '-'], { input: code })
    .toString().trim().split('\n').filter(l => !/^\[Engine Adapter\]/.test(l)).join('\n');
const sql = q => execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'hochciv', '-d', 'hochciv', '-tAc', q]).toString().trim();

function rawGet(url, enc) {
    return new Promise((resolve, reject) => {
        http.get(url, { headers: enc ? { 'Accept-Encoding': enc } : {} }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}

const PASSWORD = 'Test-' + crypto.randomBytes(6).toString('hex');
const TAG = 'ar' + crypto.randomBytes(2).toString('hex');
function makeUsers(roles) {
    const specs = roles.map(role => ({
        role,
        name: `${TAG}_${role.slice(0, 4)}_${crypto.randomBytes(2).toString('hex')}`,
    }));
    const out = inServer(`const { User } = require('./models'); const bcrypt = require('bcryptjs');
        const hash = bcrypt.hashSync('${PASSWORD}', 10);
        const specs = ${JSON.stringify(specs)};
        Promise.all(specs.map(s => User.create({
            username: s.name, email: s.name + '@example.com', password_hash: hash,
            isActive: true, emailOtpEnabled: false, notifyEmail: false, role: s.role,
        }))).then(us => { console.log(JSON.stringify(us.map(u => ({ name: u.username, id: u.id })))); process.exit(0); });`);
    return JSON.parse(out);
}


function unit() {
    const prevTtl = process.env.ARENA_TTL_MS;
    try {
        process.env.ARENA_TTL_MS = '1000';
        const arena = require('../../async/arena');
        const L = require('../../async/logic');

        ok(arena.ARENA_ENGINE === officialVersion, 'unit: official arena uses the deployed engine', arena.ARENA_ENGINE);
        arena._resetForTests();
        ok(arena.optIn('b1', 1000) === false && arena.poolSize(1000) === 0, 'unit: opt-in requires tile placement');
        ok(arena.optIn('b1', 1000, officialVersion, true) === true && arena.isOptedIn('b1', 1500) === true && arena.poolSize(1500) === 1,
            'unit: optIn and poolSize work within TTL');
        ok(arena.isOptedIn('b1', 2001) === false && arena.poolSize(2001) === 0,
            'unit: optIn expires cleanly after ARENA_TTL_MS');
        arena.optIn('b2', 3000, officialVersion, true);
        ok(arena.optOut('b2') === true && arena.isOptedIn('b2', 3000) === false && arena.poolSize(3000) === 0,
            'unit: optOut removes bot immediately');
        arena._resetForTests();

        const b1 = { id: 'b1', username: 'Bot1', isBot: true };
        const b2 = { id: 'b2', username: 'Bot2', isBot: true };
        const h1 = { id: 'h1', username: 'Human1', isBot: false };

        ok(!!L.createArenaPair(b1, h1, officialVersion, 831).error
            && !!L.createArenaPair(b1, b1, officialVersion, 831).error,
        'unit: a pair requires two distinct bot accounts');
        const { first, second } = L.createArenaPair(b1, b2, officialVersion, 831);
        ok(first.status === 'placement' && second.status === 'arena-waiting' && !second.pre && !second.state,
            'unit: only the opener can receive setup actions');
        first.config.arenaPair = { leg: 1 };
        L.timeout(first);
        L.finishArenaPairOpener(first, second);
        ok(first.status === 'cancelled' && second.status === 'cancelled' && !second.state,
            'unit: expiration cancels the fixture without inviting a KI');
    } finally {
        if (prevTtl === undefined) delete process.env.ARENA_TTL_MS;
        else process.env.ARENA_TTL_MS = prevTtl;
    }
}

function nativePlacement(view) {
    const input = JSON.stringify({ type: 'placement', view: view.placement.plan, seat: view.mySlot });
    return JSON.parse(execFileSync(BOT, ['setup'], { input, encoding: 'utf8', timeout: 10000 })).placements;
}

async function playNative(id, pages, emit) {
    const workers = [];
    try {
        const initial = (await emit(pages[0], 'async:open', { id })).view.state;
        for (const [seat, page] of pages.entries()) {
            const proc = spawn(BOT, ['rush-ahead'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
            const done = once(proc, 'close');
            const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
            const send = m => proc.stdin.write(JSON.stringify(m) + '\n');
            const receive = async () => JSON.parse((await lines.next()).value);
            const v = (await emit(page, 'async:open', { id })).view;
            workers.push({ proc, done, send, receive, index: v.myIndex, page });
            send({ type: 'hello', protocol: 1, engine: { version: v.engine } });
            assert.equal((await receive()).type, 'hello');
            send({ type: 'start', game: id, seat: v.myIndex, players: 2, settings: { seed: seat + 1, turnTime: 0 } });
        }
        let state = initial;
        for (let n = 0; n < 2000; n++) {
            const bot = workers.find(w => w.index === state.cur);
            assert(bot, 'only bot accounts play this game');
            bot.send({ type: 'act', game: id, state, timeout_ms: 10000 });
            const choice = await bot.receive();
            assert.equal(choice.type, 'action', JSON.stringify(choice));
            const result = await emit(bot.page, 'async:action', { id, ...choice.action });
            assert(result?.ok, JSON.stringify(result));
            const next = (await emit(bot.page, 'async:open', { id })).view;
            if (next.status === 'finished') return next;
            state = next.state;
        }
        throw new Error('fixture did not finish in 2000 actions');
    } finally {
        for (const w of workers) {
            if (w.proc.exitCode === null) w.send({ type: 'quit' });
            w.proc.stdin.end();
        }
        await Promise.all(workers.map(w => w.done));
    }
}

(async () => {
    assert(BOT && fs.existsSync(BOT), 'set HOCHCIV_ARENA_TEST_BOT to a native Hans executable');
    try { unit(); } catch (err) { ok(false, 'unit', err.stack); }

    const [creator, admin, human] = makeUsers(['botcreator', 'admin', 'user']);
    const bots = [];
    const { chromium } = require('playwright-core');
    const browser = await chromium.launch({ executablePath: BROWSER, args: ['--disable-gpu', '--disable-dev-shm-usage'] });
    const errors = [];

    try {
        const call = async (ctx, method, path, data) => {
            const r = await ctx.request.fetch(BASE + path, { method, data });
            let body = {};
            try { body = await r.json(); } catch (_) { }
            return { status: r.status(), body };
        };
        const loginUser = async u => {
            const ctx = await browser.newContext({ locale: 'de-DE' });
            const r = await ctx.request.post(BASE + '/api/auth/login', { data: { username: u.name, password: PASSWORD } });
            if (r.status() !== 200) throw new Error('login failed for ' + u.name);
            return ctx;
        };
        const loginBot = async token => {
            const ctx = await browser.newContext({ locale: 'de-DE' });
            const r = await ctx.request.post(BASE + '/api/auth/bot', { data: { token } });
            if (r.status() !== 200) throw new Error('bot login failed');
            return ctx;
        };
        const socketPage = async ctx => {
            const page = await ctx.newPage();
            page.on('pageerror', e => errors.push(e.message));
            await page.goto(BASE + '/');
            await page.waitForFunction(() => typeof MP !== 'undefined');
            await page.evaluate(() => MP.connect());
            await page.waitForFunction(() => MP.socket && MP.socket.connected, null, { timeout: 10000 });
            return page;
        };
        const emit = (page, ev, data) => page.evaluate(([ev, data]) => new Promise(r => MP.socket.emit(ev, data, r)), [ev, data || {}]);

        const C = await loginUser(creator);
        const A = await loginUser(admin);
        const H = await loginUser(human);

        for (let i = 1; i <= 3; i++) {
            const r = await call(C, 'POST', '/api/bots', { username: `${TAG}_b${i}` });
            if (r.status !== 200) throw new Error('bot create failed: ' + JSON.stringify(r.body));
            bots.push({ ...r.body.bot, token: r.body.token });
        }
        let b1Ctx = await loginBot(bots[0].token);
        let b2Ctx = await loginBot(bots[1].token);
        let b3Ctx = await loginBot(bots[2].token);
        const b1Page = await socketPage(b1Ctx);
        const b2Page = await socketPage(b2Ctx);
        const b3Page = await socketPage(b3Ctx);

        // ── Guards and opt-in endpoints ─────────────────────────────────────────
        const hArena = await call(H, 'POST', '/api/async/arena', { on: true });
        const hList = await call(H, 'GET', '/api/async');
        ok(hArena.status === 400 && hArena.body.error === 'Die Bot-Arena ist nur für Spieler-Bots.' && hList.body.arena === undefined,
            'human refused on POST /api/async/arena and sees no arena field on GET /api/async', JSON.stringify(hArena.body));

        const spoof = await call(C, 'POST', '/api/async', {
            arena: true, engine: 'v98', config: { mapKey: '0', civMode: 'random', playerCount: 2, kiCount: 1 },
        });
        ok(spoof.status === 400 && /mindestens zwei Menschen/.test(spoof.body.error || ''),
            'POST /api/async cannot spoof internal arena flag', JSON.stringify(spoof.body));


        const currentHeartbeat = '/api/async?arena=1&arenaPlacement=1';
        const optIn = (ctx, version) => call(ctx, 'POST', '/api/async/arena', { placement: true, version });
        const optOut = ctx => call(ctx, 'GET', '/api/async?arena=0');
        const list = async ctx => (await call(ctx, 'GET', '/api/async')).body;
        const tileOpen = (page, id) => emit(page, 'async:open', { id });

        const unsupported = await call(b1Ctx, 'POST', '/api/async/arena', { on: true });
        const unsupportedGET = await call(b1Ctx, 'GET', '/api/async?arena=1');
        ok(unsupported.status === 400 && unsupportedGET.status === 400
            && (await list(b1Ctx)).arena === false, 'plain bot cannot join the placement pool');
        const tOn = await optIn(b1Ctx);
        ok(tOn.status === 200 && tOn.body.arena && tOn.body.arenaVersion === officialVersion
            && tOn.body.arenaOfficialVersion === officialVersion && tOn.body.arenaPlacementRequired
            && tOn.body.arenaVersions.includes('v106'), 'capable bot opts in on the deployed edition');
        ok((await call(b1Ctx, 'POST', '/api/async/arena', { on: false })).body.arena === false
            && (await call(b1Ctx, 'GET', currentHeartbeat)).body.arena === true
            && (await optOut(b1Ctx)).body.arena === false, 'both endpoints control the pool');
        ok((await optIn(b1Ctx, 'v99999')).status === 400
            && (await call(b1Ctx, 'GET', currentHeartbeat + '&arenaVersion=v99999')).status === 400,
        'unknown editions are refused on both endpoints');

        await call(b1Ctx, 'GET', currentHeartbeat);
        await call(b2Ctx, 'GET', currentHeartbeat);
        const opener = await until(async () => (await list(b1Ctx)).mine.find(g => g.config.arena && g.status === 'placement'));
        assert(opener, 'opener appeared in the bot inventory');
        const { id: pairId, otherGameId: returnId } = opener.config.arenaPair;
        ok(opener.engine === officialVersion && opener.config.mapKey === 'plaettchen'
            && opener.config.playerCount === 2 && !opener.config.ranked
            && opener.config.isPublic && !opener.config.wonders && !opener.config.events
            && !opener.freeSeats.length && opener.seats.every(seat => seat.botAccount),
        'opener is a public unranked tiled duel with two bot seats', opener.id);

        const before = await call(H, 'GET', '/api/async/' + opener.id);
        const pending = await tileOpen(b1Page, returnId);
        ok(!before.body.arenaPair.complete && before.body.arenaPair.otherStatus === 'arena-waiting'
            && !pending.view && !!pending.error, 'return has no playable view while opening game is active');
        await sleep(650);
        const active = await Promise.all([b1Ctx, b2Ctx].map(list));
        ok(active.every(x => x.mine.filter(g => g.config.arena).length === 1)
            && sql("SELECT count(*) FROM async_games WHERE data->'config'->'arenaPair'->>'id' = '" + pairId + "'") === '2',
        'exactly two durable rows, with one active per bot across scheduler ticks');
        await Promise.all([b1Ctx, b2Ctx].map(optOut));

        for (const page of [b1Page, b2Page]) {
            const v = (await tileOpen(page, opener.id)).view;
            assert.equal(v.status, 'placement');
            assert(v.placement.plan.seats.filter(seat => seat.idx !== v.mySlot).every(seat => seat.cell === null));
            let accepted;
            for (const placed of nativePlacement(v)) {
                const reply = await emit(page, 'async:place', { id: opener.id, o: placed.o, cell: placed.cell });
                if (reply?.ok) { accepted = placed; break; }
                assert.match(reply.error, /kein Platz|Ungültige Lage/);
            }
            assert(accepted, 'the server accepted a native placement choice');
            ok(true, 'native placement was accepted', JSON.stringify({ slot: v.mySlot, o: accepted.o, cell: accepted.cell }));
        }

        const hGames = await list(H);
        ok(hGames.watch.some(g => g.id === opener.id) && !hGames.open.some(g => g.id === opener.id),
            'the public watch list contains the running opener');
        const en = await browser.newContext({ locale: 'en-US' });
        await en.addInitScript(() => localStorage.setItem('hochciv.lang', 'en'));
        await en.request.post(BASE + '/api/auth/login', { data: { username: human.name, password: PASSWORD } });
        const spectator = await socketPage(en);
        await spectator.click('#mp-live-btn');
        await spectator.click('.mph-tab[data-tab="running"]');
        await spectator.waitForFunction(() => document.querySelector('#ov-body')?.textContent.includes('Bot Arena 1/2'));
        ok(true, 'the public English watch list displays the leg number');
        const specOpen = await tileOpen(spectator, opener.id);
        ok(specOpen.ok && specOpen.view.mySlot == null && specOpen.view.state.seed === undefined
            && (await emit(spectator, 'async:action', { id: opener.id, type: 'endTurn', params: {} })).error,
        'spectator sees the board without the play seed and cannot act');

        const opening = (await tileOpen(b1Page, opener.id)).view;
        assert.equal(opening.status, 'playing');
        const first = await playNative(opener.id, [b1Page, b2Page], emit);
        const returning = (await tileOpen(b1Page, returnId)).view;
        assert.equal(returning.status, 'playing');
        const start = S => ({
            map: S.map, first: S.players[S.cur].slot,
            players: S.players.map(p => ({ slot: p.slot, civ: p.civ, ability: p.ability, avail: p.avail, res: p.res })),
            capitals: S.cities,
        });
        assert.deepEqual(start(returning.state), start(opening.state));
        assert.deepEqual(returning.seats.map(s => s.name), opening.seats.map(s => s.name).reverse());
        ok(true, 'return has the same board, resources, opening offers and first seat, with bot accounts swapped');
        const interim = (await call(H, 'GET', '/api/async/' + opener.id)).body;
        ok(!interim.arenaPair.complete && interim.arenaPair.otherStatus === 'playing',
            'one recorded game does not complete the pair');
        const second = await playNative(returnId, [b1Page, b2Page], emit);

        const results = await Promise.all([first, second].map(async (view, index) => {
            assert(view.record?.id && view.record.replay);
            const game = (await call(H, 'GET', '/api/games/' + view.record.id)).body;
            assert.equal(game.version, officialVersion);
            assert.equal(game.stats.arenaPair.id, pairId);
            assert.equal(game.stats.arenaPair.leg, index + 1);
            assert(game.players.every(p => bots.slice(0, 2).some(b => b.id === p.userId) && p.mmrShift == null));
            const r = await rawGet(BASE + '/api/games/' + view.record.id + '/replay', 'br');
            assert.equal(r.status, 200);
            assert.equal(r.headers['content-encoding'], 'br');
            const replay = JSON.parse(zlib.brotliDecompressSync(r.body).toString('utf8'));
            assert.equal(replay.version, officialVersion);
            assert(replay.frames.length > 2 && replay.frames.at(-1).over);
            return replay;
        }));
        assert.deepEqual(start(results[0].frames[0]), start(results[1].frames[0]));
        assert.notEqual(results[0].frames[0].seed, results[1].frames[0].seed,
            'the legs have separate private play randomness');
        const complete = await Promise.all([opener.id, returnId].map(async id => (await call(H, 'GET', '/api/async/' + id)).body.arenaPair));
        ok(complete.every(p => p.complete && p.id === pairId && p.otherStatus === 'finished'),
            'both stored and replayable legs count as one completed pair');
        const mmrCheck = sql("SELECT string_agg(mmr::text || ':' || \"gamesPlayed\"::text, ',') FROM users WHERE id IN ('"
            + bots[0].id + "','" + bots[1].id + "')");
        ok(mmrCheck === '1000:2,1000:2', 'both bots retain their MMR after two recorded games', mmrCheck);
        const facts = await until(async () => {
            const rows = (await call(A, 'GET', '/api/admin/stats/export')).body;
            return Array.isArray(rows) && [first, second].every(view => rows.some(row => row.id === view.record.id && row.facts?.src === 'replay'));
        });
        ok(facts && (await call(H, 'GET', '/api/stats?seats=bots')).body.games >= 2,
            'the server stores both legs in ordinary bot statistics');

        await optIn(b2Ctx);
        await call(A, 'POST', '/api/admin/users/' + bots[1].id + '/action', { action: 'ban' });
        await call(A, 'POST', '/api/admin/users/' + bots[1].id + '/action', { action: 'unban' });
        b2Ctx = await loginBot(bots[1].token);
        ok((await list(b2Ctx)).arena === false, 'banning a bot evicts it from the pool');

        await optIn(b1Ctx);
        await optIn(b3Ctx, 'v106');
        const historical = await call(b3Ctx, 'GET', currentHeartbeat + '&arenaVersion=v106');
        await sleep(650);
        const editions = await Promise.all([b1Ctx, b3Ctx].map(list));
        ok(historical.body.arenaVersion === 'v106' && editions[0].arenaVersion === officialVersion
            && editions.every(x => x.arena && !x.mine.some(g => g.config.arena)),
        'bots on different editions wait independently for a capable opponent');
        await optOut(b3Ctx);
        await sleep(3200);
        ok((await list(b1Ctx)).arena === false, 'opt-in expires without a heartbeat');


        ok(errors.length === 0, 'no page errors', errors.join(' | '));
    } catch (err) {
        ok(false, 'test run', err.stack);
    } finally {
        await browser.close();
        const ids = [creator && creator.id, admin && admin.id, human && human.id, ...bots.map(b => b.id)].filter(Boolean);
        if (ids.length) {
            const arr = ids.map(id => `'${id}'`).join(',');
            sql(`DELETE FROM replay_frames WHERE "gameKey" IN (SELECT id FROM async_games WHERE "participantIds" && ARRAY[${arr}]::uuid[])`);
            sql(`DELETE FROM replays WHERE "gameId" IN (SELECT id FROM games WHERE "winnerUsername" LIKE '${TAG}\\_%' OR EXISTS (SELECT 1 FROM jsonb_array_elements(participants::jsonb) p WHERE p->>'dbUserId' IN (${arr})))`);
            sql(`DELETE FROM games WHERE "winnerUsername" LIKE '${TAG}\\_%' OR EXISTS (SELECT 1 FROM jsonb_array_elements(participants::jsonb) p WHERE p->>'dbUserId' IN (${arr}))`);
            sql(`DELETE FROM async_games WHERE "participantIds" && ARRAY[${arr}]::uuid[]`);
            sql(`DELETE FROM users WHERE id IN (${arr})`);
        }
    }
    console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
    process.exit(failed ? 1 : 0);
})();
