const API = "https://api.chess.com/pub";
const CONCURRENCY = 4;
const MAX_RETRIES = 5;
const GM_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const GM_CACHE_KEY = "gm-list-v1";
const ARCHIVE_PREFIX = "archive-v2:";
const PROFILE_PREFIX = "profile-v1:";
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<rect width="100" height="100" fill="#2a2a2a"/>' +
      '<text x="50" y="78" text-anchor="middle" font-family="serif" font-size="80" fill="#bbb">♞</text>' +
      "</svg>"
  );

const $ = (id) => document.getElementById(id);
const form = $("form");
const usernameInput = $("username");
const checkBtn = $("check");
const cancelBtn = $("cancel");
const variantsInput = $("variants");
const progressEl = $("progress");
const progressText = $("progressText");
const barFill = $("barFill");
const errorEl = $("error");
const resultsEl = $("results");
const countEl = $("count");
const metaEl = $("meta");
const listEl = $("list");
const sortEl = $("sort");

let currentController = null;
let lastWins = [];
const liByName = new Map();

form.addEventListener("submit", (e) => {
  e.preventDefault();
  run();
});
cancelBtn.addEventListener("click", () => {
  if (currentController) currentController.abort();
});
sortEl.addEventListener("change", () => renderList());

function setBusy(busy) {
  checkBtn.disabled = busy;
  usernameInput.disabled = busy;
  variantsInput.disabled = busy;
  cancelBtn.hidden = !busy;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

function clearUI() {
  errorEl.hidden = true;
  errorEl.textContent = "";
  resultsEl.hidden = true;
  listEl.innerHTML = "";
  countEl.textContent = "0";
  metaEl.textContent = "";
  progressEl.hidden = true;
  barFill.style.width = "0%";
  progressText.textContent = "";
}

function setProgressPct(pct, label) {
  progressEl.hidden = false;
  barFill.style.width = Math.max(0, Math.min(100, pct)) + "%";
  if (label != null) progressText.textContent = label;
}

async function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }
  });
}

async function fetchJSON(url, signal, attempt = 0) {
  let res;
  try {
    res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    if (attempt < MAX_RETRIES) {
      await sleep(500 * 2 ** attempt, signal);
      return fetchJSON(url, signal, attempt + 1);
    }
    throw new Error(`Network error fetching ${url}: ${err.message}`);
  }

  if (res.status === 404) {
    const err = new Error("Not found");
    err.status = 404;
    throw err;
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Server returned ${res.status} after ${MAX_RETRIES} retries`);
    }
    const retryAfter = parseFloat(res.headers.get("Retry-After") || "0");
    const wait = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt + Math.random() * 250;
    await sleep(wait, signal);
    return fetchJSON(url, signal, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }

  return res.json();
}

async function loadGMSet(signal) {
  const cached = sessionStorage.getItem(GM_CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.fetchedAt < GM_CACHE_TTL_MS && Array.isArray(parsed.players)) {
        return new Set(parsed.players);
      }
    } catch { /* fall through */ }
  }
  const data = await fetchJSON(`${API}/titled/GM`, signal);
  const players = (data.players || []).map((p) => p.toLowerCase());
  try {
    sessionStorage.setItem(GM_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), players }));
  } catch { /* quota — ignore */ }
  return new Set(players);
}

function countMoves(pgn) {
  if (!pgn) return 0;
  const bodyStart = pgn.indexOf("\n\n");
  const body = bodyStart >= 0 ? pgn.slice(bodyStart + 2) : pgn;
  let max = 0;
  const re = /(?:^|\s)(\d+)\.(?!\.)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

function currentYearMonth() {
  const d = new Date();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function archiveYearMonth(url) {
  const m = url.match(/\/(\d{4})\/(\d{2})$/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
}

function isCurrentMonth(url) {
  const ym = archiveYearMonth(url);
  if (!ym) return false;
  const cur = currentYearMonth();
  return ym.year === cur.year && ym.month === cur.month;
}

async function loadArchive(url, signal) {
  const key = ARCHIVE_PREFIX + url;
  if (!isCurrentMonth(url)) {
    const cached = sessionStorage.getItem(key);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch { /* fall through */ }
    }
  }
  const data = await fetchJSON(url, signal);
  const games = (data.games || []).map((g) => ({
    url: g.url,
    end_time: g.end_time,
    rules: g.rules,
    time_class: g.time_class,
    whiteName: g.white?.username?.toLowerCase() ?? "",
    whiteResult: g.white?.result ?? "",
    whiteRating: g.white?.rating ?? null,
    blackName: g.black?.username?.toLowerCase() ?? "",
    blackResult: g.black?.result ?? "",
    blackRating: g.black?.rating ?? null,
    moveCount: countMoves(g.pgn),
  }));
  if (!isCurrentMonth(url)) {
    try {
      sessionStorage.setItem(key, JSON.stringify({ games }));
    } catch { /* quota — ignore */ }
  }
  return { games };
}

async function processWithConcurrency(items, worker, concurrency, signal, onProgress) {
  let next = 0;
  const results = new Array(items.length);
  const total = items.length;

  async function pull() {
    while (true) {
      if (signal.aborted) return;
      const i = next++;
      if (i >= total) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        if (err.name === "AbortError") return;
        results[i] = { error: err };
      }
      onProgress?.();
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, total) }, () => pull());
  await Promise.all(runners);
  return results;
}

async function loadProfile(username, signal) {
  const key = PROFILE_PREFIX + username;
  const cached = sessionStorage.getItem(key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.fetchedAt < PROFILE_TTL_MS) return parsed.data;
    } catch { /* fall through */ }
  }
  const [profile, stats] = await Promise.all([
    fetchJSON(`${API}/player/${encodeURIComponent(username)}`, signal),
    fetchJSON(`${API}/player/${encodeURIComponent(username)}/stats`, signal),
  ]);
  const countryCode = profile.country?.match(/\/([A-Z]{2})$/)?.[1] ?? null;
  const data = {
    avatar: profile.avatar || null,
    name: profile.name || null,
    title: profile.title || null,
    countryCode,
    blitz: stats.chess_blitz?.last?.rating ?? null,
    bullet: stats.chess_bullet?.last?.rating ?? null,
    rapid: stats.chess_rapid?.last?.rating ?? null,
    daily: stats.chess_daily?.last?.rating ?? null,
    fide: stats.fide ?? null,
    url: profile.url || `https://www.chess.com/member/${encodeURIComponent(username)}`,
  };
  try {
    sessionStorage.setItem(key, JSON.stringify({ fetchedAt: Date.now(), data }));
  } catch { /* quota — ignore */ }
  return data;
}

