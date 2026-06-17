"""
브라질 증시 알림 체크 — GitHub Actions에서 실행
평일 9시 / 14시 / 19:30 KST (UTC 0:00 / 5:00 / 10:30)
"""
import os, json, math, datetime, zoneinfo
import yfinance as yf

KST = zoneinfo.ZoneInfo('Asia/Seoul')
DASHBOARD_URL = 'https://bssu3001-oss.github.io/brazil-market-dashboard/'
STATE_FILE = '알림상태.json'
DATA_FILE = '시장데이터.json'


def load_state():
    try:
        with open(STATE_FILE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    with open(STATE_FILE, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def get_slot():
    now = datetime.datetime.now(KST)
    h, m = now.hour, now.minute
    if   7 <= h < 10:  return 'morning'
    elif 12 <= h < 15: return 'afternoon'
    elif 18 <= h < 22: return 'evening'
    return None


def fetch_market_data():
    sp = yf.download('^BVSP', period='1y', interval='1wk', auto_adjust=True, progress=False)
    close_col = sp['Close']
    if hasattr(close_col, 'ndim') and close_col.ndim > 1:
        close_col = close_col.iloc[:, 0]
    closes = [float(v) for v in close_col.dropna().values.tolist()]

    extras_tickers = ['EWZ', 'BRL=X', '^VIX', 'DX-Y.NYB', 'BZ=F', 'VALE']
    extras = yf.download(extras_tickers, period='5d', interval='1d', auto_adjust=True, progress=False)

    def last_close(ticker):
        try:
            col = extras[('Close', ticker)]
            val = col.dropna().iloc[-1]
            return float(val)
        except Exception:
            return None

    def pct_change(ticker):
        try:
            col = extras[('Close', ticker)].dropna()
            if len(col) < 2:
                return 0.0
            return float((col.iloc[-1] - col.iloc[-2]) / col.iloc[-2] * 100)
        except Exception:
            return 0.0

    ewz    = last_close('EWZ')
    usdbrl = last_close('BRL=X')
    vix    = last_close('^VIX')
    dxy    = last_close('DX-Y.NYB')
    crude  = last_close('BZ=F')
    vale   = last_close('VALE')

    ewz_pct  = pct_change('EWZ')
    vale_pct = pct_change('VALE')

    n = len(closes)
    rsi = None
    if n >= 15:
        gain, loss = 0, 0
        for i in range(n-14, n):
            d = closes[i] - closes[i-1]
            if d >= 0: gain += d
            else:      loss -= d
        avg_gain, avg_loss = gain/14, loss/14
        if avg_loss == 0: rsi = 100
        else: rsi = 100 - 100 / (1 + avg_gain / avg_loss)

    def sma(p, w):
        if len(p) < w: return None
        return sum(p[-w:]) / w

    ma5, ma13, ma26 = sma(closes, 5), sma(closes, 13), sma(closes, 26)
    cur = closes[-1]
    ma_signal, ma_state = 'neutral', '혼조'
    if ma5 and ma13 and ma26:
        if cur > ma5 > ma13 > ma26:   ma_signal, ma_state = 'bull', '정배열'
        elif cur < ma5 < ma13 < ma26: ma_signal, ma_state = 'bear', '역배열'

    mom4 = round((closes[-1] - closes[-5]) / closes[-5] * 100, 2) if n >= 5 else 0
    hi52, lo52 = max(closes), min(closes)
    from_hi = round((cur - hi52) / hi52 * 100, 1)

    rets = [(closes[i]-closes[i-1])/closes[i-1]*100 for i in range(max(1,n-12), n)]
    mean = sum(rets)/len(rets) if rets else 0
    vol  = math.sqrt(sum((r-mean)**2 for r in rets)/len(rets)) if rets else 0

    return {
        'closes': closes, 'cur': cur, 'rsi': rsi,
        'ma_signal': ma_signal, 'ma_state': ma_state,
        'mom4': mom4, 'from_hi': from_hi, 'vol': vol,
        'ewz': ewz, 'ewz_pct': ewz_pct,
        'usdbrl': usdbrl, 'vix': vix, 'dxy': dxy,
        'crude': crude, 'vale': vale, 'vale_pct': vale_pct,
    }


def calc_scorecard(d):
    score = 0
    parts = []
    rsi = d.get('rsi') or 50
    if rsi <= 40: score += 1; parts.append(f'RSI {rsi:.1f} 과매도')
    elif rsi >= 70: score -= 1; parts.append(f'RSI {rsi:.1f} 과매수')
    if d['ma_signal'] == 'bull': score += 1; parts.append(f'이평 {d["ma_state"]}')
    elif d['ma_signal'] == 'bear': score -= 1; parts.append(f'이평 {d["ma_state"]}')
    mom4 = d.get('mom4', 0)
    if mom4 >= 2: score += 1
    elif mom4 <= -2: score -= 1
    fhi = d.get('from_hi', 0)
    if fhi <= -20: score += 1
    elif fhi >= -3: score -= 1
    vix = d.get('vix') or 20
    if vix < 18: score += 1; parts.append(f'VIX {vix:.1f} 안정')
    elif vix > 28: score -= 1; parts.append(f'VIX {vix:.1f} 공포')
    usdbrl = d.get('usdbrl') or 5.5
    if usdbrl < 5.5: score += 1; parts.append(f'USD/BRL {usdbrl:.2f} 안정')
    elif usdbrl > 6.0: score -= 1; parts.append(f'USD/BRL {usdbrl:.2f} 약세')
    crude = d.get('crude') or 70
    if crude > 80: score += 1; parts.append(f'브렌트유 ${crude:.1f} 고유가')
    elif crude < 65: score -= 1; parts.append(f'브렌트유 ${crude:.1f} 저유가')
    ewz_pct = d.get('ewz_pct', 0)
    if ewz_pct >= 0.5: score += 1
    elif ewz_pct <= -0.5: score -= 1
    max_score = 8
    pct = max(0, min(100, round((score + max_score) / (2 * max_score) * 100)))
    if score >= 4:   label, emoji = '강매수',    '🔥'
    elif score >= 1: label, emoji = '매수 검토', '🟢'
    elif score >= -1:label, emoji = '관망',      '📌'
    elif score >= -4:label, emoji = '조심',      '⚠️'
    else:            label, emoji = '진입 자제', '🔴'
    desc = ' / '.join(parts[:4]) if parts else '지표 중립'
    return {'score': score, 'pct': pct, 'label': label, 'emoji': emoji, 'desc': desc}


def check_conditions(d, sc):
    conditions = []
    rsi = d.get('rsi') or 50
    if rsi <= 35:
        conditions.append(('매수핵심', f'RSI {rsi:.1f} — 극도의 과매도 신호'))
    if d['ma_signal'] == 'bull' and d.get('mom4', 0) > 0:
        conditions.append(('매수참고', f'이평 {d["ma_state"]} + 4주 모멘텀 +{d["mom4"]}%'))
    if d.get('from_hi', 0) <= -15 and rsi <= 45:
        conditions.append(('매수참고', f'고점 대비 {d["from_hi"]}% 조정 + RSI {rsi:.1f}'))
    vix = d.get('vix') or 20
    if vix >= 28:
        conditions.append(('주의', f'VIX {vix:.1f} 공포 구간 — 진입 신중'))
    usdbrl = d.get('usdbrl') or 5.5
    if usdbrl >= 6.0:
        conditions.append(('주의', f'USD/BRL {usdbrl:.2f} — 헤알화 급약세'))
    if d['closes'] and d['closes'][-1] <= 90000:
        conditions.append(('손절경고', f'IBOVESPA {d["closes"][-1]:,.0f} — 손절 기준 이탈'))
    return conditions


def send_kakao(msg):
    import urllib.request, urllib.parse
    rest_key     = os.environ.get('KAKAO_REST_API_KEY', '')
    refresh_tok  = os.environ.get('KAKAO_REFRESH_TOKEN', '')
    client_secret= os.environ.get('KAKAO_CLIENT_SECRET', '')
    if not rest_key or not refresh_tok:
        print('[카카오] 환경변수 없음 — 전송 생략')
        return False
    try:
        # 토큰 갱신
        data = urllib.parse.urlencode({
            'grant_type':'refresh_token','client_id':rest_key,
            'refresh_token':refresh_tok,'client_secret':client_secret
        }).encode()
        req = urllib.request.Request('https://kauth.kakao.com/oauth/token',
            data=data, headers={'Content-Type':'application/x-www-form-urlencoded'})
        with urllib.request.urlopen(req) as resp:
            tok = json.loads(resp.read())
        access = tok.get('access_token','')
        if not access: print('[카카오] 토큰 오류:', tok); return False
        # 메모 전송
        template = json.dumps({'object_type':'text','text':msg,'link':{'web_url':DASHBOARD_URL,'mobile_web_url':DASHBOARD_URL}}, ensure_ascii=False)
        data2 = urllib.parse.urlencode({'template_object':template}).encode()
        req2 = urllib.request.Request('https://kapi.kakao.com/v2/api/talk/memo/default/send',
            data=data2, headers={'Authorization':f'Bearer {access}','Content-Type':'application/x-www-form-urlencoded'})
        with urllib.request.urlopen(req2) as resp2:
            result = json.loads(resp2.read())
        if result.get('result_code') == 0:
            print('✅ 카카오 전송 완료')
            return True
        print('[카카오] 전송 실패:', result)
        return False
    except Exception as e:
        print('[카카오] 예외:', e)
        return False


def build_message(d, sc, conditions, slot):
    slot_kr = {'morning':'오전','afternoon':'오후','evening':'저녁'}.get(slot,'')
    now = datetime.datetime.now(KST)
    ts  = now.strftime('%Y-%m-%d %H:%M KST')
    cur = d['closes'][-1] if d['closes'] else 0
    rsi_str  = f'{d["rsi"]:.1f}' if d.get('rsi') else '--'
    ewz_str  = f'${d["ewz"]:.2f} ({d["ewz_pct"]:+.2f}%)' if d.get('ewz') else '--'
    usdbrl_s = f'R${d["usdbrl"]:.2f}' if d.get('usdbrl') else '--'
    vix_s    = f'{d["vix"]:.1f}' if d.get('vix') else '--'
    crude_s  = f'${d["crude"]:.1f}' if d.get('crude') else '--'
    vale_s   = f'${d["vale"]:.2f} ({d["vale_pct"]:+.2f}%)' if d.get('vale') else '--'
    cond_lines = '\n'.join(f'[{c[0]}] {c[1]}' for c in conditions) if conditions else '특이 신호 없음'
    msg = f"""🇧🇷 브라질 증시 {slot_kr} 시황
{ts}

IBOVESPA: {cur:,.0f} (4주 {d['mom4']:+.1f}%)
EWZ ETF:  {ewz_str}
이평선:   {d['ma_state']} | RSI: {rsi_str}
USD/BRL:  {usdbrl_s} | VIX: {vix_s}
브렌트유: {crude_s} | Vale: {vale_s}

━━━━━━━━━━━━
종합신호: {sc['emoji']} {sc['label']} ({sc['pct']}점)
{sc['desc']}

[알림 조건]
{cond_lines}

🔗 {DASHBOARD_URL}"""
    return msg.strip()


def save_market_data(d, sc):
    now = datetime.datetime.now(KST).strftime('%Y-%m-%d %H:%M KST')
    cur = d['closes'][-1] if d['closes'] else 0
    data = {
        'current':    round(cur, 0),
        'ma_signal':  d['ma_signal'],
        'ma_state':   d['ma_state'],
        'rsi':        round(d['rsi'], 1) if d.get('rsi') else None,
        'mom4':       round(d['mom4'], 2),
        'from_hi':    d['from_hi'],
        'ewz':        round(d['ewz'], 2) if d.get('ewz') else None,
        'usdbrl':     round(d['usdbrl'], 2) if d.get('usdbrl') else None,
        'vix':        round(d['vix'], 1) if d.get('vix') else None,
        'dxy':        round(d['dxy'], 2) if d.get('dxy') else None,
        'crude':      round(d['crude'], 1) if d.get('crude') else None,
        'vale':       round(d['vale'], 2) if d.get('vale') else None,
        'score_pct':  sc['pct'],
        'score_label':sc['label'],
        'score_emoji':sc['emoji'],
        'score_desc': sc['desc'],
        'updated_at': now,
    }
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f'[시장데이터] 저장 완료 — IBOVESPA {cur:,.0f} / {sc["label"]}')


def main():
    slot = get_slot()
    print(f'[슬롯] {slot}')
    if slot is None:
        print('[알림] 알림 슬롯 아님 — 종료')
        return

    state = load_state()
    today = datetime.datetime.now(KST).strftime('%Y-%m-%d')
    sent_today = state.get(today, [])

    print('[데이터] 수집 중...')
    d  = fetch_market_data()
    sc = calc_scorecard(d)
    conditions = check_conditions(d, sc)
    print(f'[점수] {sc["emoji"]} {sc["label"]} {sc["pct"]}점')
    print(f'[조건] {[c[0] for c in conditions]}')

    save_market_data(d, sc)

    msg = build_message(d, sc, conditions, slot)
    print('\n[메시지 미리보기]\n' + msg + '\n')

    should_send = False
    send_reasons = []

    if slot not in sent_today:
        should_send = True
        send_reasons.append(f'{slot} 정기 알림')

    cond_key = lambda c: f'{c[0]}_{slot}'
    new_conditions = [c for c in conditions if cond_key(c) not in sent_today]
    if new_conditions:
        should_send = True
        send_reasons += [c[0] for c in new_conditions]

    if should_send:
        print(f'[전송] 이유: {send_reasons}')
        ok = send_kakao(msg)
        if ok:
            new_sent = set(sent_today) | {slot} | {cond_key(c) for c in new_conditions}
            state[today] = list(new_sent)
            save_state(state)
    else:
        print(f'[알림] 오늘 {slot} 이미 전송됨 — 생략')


if __name__ == '__main__':
    main()
