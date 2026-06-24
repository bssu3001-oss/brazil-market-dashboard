/* ──────────────────────────────────────────────────────────────
   실시간.js — 브라질 증시 대시보드
   페이지 열 때마다 차트 과거추이·기술지표·뉴스신호를 실시간 갱신.
   원칙: 어떤 호출이 실패해도 화면이 깨지거나 빈칸이 되지 않고
        직전 값/정적값을 그대로 유지한다.
   ────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── 여러 CORS 프록시를 순서대로 시도 (하나 막혀도 다음으로) ──
  const PROXIES = [
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  ];

  async function proxyText(url, timeoutMs) {
    for (const make of PROXIES) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs || 5000);
        const r = await fetch(make(url), { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) continue;
        const txt = await r.text();
        if (txt && txt.length > 0) return txt;
      } catch (e) { /* 다음 프록시 시도 */ }
    }
    return null;
  }

  async function proxyJSON(url, timeoutMs) {
    const txt = await proxyText(url, timeoutMs);
    if (!txt) return null;
    try { return JSON.parse(txt); } catch (e) { return null; }
  }

  // 영문 → 한국어 번역 (구글 번역)
  async function translateKo(text) {
    if (!text) return text;
    try {
      const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ko&dt=t&q=' + encodeURIComponent(text));
      if (!r.ok) return text;
      const j = await r.json();
      const out = (j[0] || []).map((x) => x[0]).join('');
      return out || text;
    } catch (e) { return text; }
  }

  const MARKET_DESC = '브라질 증시(IBOVESPA·EWZ)';
  const MAIN_TICKER_URL = '%5EBVSP';
  const MAIN_TICKER_NAME = 'IBOVESPA';

  // ── 기술적 지표 계산 ──
  function setBadge(id, text, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'badge ' + cls;
  }

  function calcRSI(prices, n) {
    if (prices.length < n + 1) return null;
    let gain = 0, loss = 0;
    for (let i = prices.length - n; i < prices.length; i++) {
      const diff = prices[i] - prices[i - 1];
      if (diff >= 0) gain += diff; else loss -= diff;
    }
    if (loss === 0) return 100;
    const rs = (gain / n) / (loss / n);
    return 100 - 100 / (1 + rs);
  }

  function sma(prices, n) {
    if (prices.length < n) return null;
    const s = prices.slice(prices.length - n);
    return s.reduce((a, b) => a + b, 0) / n;
  }

  function updateTechnicals(meta, weeklyPrices) {
    if (!weeklyPrices || weeklyPrices.length < 6) return;
    const cur = weeklyPrices[weeklyPrices.length - 1];

    // RSI (14주)
    const rsi = calcRSI(weeklyPrices, 14);
    if (rsi != null) {
      let lbl, cls;
      if (rsi >= 75)      { lbl = '과열 — 매도 주의';  cls = 'badge-r'; }
      else if (rsi >= 55) { lbl = '중립 상단';          cls = 'badge-b'; }
      else if (rsi >= 45) { lbl = '중립';               cls = 'badge-b'; }
      else if (rsi >= 30) { lbl = '약세';               cls = 'badge-y'; }
      else                { lbl = '과매도 — 반등 기대'; cls = 'badge-g'; }
      setBadge('badge-rsi', `RSI ${rsi.toFixed(1)} — ${lbl}`, cls);
    }

    // 이평선 배열 (MA5 / MA13 / MA26 주봉)
    const ma5 = sma(weeklyPrices, 5), ma13 = sma(weeklyPrices, 13), ma26 = sma(weeklyPrices, 26);
    if (ma5 != null && ma13 != null && ma26 != null) {
      let lbl, cls;
      if (cur > ma5 && ma5 > ma13 && ma13 > ma26)      { lbl = '정배열(상승)'; cls = 'badge-g'; }
      else if (cur < ma5 && ma5 < ma13 && ma13 < ma26) { lbl = '역배열(하락)'; cls = 'badge-r'; }
      else if (cur > ma5 && cur > ma13)                 { lbl = '단기 상승';    cls = 'badge-y'; }
      else if (cur < ma5 && cur < ma13)                 { lbl = '단기 하락';    cls = 'badge-y'; }
      else                                               { lbl = '혼조';        cls = 'badge-y'; }
      setBadge('badge-ma', lbl, cls);
    }

    // 단기 모멘텀 (4주 변화)
    if (weeklyPrices.length >= 5) {
      const past = weeklyPrices[weeklyPrices.length - 5];
      const mom = (cur - past) / past * 100;
      const arrow = mom >= 0 ? '▲' : '▼';
      let cls;
      if (mom >= 2) cls = 'badge-g'; else if (mom <= -2) cls = 'badge-r'; else cls = 'badge-y';
      setBadge('badge-mom', `${arrow} ${Math.abs(mom).toFixed(1)}% (4주)`, cls);
    }

    // 52주 가격 위치
    let hi = meta && meta.fiftyTwoWeekHigh, lo = meta && meta.fiftyTwoWeekLow;
    if (!hi || !lo) { hi = Math.max(...weeklyPrices); lo = Math.min(...weeklyPrices); }
    if (hi && lo && hi > lo) {
      const fromHi = (cur - hi) / hi * 100;
      const fromLo = (cur - lo) / lo * 100;
      const pos = (cur - lo) / (hi - lo);
      let cls;
      if (pos < 0.5) cls = 'badge-g'; else if (pos > 0.85) cls = 'badge-y'; else cls = 'badge-b';
      setBadge('badge-pos', `고점 대비 ${fromHi.toFixed(1)}% / 저점 대비 +${fromLo.toFixed(1)}%`, cls);
    }
  }

  // ── AI 차트 분석 카드 ──
  function buildAnalysis(name, weekly, d5, meta) {
    const el = document.getElementById('ai-chart-analysis');
    if (!el || !weekly || weekly.length < 14) return;
    const cur = weekly[weekly.length - 1];
    let pct = null;
    if (d5 && d5.length >= 2) pct = (d5[d5.length - 1] - d5[d5.length - 2]) / d5[d5.length - 2] * 100;
    const rsi = calcRSI(weekly, 14);
    const ma5 = sma(weekly, 5), ma13 = sma(weekly, 13), ma26 = sma(weekly, 26);
    let maState = '혼조';
    if (cur > ma5 && ma5 > ma13 && ma13 > ma26)      maState = '정배열(상승)';
    else if (cur < ma5 && ma5 < ma13 && ma13 < ma26) maState = '역배열(하락)';
    const mom = (cur - weekly[weekly.length - 5]) / weekly[weekly.length - 5] * 100;
    const rets = [];
    for (let i = Math.max(1, weekly.length - 12); i < weekly.length; i++)
      rets.push((weekly[i] - weekly[i - 1]) / weekly[i - 1] * 100);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
    let hi = meta && meta.fiftyTwoWeekHigh, lo = meta && meta.fiftyTwoWeekLow;
    if (!hi || !lo) { hi = Math.max(...weekly); lo = Math.min(...weekly); }
    const fromHi = (cur - hi) / hi * 100, fromLo = (cur - lo) / lo * 100;
    const posRatio = (cur - lo) / (hi - lo);
    const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
    const rsiLvl = rsi >= 70 ? '과열권' : rsi >= 55 ? '중립대 상단' : rsi >= 45 ? '중립' : rsi >= 30 ? '약세' : '과매도권';
    const momLvl = mom >= 2 ? '견조한 상승 동력' : mom >= 0 ? '약한 상승 힘' : mom > -2 ? '약한 하락 압력' : '뚜렷한 하락 압력';
    const volLvl = std < 1 ? '낮은' : std < 2 ? '보통' : '높은';
    const posLvl = posRatio < 0.4 ? '저점 부근' : posRatio > 0.8 ? '고점 부근' : '중간값 근처';
    let concl;
    if (maState.indexOf('정배열') >= 0 && mom > 0) concl = '추세·모멘텀이 우호적이라 분할 매수를 고려할 만합니다.';
    else if (maState.indexOf('역배열') >= 0) concl = '추세가 약해 신규 진입보다 반등 확인 후 대응이 바람직합니다.';
    else concl = '방향성이 불명확해 의미 있는 신호 전까지 관망이 최선입니다.';
    const fmtN = (n) => Math.round(n).toLocaleString('ko-KR');
    const issueLine = (window.__majorNewsItems && window.__majorNewsItems.length)
      ? `• <strong>주요 이슈</strong>: ${window.__majorNewsItems.slice(0, 2).map((n) => n.ko || n.title).join(' / ')}<br><br>` : '';
    el.innerHTML =
      `<strong>${name} 주간 차트 분석 (${today})</strong><br><br>` +
      issueLine +
      `• <strong>현재 지수</strong>: ${fmtN(cur)}${pct != null ? ` — 전일 대비 ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : ''}<br><br>` +
      `• <strong>추세 (이평)</strong>: 5주·13주·26주 이평 기준 <strong>${maState}</strong>${maState === '혼조' ? ' — 방향성 불명확' : ''}<br><br>` +
      `• <strong>모멘텀</strong>: RSI ${rsi != null ? rsi.toFixed(1) : 'N/A'} (${rsiLvl}), 4주 모멘텀 ${mom >= 0 ? '+' : ''}${mom.toFixed(1)}% — ${momLvl}<br><br>` +
      `• <strong>변동성</strong>: 주간 ±${std.toFixed(2)}%로 ${volLvl} 수준<br><br>` +
      `• <strong>위치</strong>: 52주 고점(${fmtN(hi)}) 대비 ${fromHi.toFixed(1)}%, 저점(${fmtN(lo)}) 대비 +${fromLo.toFixed(1)}% — ${posLvl}<br><br>` +
      `• <strong>한 줄 결론</strong>: ${concl}<br><br>` +
      `<span style="color:var(--text3);font-size:11px;">* 열 때마다 실시간 지표로 자동 작성됩니다</span>`;
  }

  // ── 주요 뉴스 (제목+링크, 열 때마다 실시간) ──
  const NEWS_FEEDS = [
    { url: 'https://news.google.com/rss/search?q=브라질+증시&hl=ko&gl=KR&ceid=KR:ko',          source: '구글뉴스', isKo: true },
    { url: 'https://news.google.com/rss/search?q=브라질+경제+헤알화&hl=ko&gl=KR&ceid=KR:ko',  source: '구글뉴스', isKo: true },
    { url: 'https://news.google.com/rss/search?q=브라질+금리+Selic+BCB&hl=ko&gl=KR&ceid=KR:ko', source: '구글뉴스', isKo: true },
  ];

  function relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() / 1000 - ts;
    if (diff < 3600) return Math.max(1, Math.round(diff / 60)) + '분 전';
    if (diff < 86400) return Math.round(diff / 3600) + '시간 전';
    return Math.round(diff / 86400) + '일 전';
  }

  async function fetchNewsItems() {
    const sets = await Promise.all(NEWS_FEEDS.map(async (f) => {
      try {
        const parseXml = (xml) => {
          const doc = new DOMParser().parseFromString(xml, 'text/xml');
          return [...doc.querySelectorAll('item')].slice(0, 12).map((item) => {
            const g = (tag) => item.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
            const title = g('title'); const link = g('link') || g('guid'); const pubDate = g('pubDate');
            return { title, link, source: f.source, isKo: !!f.isKo, ts: pubDate ? (new Date(pubDate).getTime() || 0) / 1000 : 0 };
          }).filter((x) => x.title && x.link.startsWith('http'));
        };
        const parseRss = (d) => (d.items || []).slice(0, 12).map((it) => ({
          title: (it.title || '').trim(), link: (it.link || it.guid || '').trim(),
          source: f.source, isKo: !!f.isKo, ts: it.pubDate ? (new Date(it.pubDate).getTime() || 0) / 1000 : 0,
        })).filter((x) => x.title && x.link.startsWith('http'));
        const items = await new Promise((resolve) => {
          let done = false; let pending = 2;
          const tryResolve = (r) => { if (!done && r.length) { done = true; resolve(r); } if (--pending === 0 && !done) resolve([]); };
          proxyText(f.url, 10000).then(xml => tryResolve(xml ? parseXml(xml) : [])).catch(() => tryResolve([]));
          fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(f.url)}`, { signal: AbortSignal.timeout(10000) })
            .then(r => r.ok ? r.json() : null).then(d => tryResolve(d ? parseRss(d) : [])).catch(() => tryResolve([]));
        });
        return items;
      } catch (e) { return []; }
    }));
    const EXCLUDE = ['한국 증시', '코스피', '코스닥', '삼성전자', '한국 주식'];
    const all = [], seen = new Set();
    sets.forEach((s) => s.forEach((n) => {
      const t = n.title;
      if (EXCLUDE.some((kw) => t.includes(kw))) return;
      const k = t.toLowerCase().slice(0, 60);
      if (seen.has(k)) return;
      seen.add(k); all.push(n);
    }));
    all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return all.slice(0, 8);
  }

  function ensureNewsCard() {
    if (document.getElementById('major-news')) return;
    const anchor = document.querySelector('.section-label') || document.querySelector('.main-header');
    if (!anchor || !anchor.parentNode) return;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<div class="card-title">📰 주요 뉴스 <span style="font-size:11px;font-weight:400;color:var(--text3);">— 실시간 · 브라질 시장</span></div><div id="major-news"><div style="font-size:12px;color:var(--text3);">뉴스 불러오는 중…</div></div>';
    anchor.parentNode.insertBefore(card, anchor);
  }

  async function renderMajorNews() {
    ensureNewsCard();
    const box = document.getElementById('major-news');
    if (!box) return;
    const items = await fetchNewsItems();
    if (!items.length) { box.innerHTML = '<div style="font-size:12px;color:var(--text3);">뉴스를 불러오지 못했어요 (잠시 후 새로고침)</div>'; return; }
    const kos = await Promise.all(items.map((n) => n.isKo ? n.title : translateKo(n.title)));
    items.forEach((n, i) => { n.ko = (kos[i] || n.title).trim(); });
    window.__majorNewsItems = items;
    window.__majorNews = items.slice(0, 6).map((n) => '• ' + n.ko).join('\n');
    box.innerHTML = items.map((n) => {
      const ko = (n.ko || n.title).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const meta = [n.source, relTime(n.ts)].filter(Boolean).join(' · ');
      const ageDay = n.ts ? (Date.now()/1000 - n.ts) / 86400 : 0;
      const dimStyle = ageDay > 7 ? 'opacity:0.4;' : '';
      return `<a href="${n.link}" target="_blank" rel="noopener" style="display:block;padding:9px 0;border-bottom:0.5px solid var(--border);text-decoration:none;color:var(--text);${dimStyle}"><div style="font-size:13px;line-height:1.45;">${ko}</div><div style="font-size:11px;color:var(--text3);margin-top:3px;">${meta} ↗</div></a>`;
    }).join('');
  }

  // ── 한국어 뉴스 키워드로 뉴스 배지 자동 분류 (키 없으면 키워드 / 있으면 AI 위임) ──
  async function updateNewsBadgesFromKorean() {
    const items = (window.__majorNewsItems || []).length
      ? (window.__majorNewsItems || [])
      : (window.__newsForAnalysis || []).map(t => ({ ko: t, title: t }));
    if (!items.length) return;
    const all = items.map(n => (n.ko || n.title || '')).join(' ');

    function cleanTitle2(t) { return (t||'').replace(/\[.*?\]\s*/,'').replace(/\s*[-–]\s*\S+$/, '').trim(); }
    function trimTitle2(t) { return t.length > 30 ? t.slice(0, 30) + '…' : t; }

    function findRelatedHeadline(searchKws) {
      for (const kw of searchKws) {
        const found = items.find(n => (n.ko || n.title || '').toLowerCase().includes(kw.toLowerCase()));
        if (found) {
          const title = cleanTitle2(found.ko || found.title || '');
          return title.length > 30 ? title.slice(0, 30) + '…' : title;
        }
      }
      return null;
    }

    const relKw = {
      'badge-bcb':      ['금리','bcb','selic','셀릭','통화','기준금리','긴축','완화','피벗','매파'],
      'badge-ipca':     ['ipca','물가','인플레','cpi','소비자물가','인플레이션'],
      'badge-gdp':      ['gdp','성장률','경제성장','경기','성장'],
      'badge-fed':      ['연준','fed','파월','fomc','달러','금리'],
      'badge-trade':    ['무역','수출','수입','재정','흑자','적자','관세'],
      'badge-political':['룰라','정치','의회','탄핵','개혁','예산','정책'],
    };

    function ko(id, gKw, rKw, gT, rT, nT, dT) {
      const isG = gKw.some(k => all.toLowerCase().includes(k.toLowerCase()));
      const isR = rKw.some(k => all.toLowerCase().includes(k.toLowerCase()));
      let cls, text;
      if      (isG && !isR) { cls = 'badge-g'; text = gT; }
      else if (isR && !isG) { cls = 'badge-r'; text = rT; }
      else if (isG && isR)  { cls = 'badge-y'; text = nT; }
      else if (dT) { cls = 'badge-y'; text = dT; }
      else { return; }
      const el = document.getElementById(id);
      if (el && el.dataset.src !== 'ai') { el.textContent = text; el.className = 'badge ' + cls; }
    }

    ko('badge-bcb',
      ['금리 인하','셀릭 인하','bcb 완화','selic 인하','통화 완화','피벗','bcb 동결'],
      ['금리 인상','셀릭 인상','bcb 긴축','selic 인상','긴축','매파'],
      'BCB 완화(호재)', 'BCB 긴축(악재)', 'BCB 혼조', 'BCB 정책 관망');

    ko('badge-ipca',
      ['ipca 하락','물가 안정','인플레 완화','물가 둔화','물가 하락','디스인플레'],
      ['ipca 상승','물가 급등','인플레 우려','물가 상승','인플레 심화'],
      'IPCA 안정(호재)', 'IPCA 상승(악재)', 'IPCA 혼조', '물가 혼조');

    ko('badge-gdp',
      ['gdp 성장','경제성장','성장률 상승','경기 호조','성장 가속','경기 반등'],
      ['gdp 둔화','성장 둔화','경기 침체','성장률 하락','경기 부진'],
      'GDP 성장(호재)', 'GDP 둔화(악재)', 'GDP 혼조', 'GDP 혼조');

    ko('badge-fed',
      ['연준 인하','금리 인하','파월 완화','연준 완화','연준 피벗','dovish'],
      ['연준 인상','연준 긴축','파월 매파','hawkish','금리 동결 우려'],
      '연준 완화(호재)', '연준 긴축(악재)', '연준 불확실', '연준 불확실');

    ko('badge-trade',
      ['무역 흑자','수출 증가','재정 개선','무역 합의','수출 호조'],
      ['무역 적자','재정 우려','재정 적자','수출 감소','재정 위기','재정 팽창'],
      '무역/재정 호조(호재)', '무역/재정 우려(악재)', '무역/재정 혼조', '무역/재정 주시');

    ko('badge-political',
      ['개혁 기대','재정 긴축','정책 안정','룰라 개혁','재정 규율','정치 안정'],
      ['재정 적자','정치 불안','재정 팽창','정치 리스크','탄핵','정치 불확실'],
      '정치 안정(호재)', '정치 리스크(악재)', '정치 혼조', '정치 관망');

    const hasKey = !!localStorage.getItem('anthropic_api_key');
    const note = document.getElementById('news-live-note');
    if (note) note.textContent = hasKey ? '✓ AI 뉴스 분석 중...' : '✓ 최신 뉴스 기반 자동 분류 (API 키 불필요)';

    if (typeof recalcScorecard === 'function') recalcScorecard();

    // API 키 있으면 AI가 뉴스 신호를 정밀 분석 (미국 대시보드와 동일 방식) → 위 키워드 배지를 덮어씀
    if (hasKey && typeof updateAI === 'function' && typeof _liveData !== 'undefined') {
      try {
        await updateAI(_liveData);
        if (note) note.textContent = '✓ AI 뉴스 분석 완료';
      } catch(e) {}
    } else if (typeof applyAnalysis === 'function' && typeof ruleBasedAnalysis === 'function' && typeof _liveData !== 'undefined') {
      applyAnalysis(ruleBasedAnalysis(_liveData));
    }
  }

  // ── 시장데이터.json 캐시 로드 ──
  const FALLBACK_DATA = {
    current: 168454.0, ma_signal: 'neutral', ma_state: '혼조',
    rsi: 41.7, mom4: -4.4, from_hi: -14.6,
    ewz: 34.11, usdbrl: 5.14, vix: 17.3, dxy: 100.64, crude: 78.4, vale: 15.53,
    score_pct: 50, score_label: '관망', score_emoji: '📌',
    score_desc: 'IBOVESPA 기술적 혼조', updated_at: '(캐시)'
  };

  async function loadCachedMarketData() {
    let d = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch('시장데이터.json?t=' + Date.now(), { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const parsed = await res.json();
        if (parsed && parsed.current) d = parsed;
      }
    } catch(e) {}
    if (!d) d = FALLBACK_DATA;

      const scEmoji = document.getElementById('sc-emoji');
      const scPct   = document.getElementById('sc-pct');
      if (scEmoji) scEmoji.textContent = (d.score_emoji || '') + ' ' + (d.score_label || '');
      if (scPct)   scPct.textContent   = (d.score_pct || 0) + '점';

      function setB(id, cls, txt) {
        const el = document.getElementById(id); if (!el) return;
        // 캐시는 아직 로딩 중인 배지만 채움 → 라이브/정규화 값을 덮어쓰지 않음
        if (!(el.classList.contains('badge-b') || /로딩/.test(el.textContent))) return;
        el.className = 'badge ' + cls; el.textContent = txt;
      }
      const ma = d.ma_signal || '';
      setB('badge-ma', ma === 'bull' ? 'badge-g' : ma === 'bear' ? 'badge-r' : 'badge-y',
        ma === 'bull' ? '정배열(상승)' : ma === 'bear' ? '역배열(하락)' : '혼조');
      const rsi = d.rsi || 50;
      setB('badge-rsi', rsi <= 40 ? 'badge-g' : rsi >= 70 ? 'badge-r' : 'badge-y',
        rsi <= 40 ? `RSI ${rsi} 과매도` : rsi >= 70 ? `RSI ${rsi} 과매수` : `RSI ${rsi} 중립`);
      const mom = d.mom4 || 0;
      setB('badge-mom', mom >= 2 ? 'badge-g' : mom <= -2 ? 'badge-r' : 'badge-y',
        mom >= 2 ? `모멘텀 +${mom}%` : mom <= -2 ? `모멘텀 ${mom}%` : '모멘텀 보합');
      const fhi = d.from_hi || 0;
      setB('badge-pos', fhi <= -20 ? 'badge-g' : fhi >= -3 ? 'badge-r' : 'badge-y',
        fhi <= -20 ? `고점대비 ${fhi}% 저점권` : fhi >= -3 ? `고점 근접 ${fhi}%` : `고점대비 ${fhi}%`);
      const vix = d.vix || 0;
      if (vix) setB('badge-vix', vix < 18 ? 'badge-g' : vix > 28 ? 'badge-r' : 'badge-y',
        `VIX ${vix} — ${vix < 18 ? '안정' : vix > 28 ? '공포' : '불안'}`);
      const usdbrl = d.usdbrl || 0;
      if (usdbrl) setB('badge-usdbrl', usdbrl < 5.5 ? 'badge-g' : usdbrl > 6.0 ? 'badge-r' : 'badge-y',
        `R$${usdbrl.toFixed(2)}`);
      const crude = d.crude || 0;
      if (crude) setB('badge-crude', crude > 80 ? 'badge-g' : crude < 65 ? 'badge-r' : 'badge-y',
        `브렌트유 $${crude}`);
      try { if (typeof recalcScorecard === 'function') recalcScorecard(); } catch(e) {}
      console.log('[시장데이터] 캐시 로드 완료:', d.updated_at);
  }

  // fetchLatestNews override (액션가이드에서 사용)
  window.fetchLatestNews = async function () {
    const items = window.__majorNewsItems || [];
    if (!items.length) return {};
    return { '주요 뉴스': items.slice(0, 6).map((n) => n.ko || n.title) };
  };

  // ── AI 질문 override ──
  window.askAI = async function () {
    const qEl = document.getElementById('ai-q');
    const box = document.getElementById('ai-resp');
    if (!qEl || !box) return;
    const q = (qEl.value || '').trim();
    if (!q) return;
    const key = localStorage.getItem('anthropic_api_key');
    if (!key) {
      const ks = document.getElementById('key-setup');
      if (ks) ks.style.display = 'block';
      box.textContent = 'API 키를 먼저 입력해주세요.';
      return;
    }
    box.textContent = '분석 중...';
    const sc = ((document.getElementById('sc-emoji')?.textContent || '') + ' ' + (document.getElementById('sc-pct')?.textContent || '')).trim();
    const signals = [...document.querySelectorAll('.signal-row')].slice(0, 25)
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
    const news = window.__majorNews || '';
    const ctx = `당신은 ${MARKET_DESC} 전문 애널리스트입니다. 아래 실시간 데이터와 오늘의 뉴스를 근거로 한국어로 간결하고 구체적으로 답하세요. 마지막에 "본 답변은 참고용입니다"를 덧붙이세요.\n\n[종합신호] ${sc}\n[지표·신호]\n${signals}` + (news ? `\n\n[오늘의 주요 뉴스]\n${news}` : '');
    try {
      const _ctrl = new AbortController(); const _to = setTimeout(() => _ctrl.abort(), 15000);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        signal: _ctrl.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 700, system: ctx, messages: [{ role: 'user', content: q }] }),
      });
      clearTimeout(_to);
      const d = await r.json();
      if (d.content && d.content[0] && d.content[0].text) box.textContent = d.content[0].text;
      else box.textContent = '오류: ' + JSON.stringify(d.error || d);
    } catch (e) { box.textContent = e.name === 'AbortError' ? '응답이 늦어 중단했어요. 다시 시도해주세요.' : '네트워크 오류: ' + e.message; }
  };

  // ── 전체 실행 ──
  async function runRealtime() {
    await loadCachedMarketData();

    let ibovMeta = null;
    try {
      const url1y = `https://query2.finance.yahoo.com/v8/finance/chart/${MAIN_TICKER_URL}?interval=1wk&range=1y`;
      const j1y = await proxyJSON(url1y, 9000);
      if (j1y && j1y.chart && j1y.chart.result && j1y.chart.result[0]) {
        const res1y = j1y.chart.result[0];
        const weekly = (res1y.indicators.quote[0].close || []).filter(p => p != null);
        if (!ibovMeta) ibovMeta = res1y.meta;
        if (weekly.length >= 6) {
          updateTechnicals(ibovMeta, weekly);
          const url5d = `https://query2.finance.yahoo.com/v8/finance/chart/${MAIN_TICKER_URL}?interval=1d&range=5d`;
          const j5d = await proxyJSON(url5d, 6000);
          const d5prices = (j5d && j5d.chart && j5d.chart.result && j5d.chart.result[0])
            ? (j5d.chart.result[0].indicators.quote[0].close || []).filter(p => p != null)
            : null;
          buildAnalysis(MAIN_TICKER_NAME, weekly, d5prices, ibovMeta);
        }
      }
    } catch (e) {}

    try { await renderMajorNews(); } catch (e) {}
    try { updateNewsBadgesFromKorean(); } catch (e) {}
    try { if (typeof recalcScorecard === 'function') recalcScorecard(); } catch (e) {}
    try { if (typeof buildChecklist === 'function') buildChecklist(); } catch (e) {}

    try {
      await new Promise(r => setTimeout(r, 1000));
      if (typeof recalcScorecard === 'function') recalcScorecard();
      if (typeof buildChecklist === 'function') buildChecklist();
      if (typeof applyAnalysis === 'function' && typeof ruleBasedAnalysis === 'function' && typeof _liveData !== 'undefined') {
        if (!localStorage.getItem('anthropic_api_key')) applyAnalysis(ruleBasedAnalysis(_liveData));
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => setTimeout(runRealtime, 300));
  } else {
    setTimeout(runRealtime, 300);
  }
  // 5분마다 재갱신
  setInterval(runRealtime, 5 * 60 * 1000);
})();
