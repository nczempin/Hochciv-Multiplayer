/**
 * Which player-bots (bot accounts, utils/bots.js) may join a live lobby – the host's bot filter,
 * on top of "Spieler-Bots erlauben" and the limit (sessions.js playerBotPolicy):
 *
 *   gameConfig.playerBotFilter = {
 *     only:    false → every bot except the excluded ones; true → only the ones let in below
 *     own:     (only) bots of the host – owned by the host, or by the same owner if a bot hosts
 *     friends: (only) bots the host is friends with
 *     allow:   (only) these bot ids
 *     block:   these bot ids never – also when `own` or `friends` would let them in
 *   }
 *   no filter (null) = every bot.
 *
 * A seat of a bot account records its owner (botOwnerId) and whether it is the host's friend
 * (botFriend, set at the join and again before the start – refreshSeats – as the host may have
 * changed). Checked when a bot joins (sessions.joinSession), when it is invited (utils/friends.js)
 * and at the start (sockets/game.js beginGame: a bot that joined before the filter was set has to
 * be kicked first, like with the limit).
 */
const MAX_IDS = 100;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The host's filter as stored, or null for "every bot" (also for anything unusable). */
function clean(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const ids = v => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && ID_RE.test(x)).map(x => x.toLowerCase()))].slice(0, MAX_IDS) : []);
    const f = { only: raw.only === true, own: raw.own === true, friends: raw.friends === true, allow: ids(raw.allow), block: ids(raw.block) };
    if (!f.only) { f.own = false; f.friends = false; f.allow = []; }
    f.allow = f.allow.filter(id => !f.block.includes(id));
    return f.only || f.block.length ? f : null;
}

/** The account whose bots count as "own" for the host: the host's, or a bot host's owner. */
function hostOwnerId(session) {
    const host = session.players[session.hostIndex];
    if (!host) return null;
    return host.playerBot ? host.botOwnerId || null : host.dbUserId || null;
}

/**
 * null if the filter lets this bot in, else why not (German, for the bot's program and the host).
 * `bot` = { id, ownerId, friend } – friend: the host's friend.
 */
function reason(session, bot) {
    const f = session.gameConfig && session.gameConfig.playerBotFilter;
    if (!f) return null;
    const id = String(bot.id || '').toLowerCase();
    if (f.block.includes(id)) return 'Dieser Bot ist in dieser Lobby ausgeschlossen.';
    if (!f.only) return null;
    if (f.allow.includes(id)) return null;
    const owner = hostOwnerId(session);
    if (f.own && owner && bot.ownerId === owner) return null;
    if (f.friends && bot.friend) return null;
    return 'Dieser Bot ist in dieser Lobby nicht zugelassen.';
}

/** The bot seats (not the host) the filter doesn't let in. */
function refusedSeats(session) {
    const host = session.players[session.hostIndex];
    return session.players.filter(p => p.playerBot && p !== host
        && reason(session, { id: p.botUserId, ownerId: p.botOwnerId, friend: p.botFriend }));
}

/** The ids of these accounts that are accepted friends of `userId`. */
async function friendsAmong(userId, ids) {
    if (!userId || !ids.length) return new Set();
    const { Op } = require('sequelize');
    const { Friendship } = require('../models');
    const rows = await Friendship.findAll({
        where: { status: 'accepted', [Op.or]: [{ userId, friendId: ids }, { friendId: userId, userId: ids }] },
        attributes: ['userId', 'friendId'],
    });
    return new Set(rows.map(r => (r.userId === userId ? r.friendId : r.userId)));
}

/** Is the bot `botId` a friend of the session's host? (a bot host has no friends) */
async function isHostFriend(session, botId) {
    const host = session.players[session.hostIndex];
    if (!host || host.playerBot || !host.dbUserId) return false;
    return (await friendsAmong(host.dbUserId, [botId])).has(botId);
}

/** botFriend of every bot seat again, for the current host. */
async function refreshSeats(session) {
    const host = session.players[session.hostIndex];
    const seats = session.players.filter(p => p.playerBot && p.botUserId);
    if (!seats.length) return;
    const friends = host && !host.playerBot && host.dbUserId ? await friendsAmong(host.dbUserId, seats.map(p => p.botUserId)) : new Set();
    seats.forEach(p => { p.botFriend = friends.has(p.botUserId); });
}

module.exports = { clean, reason, refusedSeats, hostOwnerId, friendsAmong, isHostFriend, refreshSeats, MAX_IDS };
