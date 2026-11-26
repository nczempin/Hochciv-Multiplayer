[← Documentation](../README.md)

# Rundenspiele (asynchronous games)

A Rundenspiel is played turn by turn over days. Unlike live games it lives in the database (`async_games`) and survives restarts. The rules of the meta game (seats, invitations, pre-phases, timeouts) are in `async/logic.js`, persistence, notifications and the scheduler in `async/service.js`. All of it needs an account.

## Lifecycle

```
setup ──▶ placement (tile map) ──┐
   │  └─▶ draft (Marathon) ──────┼──▶ playing ──▶ finished
   │                             │
   └─────────────────────────────┘        (any phase) ──▶ cancelled
```

* **setup** – the host creates the game ([REST API](rest-api.md#rundenspiele--apiasync-login)) with map, number of empires, how many of them KI (or none), nation mode, events, wonders, KI level, ranked and public. Players join by invitation, join code or the public list.
* **Starting early** – when the seats are already final (nations dealt at random, or all four nations of a fixed map), the game starts right away: the host plays turn 1 while the others join. A turn of a seat nobody has claimed yet waits (`hold`) until someone takes it. Otherwise – and always without KI – the game starts once everybody is there.
* **placement / draft** – pre-phases of the tile map (everyone places a start tile) and of Marathon (ability draft).
* **playing** – one action at a time per game; the state is saved after every action and every KI turn, and everyone who has the game open gets the new view.
* **finished** – result, points and MMR are stored as a match (`games`), the turn states become a replay. MMR, match and the game's `result` are written in one transaction ([Security](security.md#results-and-mmr)); if that fails, the scheduler tries again every 10 minutes, up to 5 times.
  The game list (`GET /api/async`, `ended`) keeps a finished game for each player until they open it once (`data.endSeen`, set by `async:open` and for everyone who has the game open when it ends), at most 14 days.
* **cancelled** – by the host, when not enough players joined (games without KI), or when the host's account is deleted during setup.

Leaving is free until your seat has had its first turn (or the pre-phase began).

## Seats

* **Nations:** random for everyone, or fixed (one seat per nation on fixed maps; any nation, also twice, on the tile map and custom maps – doubles get Roman numerals and their own colours).
* **KI seats** fill the empires beyond the number of humans, at the level the host chose (ranked: the hardest).
* **Without KI** the nations nobody took leave the game before it starts; two empires play as a duel (higher victory thresholds).
* Each game records the game version it started with (`engine`) and keeps it to the end – see [How it works](../overview/how-it-works.md#game-versions).

## Waiting, reminders and the KI takeover

The server checks every 10 minutes (`ASYNC_SWEEP_MS`) how long each game has been waiting (`waitSince`). The host picks the **time per turn** when creating the game: 1, 3 or 7 days (`config.turnDays`, default 7). The times below are for 7 days; a shorter time per turn scales both (1 day: reminder after about 17 hours, takeover after 1 day). Finding players (setup) always has the full 7 days.

| After | What happens |
|---|---|
| 5 days (`ASYNC_REMINDER_MS`) | Reminder to whoever the game waits for |
| 7 days (`ASYNC_TIMEOUT_MS`) | The game resolves whatever it waits for (see below), and the affected players are told |

At the 7-day timeout:

| Phase | Resolution |
|---|---|
| setup, with KI | Plays with those who are there; the KI fills up. Fewer than two humans: not ranked any more. |
| setup, without KI | Plays with those who are there if the map allows that many empires, otherwise cancelled |
| placement | The KI places the missing start tiles and takes over those seats |
| draft | The KI picks for the player and takes over the seat |
| playing, unclaimed seat | The KI plays that nation; one human fewer |
| playing, a player's turn | The KI takes over the seat for the rest of the game (`replaced`) |

A seat taken over by the KI plays at level *mittel*, in ranked games *schwer*. In ranked games the player who was replaced loses **15 MMR** on top of the result ([Points and MMR](ranking.md)) – except in a ranked live game the host continued as a Rundenspiel (`config.fromLive`): there the takeover costs no MMR, since only the host picked the time per turn. Players who had resigned in the live game get their 15 MMR penalty when the game is converted. Replaced players still see the game in their history (`replacedUserId`).

## Weekly challenge

The weekly challenge (`utils/challenge.js`) is a Rundenspiel the server creates for one player with `config.challenge` = the week: the week's map, nation, ability and settings, three KI seats (base ability, the week's level) and a fixed seed. The seed is also the game's fixed dice (`config.fixedDice`, the engine's `cfg.fixedDice` since v106): which techs become available and the event of every round depend only on the week, not on how the game is played, so every attempt has the same tech tree and events. Battles and other dice still follow the play. It can't be left or cancelled, only resigned; there are no free seats. When it ends, its result goes to its row in `challenge_results` (by `asyncId`). It is never ranked. A player can play a week as often as they like, one attempt at a time; starting another resigns the running one.

## Bot ladder

The bot ladder (`async/ladder.js`) pairs [bot accounts](bot-accounts.md) automatically. It is off until an admin switches it on (admin panel → *Übersicht* → *Bot-Liga*; stored in the `settings` row `arena-correspondence-ladder`), and a bot takes part only when its owner opted it in (*Meine Bots* → *An der Bot-Liga teilnehmen*, `users.arenaLadderOptIn`).

The server checks for pairings every 15 seconds by default. An admin can save a pairing interval of 5–300 seconds. This changes how soon the server checks for available bots. It leaves the deadlines of existing games intact. Each check can pair bots that

* asked for their games (`GET /api/async`) within the last five minutes,
* are opted in and allowed to play (not disabled, their owner neither),
* have no running ladder game and fewer than the 30 running Rundenspiele an account may have.

The bot with the fewest finished ladder games is paired first, with the opponent it has met least often, then the one with fewer games, then the closest MMR. With *Direkte Wiederholung vermeiden* nobody gets the opponent of its last game again right away.

A ladder game is an ordinary public Rundenspiel for two on the tile map, with random nations and turn order and the admin's days per turn (`config.arena`, `config.arenaLadder`). Both bots are seated from the start and place their start tiles first. It is rated between bots of different owners; between bots of one owner only if the admin allows it. It can be resigned but neither left nor cancelled, and it follows the usual waiting rules: a bot that doesn't play in time is replaced by the KI. Only the server creates ladder games – a request can't set the two flags.

The *Bot-Liga* standings (`GET /api/async/ladder`) count the finished games per game version: games, wins–draws–losses and the score rate (wins plus half the draws, over the games). A bot whose seat the KI took over has lost that game, whatever the KI made of it.

In the admin overview, *Position der Bot-Liga* selects the leaderboard tab (default) or a main-menu button. The game page reads the saved selection when it loads. Both entry points call `RANKING.openLadder()` in `client/ranking.js`. The main-menu hook is `MP.drawLadderButton()` in `mp.js`, and the leaderboard tab is in `RANKING.draw()`.

## Resigning

While the game runs, a player can resign (*Aufgeben* in the game menu, `POST /api/async/:id/resign`). The KI plays the seat to the end, like after the 7-day timeout (same level, same 15 MMR in ranked games); the player watches the game read-only. A duel without KI ends at once with the other player's win; when nobody human is left, the most points win.

## Notifications

Through `utils/notify.js`, by e-mail and [push](../operations/push-notifications.md): invitation, your turn (with a short "since your last turn" summary), reminder, takeover, game finished. Players switch e-mail and push separately in the Rundenspiele list.

## Account deletion

A running game goes on without the deleted player: a seat that has not played yet is free again (the host's game in setup is cancelled), otherwise the KI plays it to the end without penalty. During placement and draft an account can't be deleted until the phase is over. Afterwards no seat, invitation or name points to the account any more – the name is replaced by *Gelöschter Spieler* in the state and the replay frames.

## Chat

The game keeps its last 200 chat messages; unread messages are shown when it is opened again. Blocks and reports work as in live games.
