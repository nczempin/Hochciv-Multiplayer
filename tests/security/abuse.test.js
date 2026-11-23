/**
 * Abuse findings of the findings report that need no server:
 *
 *   node tests/security/abuse.test.js
 *
 *   · R-15 every socket event goes through a token bucket; a flood gets error acks and is
 *          disconnected, normal play and a bot waiting for its acks are not
 */
const SocketLimit = require('../../utils/socket-limit');

let failed = 0;
const ok = (cond, name, info) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
    if (!cond) failed++;
};

/** A socket with Socket.IO's per-packet middleware: send() returns 'handled' or the ack reply. */
function fakeSocket() {
    const s = {
        id: 'test', mw: [], disconnected: false,
        use(fn) { this.mw.push(fn); },
        disconnect() { this.disconnected = true; },
        send(event, data = {}, withAck = true) {
            let reply = 'no ack', handled = false;
            const packet = withAck ? [event, data, r => { reply = r; }] : [event, data];
            this.mw[0](packet, () => { handled = true; });
            return handled ? 'handled' : reply;
        },
    };
    SocketLimit.attach(s);
    return s;
}

(async () => {
    // ── R-15 ─────────────────────────────────────────────────────────────────
    {
        const { LIMITS } = SocketLimit;
        const s = fakeSocket();
        let handled = 0;
        for (let i = 0; i < LIMITS.other.burst; i++) if (s.send('lobby:config') === 'handled') handled++;
        ok(handled === LIMITS.other.burst, 'R-15 a burst up to the bucket size is handled', String(handled));
        const r = s.send('lobby:config');
        ok(r && r.error === SocketLimit.MESSAGE, 'R-15 the next event gets an error ack instead of being handled');
        ok(s.send('action') === 'handled', 'R-15 game moves have their own bucket');
        ok(!s.disconnected, 'R-15 a few dropped events do not disconnect');

        // the bucket refills with time
        const b = SocketLimit.bucket(LIMITS.other);
        for (let i = 0; i < LIMITS.other.burst; i++) SocketLimit.take(b, b.at);
        ok(!SocketLimit.take(b, b.at) && SocketLimit.take(b, b.at + 1000 / LIMITS.other.rate + 1), 'R-15 the bucket refills at its rate');

        // a flood is disconnected
        const f = fakeSocket();
        let errors = 0;
        for (let i = 0; i < 1000 && !f.disconnected; i++) if (f.send('game:trend').error) errors++;
        ok(f.disconnected && errors >= SocketLimit.MAX_STRIKES - 1, 'R-15 a socket that floods is disconnected', `${errors} error acks`);
        const q = fakeSocket();
        for (let i = 0; i < LIMITS.other.burst; i++) q.send('game:trend', {}, false);
        ok(q.send('game:trend', {}, false) === 'no ack', 'R-15 an event without an ack is dropped silently');

        // a bot sending one move per 40 ms for 10 s stays below the limit
        const m = SocketLimit.bucket(LIMITS.move);
        let refused = 0;
        for (let t = 0; t < 10000; t += 40) if (!SocketLimit.take(m, m.at + t)) refused++;
        ok(refused === 0, 'R-15 25 moves per second for 10 s pass');
    }

    console.log(failed ? `\n${failed} failed` : '\nall passed');
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