function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return "";
  const base = 127397;
  return cc
    .toUpperCase()
    .split("")
    .map((c) => String.fromCodePoint(c.charCodeAt(0) + base))
    .join("");
}

async function run() {
  const raw = usernameInput.value.trim().toLowerCase();
  if (!raw) return;
  usernameInput.value = raw;

  clearUI();
  setBusy(true);

  const controller = new AbortController();
  currentController = controller;
  const { signal } = controller;

  const includeVariants = variantsInput.checked;

  try {
    progressText.textContent = "Fetching GM list…";
    progressEl.hidden = false;
    const gmSet = await loadGMSet(signal);

    progressText.textContent = "Fetching archive list…";
    let archivesData;
    try {
      archivesData = await fetchJSON(`${API}/player/${encodeURIComponent(raw)}/games/archives`, signal);
    } catch (err) {
      if (err.status === 404) {
        throw new Error(`User "${raw}" not found on Chess.com.`);
      }
      throw err;
    }
    const archives = archivesData.archives || [];
    if (archives.length === 0) {
      showResults(raw, [], gmSet.size);
      return;
    }

    const totalArchives = archives.length;
    let archivesDone = 0;
    let totalProfiles = 0;
    let profilesDone = 0;

    function tick(phase) {
      if (phase === "archive") {
        const frac = totalArchives > 0 ? archivesDone / totalArchives : 0;
        setProgressPct(frac * 50, `Scanning archive ${archivesDone} of ${totalArchives}…`);
      } else {
        const frac = totalProfiles > 0 ? profilesDone / totalProfiles : 1;
        setProgressPct(50 + frac * 50, `Loading GM profile ${profilesDone} of ${totalProfiles}…`);
      }
    }

    tick("archive");

    const firstWinByOpponent = new Map();

    const archiveResults = await processWithConcurrency(
      archives,
      async (url) => loadArchive(url, signal),
      CONCURRENCY,
      signal,
      () => { archivesDone++; tick("archive"); }
    );

    if (signal.aborted) return;

    for (const result of archiveResults) {
      if (!result || result.error) continue;
      for (const g of result.games) {
        if (!includeVariants && g.rules !== "chess") continue;
        let playerSide, opponent;
        if (g.whiteName === raw) {
          playerSide = g.whiteResult;
          opponent = g.blackName;
        } else if (g.blackName === raw) {
          playerSide = g.blackResult;
          opponent = g.whiteName;
        } else {
          continue;
        }
        if (playerSide !== "win") continue;
        if (!gmSet.has(opponent)) continue;

        const opponentRating =
          g.whiteName === opponent ? g.whiteRating : g.blackRating;

        const existing = firstWinByOpponent.get(opponent);
        if (!existing || g.end_time < existing.end_time) {
          firstWinByOpponent.set(opponent, {
            end_time: g.end_time,
            url: g.url,
            opponentRating,
            moveCount: g.moveCount,
          });
        }
      }
    }

    const wins = Array.from(firstWinByOpponent.entries()).map(([name, info]) => ({
      name,
      end_time: info.end_time,
      url: info.url,
      rating: info.opponentRating,
      moves: info.moveCount,
      profile: null,
    }));

    totalProfiles = wins.length;
    tick("profile");

    if (wins.length > 0) {
      await processWithConcurrency(
        wins,
        async (w) => {
          try {
            w.profile = await loadProfile(w.name, signal);
          } catch { /* leave profile null, still render card */ }
        },
        CONCURRENCY,
        signal,
        () => { profilesDone++; tick("profile"); }
      );
    }

    if (signal.aborted) return;

    showResults(raw, wins, gmSet.size);
  } catch (err) {
    if (err.name === "AbortError") {
      progressText.textContent = "Cancelled.";
    } else {
      showError(err.message || String(err));
    }
  } finally {
    setBusy(false);
    currentController = null;
  }
}

