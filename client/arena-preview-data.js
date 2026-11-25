/* Example tournament records for the opt-in preview. No server or bot accounts are used. */
(function () {
    'use strict';

    const bots = ['SeymourBot', 'ChuckBot', 'HansImBot', 'DonTheBot', 'NuremBot', 'NeuraBot', 'NeuraNew', 'Statibot'];
    const tournaments = [
        ['24', 'Tiled Cup', 'v112', 3],
        ['23', 'Evening Cup', 'v112', 7],
        ['22', 'Sunday Cup', 'v112', 7],
        ['21', 'Autumn Cup', 'v112', 7],
        ['20', 'November Cup', 'v112', 7],
        ['19', 'Version 112 Opener', 'v112', 7],
        ['18', 'Midweek Cup', 'v111', 7],
        ['16', 'Opening Cup', 'v111', 7],
    ];

    function roundRobin(entrants) {
        if (entrants.length < 2) return [];
        const seats = [...entrants];
        if (seats.length % 2) seats.push(null);
        const fixtures = [];
        for (let round = 1; round < seats.length; round++) {
            for (let i = 0; i < seats.length / 2; i++) {
                const a = seats[i], b = seats[seats.length - 1 - i];
                if (a !== null && b !== null) fixtures.push({ a, b, round });
            }
            seats.splice(1, 0, seats.pop());
        }
        return fixtures;
    }

    const events = tournaments.map(([day, name, version, completeRounds], index) => ({
        id: 'cup-' + day,
        name,
        version,
        date: '2026-11-' + day,
        playing: completeRounds < 7,
        turnSeconds: 60,
        entrants: bots,
        fixtures: roundRobin(bots).map(({ a, b, round }, i) => {
            const roll = (i * 7 + index * 3) % 10;
            const score = roll === 7 ? 0.5 : roll < 7 ? 1 : 0;
            return {
                a, b, round,
                state: round <= completeRounds ? 'finished' : round === completeRounds + 1 ? 'live' : 'scheduled',
                score: round <= completeRounds ? score : null,
            };
        }),
    }));

    const data = { events, bots, roundRobin };
    if (typeof module === 'object') module.exports = data;
    else window.HC_ARENA_PREVIEW_DATA = data;
})();
