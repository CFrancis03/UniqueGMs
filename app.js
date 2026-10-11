const API = "https://api.chess.com/pub";
const CONCURRENCY = 4;
const MAX_RETRIES = 5;
const GM_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const GM_CACHE_KEY = "gm-list-v1";
const ARCHIVE_PREFIX = "archive-v1:";

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

let currentController = null;

form.addEventListener("submit", (e) => {
  e.preventDefault();
  run();
});
cancelBtn.addEventListener("click", () => {
  if (currentController) currentController.abort();
});

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

function setProgress(current, total, label) {
  progressEl.hidden = false;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  barFill.style.width = pct + "%";
  progressText.textContent = label ?? `Scanning archive ${current} of ${total}…`;
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
    blackName: g.black?.username?.toLowerCase() ?? "",
    blackResult: g.black?.result ?? "",
  }));
  if (!isCurrentMonth(url)) {
    try {
      sessionStorage.setItem(key, JSON.stringify({ games }));
    } catch { /* quota — ignore */ }
  }
  return { games };
}

async function processWithConcurrency(items, worker, concurrency, signal) {
  let next = 0;
  let done = 0;
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
      done++;
      setProgress(done, total, `Scanning archive ${done} of ${total}…`);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, total) }, () => pull());
  await Promise.all(runners);
  return results;
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

    setProgress(0, archives.length);

    const firstWinByOpponent = new Map();

    const archiveResults = await processWithConcurrency(
      archives,
      async (url) => loadArchive(url, signal),
      CONCURRENCY,
      signal
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

        const existing = firstWinByOpponent.get(opponent);
        if (!existing || g.end_time < existing.end_time) {
          firstWinByOpponent.set(opponent, { end_time: g.end_time, url: g.url });
        }
      }
    }

    const wins = Array.from(firstWinByOpponent.entries()).map(([name, info]) => ({
      name,
      end_time: info.end_time,
      url: info.url,
    }));
    wins.sort((a, b) => b.end_time - a.end_time);

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
    `${username} · first-win date shown per opponent · ${gmTotal.toLocaleString()} GMs on the title list`;
  listEl.innerHTML = "";
  for (const w of wins) {
    const li = document.createElement("li");
    const left = document.createElement("div");
    left.className = "gm-name";
    const a = document.createElement("a");
    a.href = `https://www.chess.com/member/${encodeURIComponent(w.name)}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = w.name;
    left.appendChild(a);

    const right = document.createElement("div");
    right.className = "gm-meta";
    const gameLink = document.createElement("a");
    gameLink.href = w.url;
    gameLink.target = "_blank";
    gameLink.rel = "noopener";
    gameLink.textContent = "view game";
    right.append(`First win: ${formatDate(w.end_time)} · `, gameLink);

    li.append(left, right);
    listEl.appendChild(li);
  }
}
