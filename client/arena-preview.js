/* Bot Arena mockup. Rendering reads the example tournament records from arena-preview-data.js. */
(function () {
    'use strict';

    const { events: examples, bots, roundRobin } = window.HC_ARENA_PREVIEW_DATA;
    const recentLimit = 5;
    const T = (de, ...args) => HC_I18N.t(de, ...args);
    const fmtDate = date => new Date(date).toLocaleDateString(HC_I18N.locale(), { dateStyle: 'medium', timeZone: 'UTC' });
    const tabs = [['standings', 'Turnierstand'], ['fixtures', 'Begegnungen'], ['cross-table', 'Kreuztabelle']];
    const states = { finished: 'Beendet', live: 'Läuft', scheduled: 'Geplant' };
    const outcomes = { 1: ['1', 'Sieg'], 0.5: ['½', 'Unentschieden'], 0: ['0', 'Niederlage'] };
    const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

    function eventResults(event) {
        const bots = new Map(event.entrants.map(name => [name, {
            name, build: event.builds?.[name], points: 0, record: [0, 0, 0], opponents: new Map(),
        }]));
        for (const { a, b, score, state } of event.fixtures) {
            const first = bots.get(a), second = bots.get(b);
            first.opponents.set(b, { score, state });
            second.opponents.set(a, { score: score === null ? null : 1 - score, state });
            if (score === null) continue;
            first.points += score;
            second.points += 1 - score;
            first.record[2 - 2 * score]++;
            second.record[2 * score]++;
        }
        return [...bots.values()].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    }

    function table(headers, rows, className = '') {
        return `<div class="ba-scroll" tabindex="0" role="region" aria-label="${esc(T('Turnieransicht'))}">
            <table class="rk-table ${className}"><thead><tr>
                ${headers.map(name => `<th scope="col">${esc(name)}</th>`).join('')}
            </tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    function standingsHtml(bots) {
        let rank = 0;
        let previous = null;
        return table(['#', T('Name'), T('Spiele'), T('S–U–N'), T('Punkte')], bots.map((bot, i) => {
            if (bot.points !== previous) rank = i + 1;
            previous = bot.points;
            const played = bot.record.reduce((a, b) => a + b, 0);
            const build = bot.build ? `<small class="ba-build">${esc(bot.build)}</small>` : '';
            return `<tr><td>${rank}</td><th scope="row">${esc(bot.name)}${build}</th><td>${played}</td>
                <td>${bot.record.join('–')}</td><td><b>${esc(formatPoints(bot.points))}</b></td></tr>`;
        }).join(''));
    }

    function fixturesHtml(event) {
        return table([T('Begegnungen'), T('Runde'), T('Ergebnis')], event.fixtures.map(f => {
            const result = f.score === null ? T(states[f.state]) : `${formatPoints(f.score)}–${formatPoints(1 - f.score)}`;
            const replay = f.replay ? ` <a href="?replay=${encodeURIComponent(f.replay)}">${esc(T('Wiederholung'))}</a>` : '';
            return `<tr><td>${esc(f.a)} – ${esc(f.b)}</td><td>${f.round}</td><td>${esc(result)}${replay}</td></tr>`;
        }).join(''));
    }

    function formatPoints(points) {
        return points.toLocaleString(HC_I18N.locale());
    }

    function crossCell(bot, opponent) {
        if (bot.name === opponent.name) return `<td class="ba-self" aria-label="${esc(T('Gleicher Bot'))}">—</td>`;
        const fixture = bot.opponents.get(opponent.name);
        if (!fixture || fixture.state === 'scheduled') return `<td class="ba-pending" aria-label="${esc(T('Geplant'))}">…</td>`;
        if (fixture.state === 'live') return `<td class="ba-live" aria-label="${esc(T('Läuft'))}">Live</td>`;
        const [mark, label] = outcomes[fixture.score];
        return `<td aria-label="${esc(T(label))}">${mark}</td>`;
    }

    function crossTableHtml(bots) {
        const legend = T('1 Sieg · ½ Unentschieden · 0 Niederlage · Live läuft · … geplant');
        const grid = table([T('Name'), ...bots.map(bot => bot.name), T('Punkte')], bots.map(bot => `
            <tr><th scope="row">${esc(bot.name)}</th>${bots.map(opponent => crossCell(bot, opponent)).join('')}
                <td><b>${esc(formatPoints(bot.points))}</b></td></tr>`).join(''), 'ba-cross-table');
        return `<p class="sub">${esc(legend)}</p>${grid}`;
    }

    function archiveHtml(older) {
        return `<button class="ba-link" type="button" data-ba-action="recent">← ${esc(T('Letzte Turniere'))}</button>
            <h3>${esc(T('Ältere Ergebnisse'))}</h3>
            <ul class="ba-archive">${older.map(event => `<li>
                <button class="ba-link" type="button" data-ba-action="event" data-event="${esc(event.id)}">${esc(event.name)}</button>
                <span class="sub">${esc(fmtDate(event.date))} · ${esc(event.version)}</span></li>`).join('')}</ul>`;
    }

    function pickerHtml(event, recent, older) {
        if (older.includes(event)) {
            return `<button class="ba-link" type="button" data-ba-action="archive">← ${esc(T('Ältere Ergebnisse'))}</button>`;
        }
        if (recent.length === 1 && !older.length) return '';
        return `<select id="ba-picker" aria-label="${esc(T('Turnier'))}">
            ${recent.map(item => `<option value="${esc(item.id)}"${item === event ? ' selected' : ''}>
                ${esc(item.name)} · ${esc(item.playing ? T('Läuft') : fmtDate(item.date))}</option>`).join('')}
            ${older.length ? `<option value="archive">${esc(T('Ältere Ergebnisse…'))}</option>` : ''}
            </select>`;
    }

    function tournamentHtml(event, tab, recent, older) {
        const ranks = eventResults(event);
        const finished = event.fixtures.filter(f => f.state === 'finished').length;
        const content = tab === 'cross-table' ? crossTableHtml(ranks) : tab === 'fixtures' ? fixturesHtml(event) : standingsHtml(ranks);
        const onlyEvent = recent.length === 1 && !older.length;
        const conditions = [event.wonders === false && T('Ohne Weltwunder'),
            event.expCivs === false && T('Ohne experimentelle Zivilisationen'),
            typeof event.ranked === 'boolean' && T(event.ranked ? 'Gewertet' : 'Ungewertet')].filter(Boolean);
        return `${onlyEvent || older.includes(event) ? `<h3>${esc(event.name)} · ${esc(fmtDate(event.date))}</h3>` : ''}
            <div class="ba-head">${pickerHtml(event, recent, older)}
                <nav aria-label="${esc(T('Turnieransicht'))}">${tabs.map(([key, label]) => `
                    <button type="button" class="mph-tab ${key === tab ? 'on' : ''}" data-ba-action="tab" data-tab="${key}"
                        aria-pressed="${key === tab}" aria-controls="ba-results">${esc(T(label))}</button>`).join('')}</nav></div>
            <p class="sub ba-meta"><span>${esc(event.version)} · ${esc(T('Plättchenkarte'))} · 1v1 · ${esc(T('%s s pro Zug', event.turnSeconds))} · ${esc(T('Jeder gegen jeden'))}${conditions.length ? ' · ' + esc(conditions.join(' · ')) : ''}</span>
                <span>${esc(T('%s von %s Begegnungen entschieden', finished, event.fixtures.length))}</span></p>
            <div id="ba-results">${content}</div>`;
    }

    async function open() {
        modal(T('Bot-Arena (Vorschau)'), `<div id="ba-box">
            <div class="ba-head ba-meta"><span class="sub" id="ba-source"></span>
                <button class="ba-link" type="button" data-ba-organizer disabled>${esc(T('Veranstalteransicht'))}</button></div>
            <div id="ba-event"><p class="sub">${esc(T('Lade...'))}</p></div></div>`);
        document.getElementById('overlay')?.classList.add('wide');
        const box = document.getElementById('ba-event');
        let records;
        try {
            const response = await fetch('/api/arena-preview/tournaments', { cache: 'no-store' });
            if (!response.ok) throw new Error('Tournament request failed');
            records = await response.json();
        } catch {
            box.textContent = T('Fehler beim Laden der Turnierergebnisse.');
            return;
        }
        if (!box.isConnected) return;
        const events = records.length ? records : examples;
        const recent = events.slice(0, recentLimit);
        const older = events.slice(recentLimit);
        document.getElementById('ba-source').textContent = T(records.length ? 'Turnierergebnisse' : 'Beispieldaten');
        const organizer = document.querySelector('[data-ba-organizer]');
        organizer.disabled = false;
        organizer.addEventListener('click', () => openOrganizer(records[0]?.entrants || bots));
        let recentEvent = recent[0], event = recentEvent, tab = 'standings';
        const draw = focus => {
            box.innerHTML = event ? tournamentHtml(event, tab, recent, older) : archiveHtml(older);
            if (focus) box.querySelector(focus)?.focus();
        };
        box.addEventListener('change', e => {
            if (e.target.id !== 'ba-picker') return;
            if (e.target.value === 'archive') {
                event = null;
                draw('[data-ba-action="recent"]');
            } else {
                event = recentEvent = recent.find(item => item.id === e.target.value);
                tab = 'standings';
                draw('#ba-picker');
            }
        });
        box.addEventListener('click', e => {
            const button = e.target.closest('button[data-ba-action]');
            if (!button) return;
            switch (button.dataset.baAction) {
            case 'tab':
                tab = button.dataset.tab;
                draw(`[data-tab="${tab}"]`);
                break;
            case 'archive':
                event = null;
                draw('[data-ba-action="recent"]');
                break;
            case 'event':
                event = older.find(item => item.id === button.dataset.event);
                tab = 'standings';
                draw('[data-ba-action="archive"]');
                break;
            case 'recent':
                event = recentEvent;
                tab = 'standings';
                draw('#ba-picker');
                break;
            }
        });
        draw();
    }

    function openOrganizer(entrants) {
        const draftKey = 'hochciv.arenaPreviewDraft';
        const kinds = [['scheduled', 'Fester Termin'], ['after', 'Nach Ende des vorigen Turniers']];
        const maps = [['tiled', 'Plättchenkarte'], ['original', 'Originalkarte']];
        const options = values => values.map(([key, label]) => `<option value="${key}">${esc(T(label))}</option>`).join('');
        modal(T('Turnier planen'), `<div id="ba-box">
            <div class="ba-meta"><button class="ba-link" type="button" id="ba-organizer-back">← ${esc(T('Bot-Arena (Vorschau)'))}</button>
                <span class="sub">${esc(T('Beispieldaten'))}</span></div>
            <p class="sub">${esc(T('Jeder gegen jeden'))} · 1v1 Live · ${esc(T('Eine Partie pro Paarung'))}</p>
            <form id="ba-organizer-form">
                <div class="ba-fields">
                    <label>${esc(T('Turniername'))}<input name="name" value="November Cup" required maxlength="80"></label>
                    <label>${esc(T('Karte'))}<select name="map">${options(maps)}</select></label>
                    <label>${esc(T('Sekunden pro Zug'))}<input name="clock" type="number" value="60" min="1" required></label>
                    <label>${esc(T('Turnierstart'))}<select name="startPolicy">${options(kinds)}</select></label>
                    <label id="ba-start-row">${esc(T('Startzeit (Berlin)'))}<input name="start" type="datetime-local" required value="2026-11-28T18:00"></label>
                    <label>${esc(T('Minuten zwischen Rundenstarts'))}<input name="interval" type="number" value="20" min="1" required></label>
                    <label>${esc(T('Karenz für nicht erschienene Bots (Min.)'))}<input name="grace" type="number" value="2" min="0" required></label>
                </div>
                <label class="ba-check"><input name="ranked" type="checkbox" checked> ${esc(T('Gespielte Partien für Bot-MMR werten'))}</label>
                <p class="sub" id="ba-ranked-note" hidden>${esc(T('Gewertete Spiele werden auf der Plättchenkarte gespielt.'))}</p>
                <p id="ba-plan" aria-live="polite"></p>
                <p class="sub">${esc(T('Die Spielversion wird beim Start festgelegt.'))}
                    ${esc(T('Kampflose Siege zählen für den Turnierstand. Der Bot kann in späteren Runden wieder antreten.'))}</p>
                <button type="submit" class="btn primary">${esc(T('Entwurf speichern'))}</button>
                <output aria-live="polite"></output>
            </form></div>`);
        document.getElementById('overlay')?.classList.add('wide');
        document.getElementById('ba-organizer-back').addEventListener('click', open);
        const form = document.getElementById('ba-organizer-form');
        const fields = [...form.elements].filter(field => field.name);
        const output = form.querySelector('output');
        const start = form.elements.start;
        const interval = form.elements.interval;
        const ranked = form.elements.ranked;
        const fixtures = roundRobin(entrants);
        const rounds = new Set(fixtures.map(fixture => fixture.round)).size;

        function updatePlan() {
            start.disabled = form.elements.startPolicy.value === 'after';
            document.getElementById('ba-start-row').hidden = start.disabled;
            ranked.disabled = form.elements.map.value === 'original';
            document.getElementById('ba-ranked-note').hidden = !ranked.disabled;
            if (ranked.disabled) ranked.checked = false;
            document.getElementById('ba-plan').textContent = interval.validity.valid
                ? T('%s Bots · %s Runden · %s Begegnungen · %s Min. geplant', entrants.length, rounds, fixtures.length, rounds * interval.valueAsNumber)
                : '';
        }

        try {
            const draft = JSON.parse(localStorage.getItem(draftKey)) || {};
            for (const field of fields) {
                if (!(field.name in draft)) continue;
                if (field.type === 'checkbox') field.checked = draft[field.name];
                else field.value = draft[field.name];
            }
        } catch { /* A missing or inaccessible local draft leaves the form at its defaults. */ }
        form.addEventListener('input', () => {
            output.textContent = '';
            updatePlan();
        });
        form.addEventListener('submit', e => {
            e.preventDefault();
            const draft = Object.fromEntries(fields.map(field => [field.name, field.type === 'checkbox' ? field.checked : field.value]));
            try {
                localStorage.setItem(draftKey, JSON.stringify(draft));
                output.textContent = T('Entwurf in diesem Browser gespeichert.');
            } catch {
                output.textContent = T('Der Entwurf konnte nicht gespeichert werden.');
            }
        });
        updatePlan();
    }

    window.HC_ARENA_PREVIEW = { open };
})();
