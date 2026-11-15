/**
 * Bot Arena MVP (async/arena.js, async/logic.js, async/service.js, routes/async.js,
 * utils/detachUser.js) against the local docker setup:
 *
 *   ARENA_INTERVAL_MS=300 ARENA_TTL_MS=2500 ARENA_KI_WAIT_MS=900 docker compose -f docker-compose.local.yml up -d --build
 *   npm i --no-save playwright-core
 *   node tests/arena/arena.test.js [http://localhost:3000]
 *
 * Checks unit rules, human/spoofing guards, opt-in/out endpoints, automatic 2-bot duel pairing,
 * max-1 active arena concurrency cap, public spectator view + English UI without German leftover,
 * >= 2 played Socket.IO rounds, unranked Game/Replay(Brotli)/Facts/stats(seats=bots) recording
 * without changing MMR, ban eviction via detachUser, solo schwer KI fallback after wait timeout
 * with natural game completion, and opt-in TTL expiration. All test data is deleted afterwards.
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const zlib = require('zlib');

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const CONTAINER = process.env.HOCHCIV_CONTAINER || 'hochciv-multiplayer-local';
const DB_CONTAINER = process.env.HOCHCIV_DB_CONTAINER || 'hochciv-db';
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

const GERMAN = /[äöüÄÖÜß]|\b(und|oder|der|die|das|ein|eine|nicht|mit|für|Spiel|Spiele|Spieler|Runde|Anmelden|Abmelden|Konto|Beitreten|Zurück|Weiter|Warte|warte|Karte|Bitte|Du|Dein|deine|ist|wird|kein|keine|noch|Gast|Lade|Fehler|Passwort|Speichern|Löschen|Abbrechen|Einladen|Erstellen|Öffnen|Laufende|Rundenspiel|Rundenspiele|Mitspieler|Reiche|Menschen|Zufall|Eigene|Benutzername|Aktualisieren|Wartungsmodus|Spielhistorie|Profil|Nationen|gewertet|Gewertet)\b/;

function unit() {
    const prevTtl = process.env.ARENA_TTL_MS;
    try {
        process.env.ARENA_TTL_MS = '1000';
        const arena = require('../../async/arena');
        const L = require('../../async/logic');

        ok(arena.ARENA_ENGINE === 'v106', 'unit: ARENA_ENGINE is pinned to v106', arena.ARENA_ENGINE);
        const cfg = arena.ARENA_CONFIG;
        ok(cfg.mapKey === '0' && cfg.civMode === 'random' && cfg.playerCount === 2 && cfg.difficulty === 'schwer'
            && cfg.events === false && cfg.wonders === false && cfg.hexTiles === false && cfg.ranked === false
            && cfg.isPublic === true && cfg.turnDays === 1 && cfg.playerBots === true,
        'unit: ARENA_CONFIG matches fixed MVP rules', JSON.stringify(cfg));

        arena._resetForTests();
        ok(arena.optIn('b1', 1000) === true && arena.isOptedIn('b1', 1500) === true && arena.poolSize(1500) === 1,
            'unit: optIn and poolSize work within TTL');
        ok(arena.isOptedIn('b1', 2001) === false && arena.poolSize(2001) === 0,
            'unit: optIn expires cleanly after ARENA_TTL_MS');
        arena.optIn('b2', 3000);
        ok(arena.optOut('b2') === true && arena.isOptedIn('b2', 3000) === false && arena.poolSize(3000) === 0,
            'unit: optOut removes bot immediately');
        arena._resetForTests();

        const b1 = { id: 'b1', username: 'Bot1', isBot: true };
        const b2 = { id: 'b2', username: 'Bot2', isBot: true };
        const h1 = { id: 'h1', username: 'Human1', isBot: false };

        const duel = L.create(b1, { arena: true, engine: arena.ARENA_ENGINE, config: { ...cfg, kiCount: 0 } });
        ok(!duel.error && duel.g.status === 'setup' && duel.g.engine === 'v106' && duel.g.config.arena === true,
            'unit: 2-bot arena duel starts in setup on v106');
        ok(L.leave(duel.g, 'b1') === 'Spiele der Bot-Arena kann man nur aufgeben.'
            && L.cancel(duel.g, 'b1') === 'Spiele der Bot-Arena kann man nur aufgeben.',
        'unit: leave and cancel are refused on arena games');
        ok(L.join(duel.g, h1, {}) === 'Die Bot-Arena ist nur für Spieler-Bots.',
            'unit: human users cannot join an arena game');
        ok(L.join(duel.g, b2, {}) === null && duel.g.status === 'playing',
            'unit: second bot joins duel and starts the game');

        const duel2 = L.create(b1, { arena: true, engine: arena.ARENA_ENGINE, config: { ...cfg, kiCount: 0 } });
        L.join(duel2.g, b2, {});
        duel2.g.seats[1].started = false;
        ok(L.removeUser(duel2.g, 'b2') === null && duel2.g.seats[1].replaced === true
            && duel2.g.state.players[L.stateIndex(duel2.g, 1)].kind === 'ki',
        'unit: removeUser replaces arena bot seat instead of calling leave');

        const solo = L.create(b1, { arena: true, engine: arena.ARENA_ENGINE, config: { ...cfg, kiCount: 1 } });
        ok(!solo.error && solo.g.status === 'playing' && solo.g.seats[0].kind === 'human'
            && solo.g.seats[1].kind === 'ki' && solo.g.seats[1].kiLevel === 'schwer',
        'unit: solo vs schwer KI starts immediately in playing status');

        const starts = new Set();
        for (let i = 0; i < 30; i++) {
            const r = L.create(b1, { arena: true, engine: arena.ARENA_ENGINE, config: { ...cfg, kiCount: 1 } });
            if (r.g) starts.add(r.g.config.startPlayer);
        }
        ok(starts.has(0) && starts.has(1), 'unit: solo vs KI randomizes startPlayer between 0 and 1', JSON.stringify([...starts]));
    } finally {
        if (prevTtl === undefined) delete process.env.ARENA_TTL_MS;
        else process.env.ARENA_TTL_MS = prevTtl;
    }
}

function playTurnPayload(E, S, pi) {
    const actions = [];
    const sim = JSON.parse(JSON.stringify(S));
    if (typeof E.blockingIssues === 'function' && E.blockingIssues(sim, pi).length
        && typeof E.armyReach === 'function' && typeof E.cityAt === 'function') {
        for (const a of sim.armies.filter(x => x.owner === pi && E.cityAt(sim, x.r, x.c))) {
            const fields = [...E.armyReach(sim, a).keys()].map(k => k.split(',').map(Number))
                .filter(([r, c]) => !(r === a.r && c === a.c) && !E.cityAt(sim, r, c)
                    && (typeof E.canStop !== 'function' || E.canStop(sim, pi, r, c)))
                .sort((u, v) => Number(sim.armies.some(o => o.r === u[0] && o.c === u[1]))
                    - Number(sim.armies.some(o => o.r === v[0] && o.c === v[1])));
            for (const [r, c] of fields) {
                if (!E.moveArmy(sim, a, r, c)) {
                    actions.push({ type: 'moveArmy', params: { armyId: a.id, r, c } });
                    break;
                }
            }
        }
    }
    if (!E.buyPower(sim, pi, 1)) {
        actions.push({ type: 'buyPower', params: { n: 1 } });
    }
    actions.push({ type: 'endTurn', params: {} });
    return actions;
}

(async () => {
    try { unit(); } catch (err) { ok(false, 'unit', err.stack); }

    const [creator, admin, human] = makeUsers(['botcreator', 'admin', 'user']);
    const bots = [];
    const { chromium } = require('playwright-core');
    const browser = await chromium.launch({ executablePath: BROWSER, args: ['--disable-gpu', '--disable-dev-shm-usage'] });
    const errors = [];
    let hbTimer = null;

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
        const ENG = require('../../engine-adapter').forVersion('v106').getEngine();

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

        ok((await call(b1Ctx, 'GET', '/api/async')).body.arena === false, 'bot initially not opted into arena');
        const tOn = await call(b1Ctx, 'POST', '/api/async/arena', { on: true });
        ok(tOn.status === 200 && tOn.body.ok === true && tOn.body.arena === true
            && (await call(b1Ctx, 'GET', '/api/async')).body.arena === true,
        'POST /api/async/arena { on: true } opts bot in');
        const tOff = await call(b1Ctx, 'POST', '/api/async/arena', { on: false });
        ok(tOff.status === 200 && tOff.body.ok === true && tOff.body.arena === false
            && (await call(b1Ctx, 'GET', '/api/async')).body.arena === false,
        'POST /api/async/arena { on: false } opts bot out');
        ok((await call(b1Ctx, 'GET', '/api/async?arena=1')).body.arena === true
            && (await call(b1Ctx, 'GET', '/api/async?arena=0')).body.arena === false,
        'GET /api/async?arena=1 / ?arena=0 toggles opt-in');

        // ── 2-bot duel, max-1 concurrency cap, spectator, English UI, data + replay ──
        hbTimer = setInterval(() => {
            call(b1Ctx, 'GET', '/api/async?arena=1').catch(() => { });
            call(b2Ctx, 'GET', '/api/async?arena=1').catch(() => { });
        }, 350);
        await call(b1Ctx, 'GET', '/api/async?arena=1');
        await call(b2Ctx, 'GET', '/api/async?arena=1');

        const duelGame = await until(async () => {
            const m1 = (await call(b1Ctx, 'GET', '/api/async')).body.mine || [];
            const m2 = (await call(b2Ctx, 'GET', '/api/async')).body.mine || [];
            return m1.find(g => g.config && g.config.arena && g.status === 'playing' && m2.some(x => x.id === g.id)) || null;
        }, 8000, 150);

        ok(!!duelGame && duelGame.engine === 'v106' && duelGame.config.mapKey === '0'
            && duelGame.config.civMode === 'random' && duelGame.config.ranked === false
            && duelGame.config.isPublic === true && duelGame.config.events === false
            && duelGame.config.wonders === false && duelGame.config.hexTiles === false
            && duelGame.config.turnDays === 1 && duelGame.freeSeats.length === 0,
        'two opted-in bots automatically paired into public unranked v106 duel', duelGame && duelGame.id);

        // Keep heartbeating over ~3 ticks while active: concurrency cap keeps count at 1
        await sleep(1000);
        const active1 = ((await call(b1Ctx, 'GET', '/api/async')).body.mine || []).filter(g => g.config && g.config.arena && g.status === 'playing');
        const active2 = ((await call(b2Ctx, 'GET', '/api/async')).body.mine || []).filter(g => g.config && g.config.arena && g.status === 'playing');
        clearInterval(hbTimer);
        hbTimer = null;
        await call(b1Ctx, 'GET', '/api/async?arena=0');
        await call(b2Ctx, 'GET', '/api/async?arena=0');
        ok(active1.length === 1 && active2.length === 1, 'max-1 active arena concurrency cap holds across ticks', `${active1.length}/${active2.length}`);

        const duelId = duelGame.id;

        // Public spectator list + English UI + spectator socket guard
        const hGames = (await call(H, 'GET', '/api/async')).body;
        ok(hGames.watch.some(g => g.id === duelId) && !hGames.open.some(g => g.id === duelId),
            'human sees running arena match in watch list, not open join list');

        const enCtx = await browser.newContext({ locale: 'en-US' });
        await enCtx.request.post(BASE + '/api/auth/login', { data: { username: human.name, password: PASSWORD } });
        const enPage = await enCtx.newPage();
        enPage.on('pageerror', e => errors.push('en: ' + e.message));
        await enPage.addInitScript(() => localStorage.setItem('hochciv.lang', 'en'));
        await enPage.goto(BASE + '/');
        await enPage.waitForFunction(() => typeof MP !== 'undefined' && typeof ASYNC !== 'undefined');
        await enPage.evaluate(() => MP.connect());
        await enPage.waitForFunction(() => MP.socket && MP.socket.connected, null, { timeout: 10000 });
        await enPage.click('#mp-live-btn');
        await enPage.waitForSelector('#ov-body', { state: 'visible', timeout: 10000 });
        await enPage.click('.mph-tab[data-tab="running"]');
        await enPage.waitForFunction(() => /Bot Arena/.test((document.getElementById('ov-body') || {}).textContent || ''), null, { timeout: 10000 });
        const uiCheck = await enPage.evaluate(([src, tagRe]) => {
            const root = document.getElementById('ov-body');
            const text = root ? root.textContent : '';
            const re = new RegExp(src), ignore = new RegExp(tagRe, 'g'), bad = [];
            const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let n; (n = walk.nextNode());) {
                const s = n.nodeValue.trim().replace(ignore, '');
                if (s && !n.parentElement.closest('script,style,[data-i18n-ignore]') && n.parentElement.getBoundingClientRect().width && re.test(s)) {
                    bad.push(s);
                }
            }
            return { hasLabel: /🤖\s*Bot Arena/.test(text), bad };
        }, [GERMAN.source, `${TAG}_[a-z0-9_]+`]);
        ok(uiCheck.hasLabel && uiCheck.bad.length === 0,
            'English UI shows "🤖 Bot Arena" with zero German words left', JSON.stringify(uiCheck));

        const specOpen = await emit(enPage, 'async:open', { id: duelId });
        const specAct = await emit(enPage, 'async:action', { id: duelId, type: 'endTurn', params: {} });
        ok(specOpen.ok === true && specOpen.view && specOpen.view.mySlot == null && !!specAct.error,
            'spectator opens arena game read-only and cannot act', specAct && specAct.error);
        await enCtx.close();

        // Play >= 2 rounds over Socket.IO, check leave/cancel refusal, then resign
        for (let step = 0; step < 12; step++) {
            const open1 = await emit(b1Page, 'async:open', { id: duelId });
            const v = open1.view;
            if (!v || !v.state || v.state.over) break;
            if (v.state.round >= 3) break;
            const curSlot = v.state.players[v.state.cur].slot;
            const curPage = curSlot === v.mySlot ? b1Page : b2Page;
            const openCur = curSlot === v.mySlot ? open1 : await emit(b2Page, 'async:open', { id: duelId });
            const actions = playTurnPayload(ENG, openCur.view.state, openCur.view.state.cur);
            for (const act of actions) {
                const res = await emit(curPage, 'async:action', { id: duelId, ...act });
                if (!res || !res.ok) throw new Error(`duel action ${act.type} failed: ${JSON.stringify(res)}`);
                if (res.view && (res.view.status === 'finished' || (res.view.state && res.view.state.over))) break;
            }
        }

        const afterPlay = (await emit(b1Page, 'async:open', { id: duelId })).view;
        ok(afterPlay && afterPlay.state && afterPlay.state.round >= 3, 'played >= 2 full rounds over Socket.IO', `round ${afterPlay && afterPlay.state && afterPlay.state.round}`);

        const hostCtx = duelGame.isHost ? b1Ctx : b2Ctx;
        const guestCtx = duelGame.isHost ? b2Ctx : b1Ctx;
        const rLeave = await call(guestCtx, 'POST', `/api/async/${duelId}/leave`, {});
        const rCancel = await call(hostCtx, 'POST', `/api/async/${duelId}/cancel`, {});
        ok(rLeave.status === 400 && rLeave.body.error === 'Spiele der Bot-Arena kann man nur aufgeben.'
            && rCancel.status === 400 && rCancel.body.error === 'Spiele der Bot-Arena kann man nur aufgeben.',
        'HTTP leave and cancel refused on arena match', JSON.stringify({ leave: rLeave.body, cancel: rCancel.body }));

        const resignRes = await emit(b2Page, 'async:resign', { id: duelId });
        const finishedDuel = await until(async () => {
            const v = (await emit(b1Page, 'async:open', { id: duelId })).view;
            return v && v.status === 'finished' && v.record && v.record.id ? v : null;
        }, 8000, 150);
        ok(!!finishedDuel, 'resign finishes 2-bot duel cleanly', JSON.stringify(resignRes && resignRes.ok));

        const duelGameId = finishedDuel.record.id;
        const gDoc = (await call(H, 'GET', `/api/games/${duelGameId}`)).body;
        ok(gDoc.version === 'v106' && gDoc.rounds >= 3 && gDoc.replay === true
            && gDoc.stats && Array.isArray(gDoc.stats.rounds) && gDoc.stats.rounds.length >= 3
            && gDoc.players.every(p => p.mmrShift == null),
        'finished duel records Game (v106, >=3 rounds, stats) without MMR shift', JSON.stringify({ v: gDoc.version, rounds: gDoc.rounds, statRounds: gDoc.stats && gDoc.stats.rounds && gDoc.stats.rounds.length }));

        const mmrCheck = sql(`SELECT string_agg(mmr::text || ':' || "gamesPlayed"::text, ',') FROM users WHERE id IN ('${bots[0].id}','${bots[1].id}')`);
        ok(mmrCheck === '1000:1,1000:1', 'both bots stay at 1000 MMR while gamesPlayed increments', mmrCheck);

        const rep = await rawGet(`${BASE}/api/games/${duelGameId}/replay`, 'gzip, deflate, br');
        const repJson = rep.status === 200 && rep.headers['content-encoding'] === 'br'
            ? JSON.parse(zlib.brotliDecompressSync(rep.body).toString('utf8'))
            : null;
        ok(!!repJson && repJson.version === 'v106' && repJson.frames.length >= 5 && !!repJson.frames[repJson.frames.length - 1].over,
            'Brotli replay stored and served with all duel turns', repJson && `${repJson.frames.length} frames, ${repJson.version}`);

        const duelFacts = await until(async () => {
            const rows = (await call(A, 'GET', '/api/admin/stats/export')).body;
            return Array.isArray(rows) ? rows.find(x => x.id === duelGameId && x.facts) || null : null;
        }, 10000, 150);
        const botStats = (await call(H, 'GET', '/api/stats?seats=bots')).body;
        const pStats = (await call(H, 'GET', `/api/stats/player/${bots[0].id}`)).body;
        ok(!!duelFacts && duelFacts.facts.src === 'replay' && duelFacts.facts.ver === 'v106'
            && botStats.games >= 1 && pStats.games >= 1,
        'Facts stored and reflected in GET /api/stats?seats=bots & player stats', JSON.stringify({ src: duelFacts && duelFacts.facts.src, botsGames: botStats.games, playerGames: pStats.games }));

        // ── Ban eviction via detachUser ─────────────────────────────────────────
        await call(b2Ctx, 'POST', '/api/async/arena', { on: true });
        await call(A, 'POST', `/api/admin/users/${bots[1].id}/action`, { action: 'ban' });
        await call(A, 'POST', `/api/admin/users/${bots[1].id}/action`, { action: 'unban' });
        b2Ctx = await loginBot(bots[1].token);
        ok((await call(b2Ctx, 'GET', '/api/async')).body.arena === false,
            'banning a bot immediately evicts it from the arena pool via detachUser');

        // ── Solo schwer KI fallback + natural completion ─────────────────────────
        hbTimer = setInterval(() => {
            call(b3Ctx, 'GET', '/api/async?arena=1').catch(() => { });
        }, 350);
        await call(b3Ctx, 'GET', '/api/async?arena=1');

        const soloGame = await until(async () => {
            const m = (await call(b3Ctx, 'GET', '/api/async')).body.mine || [];
            return m.find(g => g.config && g.config.arena && g.status === 'playing') || null;
        }, 6000, 150);
        clearInterval(hbTimer);
        hbTimer = null;
        await call(b3Ctx, 'GET', '/api/async?arena=0');

        const soloId = soloGame && soloGame.id;
        const soloOpen0 = soloId ? (await emit(b3Page, 'async:open', { id: soloId })).view : null;
        ok(!!soloGame && soloGame.config.difficulty === 'schwer'
            && soloGame.seats.some(s => s.userId === bots[2].id)
            && soloGame.seats.some(s => s.kind === 'ki')
            && !!soloOpen0 && !!soloOpen0.state
            && soloOpen0.state.players.some(p => p.kind === 'ki' && p.kiLevel === 'schwer'),
        'idle bot falls back to 1v1 vs schwer KI after ARENA_KI_WAIT_MS', soloId);

        let finishedSolo = null;
        for (let step = 0; step < 250; step++) {
            const open = await emit(b3Page, 'async:open', { id: soloId });
            const v = open.view;
            if (!v || (v.status === 'finished' && v.record && v.record.id)) {
                finishedSolo = v;
                break;
            }
            if (v.state && v.state.over) {
                await sleep(150);
                continue;
            }
            if (v.state.players[v.state.cur].slot !== v.mySlot) {
                await sleep(100);
                continue;
            }
            for (const act of playTurnPayload(ENG, v.state, v.state.cur)) {
                const res = await emit(b3Page, 'async:action', { id: soloId, ...act });
                if (!res || !res.ok) throw new Error(`solo action ${act.type} failed: ${JSON.stringify(res)}`);
                if (res.view && (res.view.status === 'finished' || (res.view.state && res.view.state.over))) break;
            }
        }
        if (!finishedSolo || !finishedSolo.record || !finishedSolo.record.id) {
            finishedSolo = await until(async () => {
                const v = (await emit(b3Page, 'async:open', { id: soloId })).view;
                return v && v.status === 'finished' && v.record && v.record.id ? v : null;
            }, 8000, 150);
        }
        ok(!!finishedSolo && finishedSolo.status === 'finished' && !!finishedSolo.record && !!finishedSolo.record.id,
            'solo arena vs schwer KI finishes naturally when bot ends turns', finishedSolo && `rounds=${finishedSolo.round}`);

        const soloGameId = finishedSolo.record.id;
        const soloDoc = (await call(H, 'GET', `/api/games/${soloGameId}`)).body;
        const soloFacts = await until(async () => {
            const rows = (await call(A, 'GET', '/api/admin/stats/export')).body;
            return Array.isArray(rows) ? rows.find(x => x.id === soloGameId && x.facts) || null : null;
        }, 10000, 150);
        const b3Mmr = sql(`SELECT mmr FROM users WHERE id = '${bots[2].id}'`);
        ok(soloDoc.version === 'v106' && soloDoc.replay === true && !!soloFacts && soloFacts.facts.src === 'replay'
            && soloDoc.players.every(p => p.mmrShift == null) && b3Mmr === '1000',
        'naturally finished KI match records v106 Game/Replay/Facts with 1000 MMR unchanged', JSON.stringify({ src: soloFacts && soloFacts.facts.src, mmr: b3Mmr }));

        // ── Heartbeat TTL expiration ────────────────────────────────────────────
        await call(b1Ctx, 'POST', '/api/async/arena', { on: true });
        ok((await call(b1Ctx, 'GET', '/api/async')).body.arena === true, 'bot1 opted in for TTL test');
        await sleep(2800);
        ok((await call(b1Ctx, 'GET', '/api/async')).body.arena === false, 'arena opt-in expires cleanly after ARENA_TTL_MS without heartbeat');

        ok(errors.length === 0, 'no page errors', errors.join(' | '));
    } catch (err) {
        ok(false, 'test run', err.stack);
    } finally {
        if (hbTimer) clearInterval(hbTimer);
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
