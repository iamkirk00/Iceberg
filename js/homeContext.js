// homeContext.js — the bridge to Family Commons.
//
// These sites run in two places:
//   1. GitHub Pages — standalone. No family data; everything below no-ops.
//   2. Inside Family Commons at /ocean and /iceberg — SAME ORIGIN as the app,
//      so the family's existing login (localStorage `fc_token`) is already
//      here. That lets the characters read today's real board and answer
//      "what's for dinner?" correctly, and lets them think with the family
//      server's AI key so no device needs one pasted in.
//
// Everything degrades: no server → no home context → the site behaves exactly
// as it does on Pages.

const TOKEN_KEY = 'fc_token';

export function createHomeContext({ freshnessMs = 60000 } = {}) {
  let serverPresent = false;   // we are being served by Family Commons
  let serverAi = false;        // an AI brain is reachable one way or another
  let aiConfig = null;         // /api/ai/config — how this family reaches its AI
  let today = null;            // last fetched brief { date, weekday, text, facts }
  let fetchedAt = 0;
  let lastError = null;

  const token = () => {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  };
  const signedIn = () => Boolean(token());

  async function api(path, options = {}) {
    const t = token();
    const res = await fetch(path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(t ? { authorization: `Bearer ${t}` } : {}),
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function init() {
    try {
      const meta = await api('/api/meta');
      serverPresent = true;
      serverAi = Boolean(meta.aiEnabled);
    } catch {
      serverPresent = false;      // standalone (GitHub Pages) — nothing to do
      return status();
    }
    if (signedIn()) {
      // How this family reaches its AI. "server": the house server calls the
      // provider. "browser": the server's network blocks AI APIs, so it hands
      // the family key to signed-in devices and each device calls out itself.
      // Either way nobody pastes a key into this page.
      aiConfig = await api('/api/ai/config').catch(() => null);
      serverAi = Boolean(aiRoute());
      await refresh(true).catch(() => {});
    }
    return status();
  }

  /** Today's board, cached briefly so a busy conversation isn't a request storm. */
  async function refresh(force = false) {
    if (!serverPresent || !signedIn()) return null;
    if (!force && today && Date.now() - fetchedAt < freshnessMs) return today;
    try {
      today = await api('/api/menagerie/today');
      fetchedAt = Date.now();
      lastError = null;
    } catch (e) {
      lastError = e;
      if (e.status === 401) today = null;   // session expired — stay quiet
    }
    return today;
  }

  /** 'server' | 'browser' | null — where a character's thinking can happen. */
  function aiRoute() {
    if (!aiConfig || !aiConfig.provider) return null;
    if (aiConfig.mode === 'browser') return aiConfig.key ? 'browser' : null;
    return 'server';
  }

  /**
   * Browser-direct call using the family's own key (browser mode only). Same
   * road the Family Commons app itself takes when the house server can't reach
   * the provider.
   */
  async function browserChat(system, messages, maxTokens = 320) {
    const c = aiConfig;
    if (c.provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${c.model}:generateContent?key=${c.key}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          systemInstruction: { parts: [{ text: system }] },
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      });
      if (!res.ok) throw new Error(`AI ${res.status}`);
      const data = await res.json();
      return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    }
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key}` },
      body: JSON.stringify({
        model: c.model,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    });
    if (!res.ok) throw new Error(`AI ${res.status}`);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  }

  /** The block spliced into a character's system prompt. */
  function todayPrompt() {
    return today?.text || '';
  }

  /**
   * Ask the family server to think for a character (its own AI key, today's
   * board already folded in). Returns the raw reply, emote tag and all.
   */
  async function serverChat({ character, persona, other, mode, messages }) {
    const data = await api('/api/menagerie/chat', {
      method: 'POST',
      body: JSON.stringify({ character, persona, other, mode, messages }),
    });
    return data.text || '';
  }

  /**
   * Keyword answers straight from today's facts — so even with no AI at all,
   * a kid asking a penguin "what's for dinner?" gets the real answer.
   * Returns null when the question isn't one we can answer from the board.
   */
  function factAnswer(question) {
    if (!today?.facts) return null;
    const q = (question || '').toLowerCase();
    const f = today.facts;
    const list = (arr) => arr.join(', ');

    if (/dinner|supper|eat|meal|food|cooking|menu/.test(q)) {
      if (!f.meals?.length) return "nothing's on the meal plan for today yet";
      return `today's meals are ${list(f.meals)}`;
    }
    if (/intention|choose|chosen/.test(q)) {
      if (!f.intentions?.length) return 'there are no intentions on the board today';
      return `today's intentions: ${list(f.intentions)}`;
    }
    if (/vote|decide|decision/.test(q)) {
      if (!f.decisions?.length) return 'nothing is waiting on a family vote right now';
      return `waiting on a vote: ${list(f.decisions)}`;
    }
    if (/birthday/.test(q)) {
      return f.birthdays?.length ? `birthday today: ${list(f.birthdays)}` : 'no birthdays today';
    }
    if (/today|happening|schedule|plan|going on|on the board|calendar/.test(q)) {
      const bits = [];
      if (f.events?.length) bits.push(`on the schedule: ${list(f.events)}`);
      if (f.meals?.length) bits.push(`meals: ${list(f.meals)}`);
      if (f.decisions?.length) bits.push(`a vote is open on ${list(f.decisions)}`);
      if (!bits.length) return `${f.weekday} is wide open — nothing on the board`;
      return bits.join('; ');
    }
    return null;
  }

  function status() {
    return {
      serverPresent,
      serverAi,
      aiRoute: aiRoute(),
      signedIn: signedIn(),
      hasToday: Boolean(today),
      date: today?.date || null,
      weekday: today?.weekday || null,
      householdName: today?.household || null,
      error: lastError?.message || null,
    };
  }

  return { init, refresh, todayPrompt, serverChat, browserChat, aiRoute, factAnswer, status, get today() { return today; } };
}
