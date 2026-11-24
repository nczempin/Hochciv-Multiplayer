/* Bot Arena results and live fixtures, with sample data for an empty preview. */
(function () {
    'use strict';

    const { events: examples } = window.HC_ARENA_PREVIEW_DATA;
    const recentLimit = 5;
    const T = (de, ...args) => HC_I18N.t(de, ...args);
    const fmtDate = date => new Date(date).toLocaleDateString(HC_I18N.locale(), { dateStyle: 'medium', timeZone: 'UTC' });
    const tabs = [['standings', 'Turnierstand'], ['fixtures', 'Begegnungen'], ['cross-table', 'Kreuztabelle']];
    const states = { finished: 'Beendet', live: 'Läuft', scheduled: 'Geplant' };
    const outcomes = { 1: ['1', 'Sieg'], 0.5: ['½', 'Unentschieden'], 0: ['0', 'Niederlage'] };
    const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

    function eventResults(event) {
        const bots = new Map(event.entrants.map(name => [name, {
            name, build: event.builds?.[name], points: 0, sonnebornBerger: 0, record: [0, 0, 0], opponents: new Map(),
        }]));
        const decided = event.fixtures.filter(f => f.score !== null);
        const completedPairs = new Map();
        if (event.doubleHeader) {
            for (const { pair } of decided) completedPairs.set(pair, (completedPairs.get(pair) || 0) + 1);
        }
        const scoring = event.doubleHeader ? decided.filter(f => completedPairs.get(f.pair) === 2) : decided;
        for (const { a, b, score, state } of event.fixtures) {
            const first = bots.get(a), second = bots.get(b);
            if (!first.opponents.has(b)) first.opponents.set(b, []);
            if (!second.opponents.has(a)) second.opponents.set(a, []);
            first.opponents.get(b).push({ score, state });
            second.opponents.get(a).push({ score: score === null ? null : 1 - score, state });
        }
        for (const { a, b, score } of scoring) {
            const first = bots.get(a), second = bots.get(b);
            first.points += score;
            second.points += 1 - score;
            first.record[2 - 2 * score]++;
            second.record[2 * score]++;
        }
        for (const { a, b, score } of scoring) {
            const first = bots.get(a), second = bots.get(b);
            first.sonnebornBerger += score * second.points;
            second.sonnebornBerger += (1 - score) * first.points;
        }
        return [...bots.values()].sort((a, b) =>
            b.points - a.points || b.sonnebornBerger - a.sonnebornBerger || a.name.localeCompare(b.name));
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
        return table(['#', T('Name'), T('Spiele'), T('S–U–N'), T('Punkte'), 'Sonneborn–Berger'], bots.map((bot, i) => {
            if (bot.points !== previous?.points || bot.sonnebornBerger !== previous?.sonnebornBerger) rank = i + 1;
            previous = bot;
            const played = bot.record.reduce((a, b) => a + b, 0);
            const build = bot.build ? `<small class="ba-build">${esc(bot.build)}</small>` : '';
            return `<tr><td>${rank}</td><th scope="row">${esc(bot.name)}${build}</th><td>${played}</td>
                <td>${bot.record.join('–')}</td><td><b>${esc(formatPoints(bot.points))}</b></td>
                <td>${esc(formatPoints(bot.sonnebornBerger))}</td></tr>`;
        }).join(''));
    }

    function fixturesHtml(event) {
        return table([T('Begegnungen'), T('Runde'), ...(event.doubleHeader ? [T('Partie')] : []), T('Ergebnis')], event.fixtures.map(f => {
            const result = f.score === null ? T(states[f.state]) : `${formatPoints(f.score)}–${formatPoints(1 - f.score)}`;
            const action = f.watch ? ` <a href="${esc(MP.inviteUrl(f.watch.code, f.watch.password))}">${esc(T('Zuschauen'))}</a>`
                : f.replay ? ` <a href="?replay=${encodeURIComponent(f.replay)}">${esc(T('Wiederholung'))}</a>` : '';
            return `<tr><td>${esc(f.a)} – ${esc(f.b)}</td><td>${f.round}</td>
                ${event.doubleHeader ? `<td>${f.leg}/2</td>` : ''}<td>${esc(result)}${action}</td></tr>`;
        }).join(''));
    }

    function formatPoints(points) {
        return points.toLocaleString(HC_I18N.locale());
    }

    function crossCell(bot, opponent) {
        if (bot.name === opponent.name) return `<td class="ba-self" aria-label="${esc(T('Gleicher Bot'))}">—</td>`;
        const fixtures = bot.opponents.get(opponent.name) || [{ state: 'scheduled' }];
        const marks = fixtures.map(fixture => fixture.state === 'scheduled' ? ['…', 'Geplant']
            : fixture.state === 'live' ? ['Live', 'Läuft'] : outcomes[fixture.score]);
        return `<td aria-label="${esc(marks.map(([, label]) => T(label)).join(' / '))}">
            ${marks.map(([mark]) => mark).join(' · ')}</td>`;
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
        const conditions = [event.doubleHeader && T('Gespiegelte Doppelpaarungen'), event.wonders === false && T('Ohne Weltwunder'),
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
                ${['admin', 'superadmin', 'tournamentdirector'].includes(MP.user?.role) ? `<a class="ba-link" href="/client/admin.html#arena">${esc(T('Veranstalteransicht'))}</a>` : ''}</div>
            <div id="ba-event"><p class="sub">${esc(T('Lade...'))}</p></div></div>`);
        document.getElementById('overlay')?.classList.add('wide');
        const box = document.getElementById('ba-event');
        async function read() {
            const response = await fetch('/api/arena-preview/tournaments', { cache: 'no-store' });
            if (!response.ok) throw new Error('Tournament request failed');
            return response.json();
        }
        let records;
        try {
            records = await read();
        } catch {
            box.textContent = T('Fehler beim Laden der Turnierergebnisse.');
            return;
        }
        if (!box.isConnected) return;
        let events = records.length ? records : examples;
        let recent = events.slice(0, recentLimit);
        let older = events.slice(recentLimit);
        document.getElementById('ba-source').textContent = T(records.length ? 'Turnierergebnisse' : 'Beispieldaten');
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
        if (!records.length) return;
        let refreshing = false;
        let prior = JSON.stringify(records);
        const timer = setInterval(async () => {
            if (!box.isConnected) { clearInterval(timer); return; }
            if (refreshing || document.hidden || document.activeElement?.id === 'ba-picker') return;
            refreshing = true;
            try {
                const latest = await read();
                const current = JSON.stringify(latest);
                if (!box.isConnected || !latest.length || current === prior) return;
                const latestEvent = event && event === events[0];
                events = latest;
                recent = events.slice(0, recentLimit);
                older = events.slice(recentLimit);
                if (event) event = latestEvent ? events[0] : events.find(item => item.id === event.id) || events[0];
                recentEvent = event || recent[0];
                prior = current;
                draw(document.activeElement?.dataset.tab ? `[data-tab="${tab}"]` : undefined);
            } catch { /* Keep the last loaded results until the server is reachable again. */ }
            finally { refreshing = false; }
        }, 5000);
    }

    window.HC_ARENA_PREVIEW = { open };
})();
