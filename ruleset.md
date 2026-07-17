# Exercise Risk — Ruleset v0.1

## 1. Overview

A daily, turn-based reimagining of Risk where troop reinforcements are earned through real-world exercise instead of territory/card bonuses alone. Full 42-territory Risk board, full turn phases, one turn per player per day, world domination to win.

- **Max players:** 10
- **Board:** Standard Risk map (6 continents, 42 territories)
- **Win condition:** World domination (control all 42 territories)
- **Roles:** Players, and one Creator/Admin (can also be a player)

---

## 2. Setup

1. Admin creates the game and sets:
   - The exercise-to-troop conversion table (see Section 3) — **applies equally to all players**
   - Daily caps per exercise type, and a daily total troop cap
   - The 7:00 PM turn-window start time (fixed per game, see Section 5)
2. Players join (up to 10).
3. **Territory distribution:** Standard Risk starting armies scale down as player count goes up. With up to 10 players on the standard 42-territory board, territories are dealt out evenly (each player gets ~4 territories), with leftover territories dealt to **neutral** garrisons (2 armies each, no owner, can't act, can only be attacked). _(Open item — confirm you're OK with neutral territories, or would rather scale board size instead. Full Risk historically supports up to 6 players; 10 is new territory, pun intended, so this is my proposed fix.)_
4. Each player's starting personal army is placed on their territories per the standard Risk initial-army table for the closest supported player count, adjusted down proportionally for higher player counts.
5. Turn order is randomized once at game start (this becomes "the line" referenced in Section 5).

---

## 3. Troop Earning (Exercise Conversion)

- Conversion rates and caps are **global** — same for every player in the game, set once by the Admin at game creation and locked for the game's duration (Admin can only edit for future games, not mid-game, to keep it fair).
- Example table (Admin fills in real values at setup):

| Exercise      | Conversion       | Daily Cap              |
| ------------- | ---------------- | ---------------------- |
| Running       | 1 mile = 1 troop | 3 miles/day (3 troops) |
| Weightlifting | 30 min = 1 troop | (Admin-defined)        |
| ...           | ...              | ...                    |

- **Daily total troop cap:** Admin also sets a hard ceiling on total troops earnable per day across _all_ exercise types combined, so no stacking every category into an oversized army.
- **Reporting:** Self-reported at this stage (future: auto-import via health app). Admin can resolve disputes over reported exercise (see Section 8).
- Earned troops become that player's **reinforcements** for their next turn.
- **Elimination stops earning** — eliminated players no longer log exercise for troops, but retain spectator access to the game.

---

## 4. Turn Phases (per player, per day)

Standard Risk turn structure, compressed into one daily turn:

1. **Reinforcement Phase** — place troops earned since your last turn (capped by whatever you actually earned/logged) onto any territory(s) you own.
2. **Attack Phase** — attack adjacent enemy or neutral territories (see Section 6 for combat resolution and stop-loss).
3. **Fortify Phase** — move troops once between two of your own connected territories to consolidate defenses.

Once all three phases are completed (or explicitly skipped by the player), the turn ends and passes to the next player in line.

---

## 5. Daily Timing & Turn Window

- Turns open at **7:00 PM** each day, one player at a time, in line order.
- Each player gets a **single 20-minute window** to complete their turn when they reach the front of the line. **There is no second chance and no back-of-the-line requeue** — if you miss your window, the system resolves your turn for you (below).
- **Standing orders note:** each player keeps a persistent, free-text **standing-orders note** describing what they'd want done on their behalf if they miss a window (e.g. "push into South America from Venezuela, otherwise hold my borders"). They can edit it anytime; it is set-and-forget and reused every time they miss.
- **If a player misses their window, the system auto-resolves their turn via AI, guided by their note:**
  - An AI reads the current board state and the player's standing-orders note and produces a full turn plan — reinforcement placement, any attacks, and a fortify move — which the engine then **validates and applies** (any illegal or nonsensical action the AI proposes is skipped, never trusted blindly).
  - Attacks are executed with a conservative default stop-loss unless the note specifies otherwise, so the AI can't recklessly bleed the player's army.
  - **If the note is empty (or purely defensive), the AI makes no attacks** — it falls back to a deterministic defensive placement (reinforce the most-threatened border territory) with no attack and no fortify.
- The deterministic defensive fallback formula is specified in the engine; see Open Items (Section 10).

---

## 6. Combat Resolution

Rather than rolling dice repeatedly per exchange, combat is resolved probabilistically in one pass per attack, approximating classic Risk odds (attacker generally favored per-troop but defender has a per-troop edge in ties):

- Player declares: which territory to attack from, which to attack, how many troops to commit, and a **stop-loss limit** (max troops they're willing to lose before the attack auto-halts).
- The system simulates the exchange internally (using Risk-equivalent win probabilities per troop matchup) until **one** of these ends the attack:
  1. Defending territory is fully captured (defender troops reach 0) → attacker moves in and takes the territory.
  2. Attacker's cumulative losses hit their stated stop-loss limit → attack halts, no territory change, surviving attacking troops return to the origin territory.
  3. Attacker is reduced to 1 troop (minimum needed to hold origin territory) → attack halts automatically regardless of stop-loss setting.
- A player may launch multiple attacks in a single Attack Phase (attacking different territories, or re-attacking the same one) until they choose to move to Fortify.

_(Open item — the exact probability formula. I'd recommend approximating classic 3v2 dice odds, roughly attacker wins ~60% of individual exchanges when attacking with 3+ vs 2 defenders, adjusted down for smaller commitments. I can build this as a lookup table or a formula — happy to spec it out precisely once you confirm you want probability-based single-pass resolution rather than exact dice-by-dice.)_

---

## 7. Elimination & Spectating

- A player is eliminated when they lose all territories.
- Eliminated players:
  - Stop earning troops from exercise.
  - Can still **view** the game (board state, turn history) but take no further actions.

---

## 8. Admin / Host Powers

- Resolve disputes (e.g., contested exercise reports).
- Manage player roster (handle disconnects, replace inactive players — _open item, see Section 10_).
- Set the exercise conversion table and caps at game creation (locked once the game starts).
- Set the daily turn window start time for the game.

---

## 9. Win Condition

- Sole win condition: **control all 42 territories** (full world domination). No turn-limit or partial-control win state.

---

## 10. Open Items to Confirm

1. **Board scaling for 10 players:** confirm neutral-territory approach (Section 2) or prefer something else (e.g., a modified board with more territories, or fixed uneven distribution)?
2. **Auto-resolution (Section 5):** RESOLVED — a missed window is auto-resolved by an AI acting on the player's persistent standing-orders note (full turn: reinforce/attack/fortify, validated by the engine). Empty/defensive note falls back to a deterministic formula: reinforce the most-threatened border territory (highest sum of adjacent enemy/neutral armies minus own armies), no attack, no fortify.
3. **Combat odds formula (Section 6):** confirm you want single-pass probability resolution (fast, one calculation) vs. a step-by-step simulated exchange loop (slower, more "visible" to the player as it happens, still no manual dice rolling either way).
4. **Inactive/disconnected players:** if someone stops logging in entirely for multiple days, does the Admin have a removal/forfeit power, or does the auto-place system just keep playing them indefinitely?
5. **Fortify limits:** standard Risk allows one fortify move between _connected_ territories via an unbroken chain of owned territories — confirming that's what you want, versus adjacent-only.
6. **Multiple attacks per turn:** confirmed unlimited attacks within the Attack Phase — any cap you'd want here, or truly unlimited until the player ends the phase?

---

_This is a living document — update it as decisions get made before locking the data model in code._
