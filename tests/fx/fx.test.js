/**
 * Tests of the map effects (client/fx.js): the layer loads, founding, growing and conquering a
 * city, a battle and the events each start an effect over #map, the same picture drawn again
 * starts nothing new, „Animationen: Keine" switches everything off, no page errors. Screenshots
 * of the effects land in tests/fx/shots (not checked in), to look at after changes.
 *
 *   docker compose -f docker-compose.local.yml up -d
 *   npm i --no-save playwright-core
 *   node tests/fx/fx.test.js [http://localhost:3000]
 *
 * Uses an installed Chrome or Edge (no browser download); set HOCHCIV_BROWSER to its path if
 * it is not found.
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const URL = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '') + '/?app=1';
const SHOTS = path.join(__dirname, 'shots');
const BROWSER = process.env.HOCHCIV_BROWSER || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(p => fs.existsSync(p));
let failed = 0;
const ok = (cond, name, info) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`); if (!cond) failed++; };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: BROWSER });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'de-DE' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'warning' && m.text().startsWith('[FX]')) errors.push(m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('hochciv.save'));
  await page.goto(URL, { waitUntil: 'networkidle' });
  ok(await page.evaluate(() => !!window.HCFX), 'effects loaded');

  await page.click('#m-new');
  await page.evaluate(() => { const st = document.getElementById('setup-start'); st.value = '0'; st.onchange(); });
  await page.evaluate(() => document.getElementById('setup-go').click());
  await page.waitForTimeout(1500);
  await page.evaluate(() => { HCFX.clear(); redraw(); });
  ok(await page.evaluate(() => !!document.querySelector('#map-host canvas.hcfx-layer')), 'canvas over the map');
  ok(await page.evaluate(() => HCFX.active === 0), 'the first picture starts nothing');

  const shot = async name => { await page.waitForTimeout(name.endsWith('-late') ? 900 : 450); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
  const settle = () => page.evaluate(() => { HCFX.clear(); redraw(); });

  // a free land field next to the first city of the human player
  const spot = await page.evaluate(() => {
    const own = S.cities.find(c => c.owner === 0) || S.cities[0];
    const taken = new Set(S.cities.map(c => c.r + ',' + c.c));
    for (let d = 2; d < 6; d++) for (let r = own.r - d; r <= own.r + d; r++) for (let c = own.c - d; c <= own.c + d; c++) {
      const t = (S.map.rows[r] || '')[c];
      if (t && 'GWH'.includes(t) && !taken.has(r + ',' + c)) return { r, c };
    }
    return null;
  });
  ok(!!spot, 'a free field for a new city', JSON.stringify(spot));

  // founding
  await page.evaluate(({ r, c }) => {
    const own = S.cities.find(x => x.owner === 0) || S.cities[0];
    S.cities.push(Object.assign(JSON.parse(JSON.stringify(own)), { id: 'fx-test', r, c, pop: 1, cap: false }));
    redraw();
  }, spot);
  ok(await page.evaluate(() => HCFX.active > 0), 'a new city starts an effect');
  await shot('found');
  await page.evaluate(() => redraw());
  await shot('found-late');
  ok(await page.evaluate(() => HCFX.active <= 1), 'drawing the same picture again starts nothing new', 'active ' + await page.evaluate(() => HCFX.active));
  await settle();

  // growing
  await page.evaluate(() => { S.cities.find(c => c.id === 'fx-test').pop += 2; redraw(); });
  ok(await page.evaluate(() => HCFX.active > 0), 'a growing city starts an effect');
  await shot('grow');
  await settle();

  // conquering
  await page.evaluate(() => { S.cities.find(c => c.id === 'fx-test').owner = 1; redraw(); });
  ok(await page.evaluate(() => HCFX.active > 0), 'a conquered city starts an effect');
  await shot('taken');
  await settle();

  // scenes of another empire's turn (animDraw): effects last as long as the scene, the next ends them
  const sceneRes = await page.evaluate(async () => {
    const svg = document.getElementById('map');
    const ct = S.cities.find(c => c.id === 'fx-test');
    const draw = (s, st) => drawMap(svg, S.map, { state: st, turn: -1, anim: s });
    const s1 = { tempo: 0.4, zuege: [], ringe: [], marken: [], felder: [] }, s2 = Object.assign({}, s1);
    const st1 = Object.assign({}, S, { cities: S.cities.map(c => c.id === ct.id ? Object.assign({}, c, { pop: c.pop + 1 }) : c) });
    draw(s1, st1);
    const a = HCFX.active;
    const st2 = Object.assign({}, st1, { cities: st1.cities.map(c => c.id === ct.id ? c : c) });
    draw(s2, st2);                                   // next scene, nothing new: the effect of scene 1 ends
    const b = HCFX.active;
    draw(s1, st1);                                   // (back to a picture of scene 1: no new effect, nothing changed)
    st1.cities.find(c => c.id === ct.id).pop += 1;
    draw(s1, st1);
    await new Promise(r => setTimeout(r, ANIM_MS * 0.4 + 150));
    const c = HCFX.active;
    redraw();
    return [a, b, c];
  });
  ok(sceneRes[0] > 0 && sceneRes[1] === 0, 'the next scene ends the effects of the scene before', sceneRes.join(' / '));
  ok(sceneRes[2] === 0, 'an effect in a short scene ends with the scene', sceneRes.join(' / '));
  await settle();

  // a battle, as combatDraw draws it (redrawn in between, as on resize)
  const fight = { ...spot, von: [[spot.r, spot.c - 1], [spot.r - 1, spot.c]] };
  await page.evaluate(f => {
    const opts = () => ({ state: S, turn: -1, fight: { pi: 0, gegner: 1, r: f.r, c: f.c, von: f.von, a: 7, d: 4, sieg: true, genommen: true, caption: 'Test' } });
    drawMap(document.getElementById('map'), S.map, opts());
    window.__fxCount = HCFX.active;
    drawMap(document.getElementById('map'), S.map, opts());
  }, fight);
  ok(await page.evaluate(() => window.__fxCount > 0 && HCFX.active === window.__fxCount), 'a battle starts one effect, also when redrawn');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, 'battle-shots.png') });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'battle-hit.png') });
  await settle();
  await page.evaluate(f => drawMap(document.getElementById('map'), S.map, { state: S, turn: -1, fight: { pi: 1, gegner: 0, r: f.r, c: f.c, von: f.von, a: 3, d: 6, sieg: false, caption: 'Test 2' } }), fight);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, 'battle-held.png') });
  await settle();

  // events
  for (const k of ['sturmflut', 'vulkan', 'waldbrand', 'pest', 'erdbeben', 'duerre', 'barbaren', 'revolution', 'dunkles_zeitalter', 'lawinen', 'hochwasser', 'wirtschaftskrise']) {
    const started = await page.evaluate(k => {
      const ct = S.cities.find(c => c.owner === 0);
      if (k === 'barbaren') S.barbs = [{ cityId: ct.id, owner: 0, power: 5 }];
      S.ev = true;
      S.event = { round: S.round, row: ct.r, col: ct.c, k };
      redraw();
      const n = HCFX.active;
      redraw();
      return [n, HCFX.active];
    }, k);
    ok(started[0] > 0 && started[1] === started[0], `event ${k}: an effect, once`, started.join(' → '));
    await shot('event-' + k);
    await page.evaluate(() => { S.event = null; S.barbs = []; });
    await settle();
  }

  // off with „Animationen: Keine"
  await page.evaluate(() => { prefs.anim = 'aus'; S.cities.find(c => c.id === 'fx-test').pop += 1; redraw(); });
  ok(await page.evaluate(() => HCFX.active === 0), 'nothing with Animationen: Keine');
  await page.evaluate(() => { prefs.anim = 'langsam'; S.cities = S.cities.filter(c => c.id !== 'fx-test'); redraw(); });

  ok(!errors.length, 'no page errors', errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
