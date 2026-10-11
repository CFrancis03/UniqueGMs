# Unique GMs Beaten (random vibecode stuff)

A single-page web app that takes a Chess.com username and shows how many unique Grandmasters that player has beaten, with a list of each GM, the date of the first win against them, and a link to that game.

## Run it

No build step. It's plain HTML/CSS/vanilla JS.

```sh
# From this directory, pick any static server:
python3 -m http.server 5173
# then open http://localhost:5173
```

Opening `index.html` directly via `file://` also works in most browsers because the Chess.com Public API sends `Access-Control-Allow-Origin: *`.

## How it works

1. Fetches the GM title list (`/pub/titled/GM`) once per session and stores the lowercased usernames in a `Set`.
2. Fetches the player's monthly archive index (`/pub/player/{user}/games/archives`).
3. Fetches each monthly archive with a concurrency pool of 4. Past months are cached in `sessionStorage`; the current month is always refetched (it keeps growing).
4. For every game where the player won, if the opponent's lowercased username is in the GM set, records a (opponent → earliest `end_time` + game URL + opponent's rating + move count) entry.
5. Shows the total unique count as a big headline and renders a card per GM with the first-win details.
6. After the archive pass, runs a second concurrent pass that enriches each GM with `/pub/player/{u}` + `/pub/player/{u}/stats` to populate avatar, real name, title, country flag, and current Blitz / Bullet / Rapid / Daily / FIDE ratings. Profiles are cached in `sessionStorage` for 24 hours. Rows update in place as data arrives.
7. A dropdown lets you sort by:
   - **Most recent win** (default)
   - **Opponent rating** (highest first) — current Blitz rating when available, else Rapid/Bullet/game-time
   - **Game length** (most moves first) — full-move count parsed from the PGN

### Request behavior

- On `429` or `5xx`: honors `Retry-After` if present, otherwise exponential backoff with jitter (up to 5 retries per URL).
- On `404` for the archives endpoint: shown as "user not found" (clean message, not a scary error).
- All in-flight work is cancelled when the user clicks **Cancel** (uses an `AbortController`).

### Variants

Only `rules === "chess"` games count by default. Tick **Include variants** to include chess960, bughouse, etc.

### Caching

- GM list: cached in `sessionStorage` for 24 hours.
- Each past monthly archive: cached under `archive-v1:<url>`.
- Current month: always refetched.

Clearing: `sessionStorage.clear()` in devtools, or just close the tab.

## Known limitations / caveats

- **"GM" means currently on the title list.** The Chess.com `/pub/titled/GM` endpoint only lists the current title holders. If someone was a GM and later lost the title (rare) or renamed their Chess.com account, we won't count games against the old username.
- **Only Chess.com Live/Daily games** that appear in the player's archives. Puzzles, lessons, computer games, and tournament games played off-platform aren't included.
- **Renamed accounts**: if a GM has changed their Chess.com username, old archives still show the old name, which won't match the current GM list. These wins are missed.
- **Closed accounts**: a closed Chess.com account's `/archives` returns `404`, same as "user not found." There's no reliable way to distinguish.
- The **"first win" date** is derived from `end_time` across all pages we scanned — it should be accurate as long as the archives themselves are intact.
- `sessionStorage` has a size cap (usually 5–10 MB). A player with thousands of monthly archives could exceed it; cache writes are wrapped in try/catch, so the app just skips caching rather than crashing.
- Timestamps displayed in the user's local timezone, derived from `end_time` (UTC seconds).

## Test suggestions

Try these to sanity-check:

- `hikaru` — expect a large number (hundreds).
- `magnuscarlsen` — expect a large number.
- A small account you know — expect 0 or a very small number.
- A nonexistent username — expect "user not found."

## Files

- `index.html` — markup and layout.
- `style.css` — styling, light/dark via `prefers-color-scheme`, responsive.
- `app.js` — all logic (fetching, caching, concurrency, retries, UI).