function formatDate(ts) {
  if (!ts) return "unknown date";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function showResults(username, wins, gmTotal) {
  progressEl.hidden = true;
  resultsEl.hidden = false;
  countEl.textContent = String(wins.length);
  metaEl.textContent =
    `${username} · first-win data shown per opponent · ${gmTotal.toLocaleString()} GMs on the title list`;
  lastWins = wins;
  renderList();
}

function strengthOf(w) {
  return w.profile?.blitz ?? w.profile?.rapid ?? w.profile?.bullet ?? w.rating ?? -1;
}

function sortedWins() {
  const mode = sortEl.value;
  const copy = lastWins.slice();
  if (mode === "rating") {
    copy.sort((a, b) => strengthOf(b) - strengthOf(a));
  } else if (mode === "moves") {
    copy.sort((a, b) => (b.moves ?? -1) - (a.moves ?? -1));
  } else {
    copy.sort((a, b) => b.end_time - a.end_time);
  }
  return copy;
}

function buildRow(w) {
  const li = document.createElement("li");
  li.className = "gm-card";

  const avatar = document.createElement("img");
  avatar.className = "gm-avatar";
  avatar.alt = "";
  avatar.loading = "lazy";
  avatar.src = w.profile?.avatar || DEFAULT_AVATAR;
  avatar.addEventListener("error", () => { avatar.src = DEFAULT_AVATAR; }, { once: true });
  li.appendChild(avatar);

  const body = document.createElement("div");
  body.className = "gm-body";

  const top = document.createElement("div");
  top.className = "gm-top";
  const nameLink = document.createElement("a");
  nameLink.className = "gm-name";
  nameLink.href = w.profile?.url || `https://www.chess.com/member/${encodeURIComponent(w.name)}`;
  nameLink.target = "_blank";
  nameLink.rel = "noopener";
  nameLink.textContent = w.name;
  top.appendChild(nameLink);
  if (w.profile?.countryCode) {
    const flag = document.createElement("span");
    flag.className = "gm-flag";
    flag.textContent = flagEmoji(w.profile.countryCode);
    flag.title = w.profile.countryCode;
    top.appendChild(flag);
  }
  if (w.profile?.title) {
    const t = document.createElement("span");
    t.className = "gm-title";
    t.textContent = w.profile.title;
    top.appendChild(t);
  }
  if (w.profile?.name) {
    const realName = document.createElement("span");
    realName.className = "gm-realname";
    realName.textContent = w.profile.name;
    top.appendChild(realName);
  }
  body.appendChild(top);

  const ratings = document.createElement("div");
  ratings.className = "gm-ratings";
  if (w.profile) {
    const chips = [
      ["Blitz", w.profile.blitz],
      ["Bullet", w.profile.bullet],
      ["Rapid", w.profile.rapid],
      ["Daily", w.profile.daily],
    ];
    for (const [label, val] of chips) {
      if (val == null) continue;
      const chip = document.createElement("span");
      chip.className = "rating-chip";
      chip.textContent = `${label} ${val}`;
      ratings.appendChild(chip);
    }
    if (w.profile.fide) {
      const chip = document.createElement("span");
      chip.className = "rating-chip fide";
      chip.textContent = `FIDE ${w.profile.fide}`;
      ratings.appendChild(chip);
    }
  }
  if (ratings.childElementCount > 0) body.appendChild(ratings);

  const meta = document.createElement("div");
  meta.className = "gm-meta";
  const parts = [`First win: ${formatDate(w.end_time)}`];
  if (w.moves) parts.push(`${w.moves} moves`);
  if (w.rating != null) parts.push(`opp. rated ${w.rating} at game`);
  const gameLink = document.createElement("a");
  gameLink.href = w.url;
  gameLink.target = "_blank";
  gameLink.rel = "noopener";
  gameLink.textContent = "view game";
  meta.append(parts.join(" · ") + " · ", gameLink);
  body.appendChild(meta);

  li.appendChild(body);
  return li;
}

function renderList() {
  listEl.innerHTML = "";
  liByName.clear();
  for (const w of sortedWins()) {
    const li = buildRow(w);
    listEl.appendChild(li);
    liByName.set(w.name, li);
  }
}

