"""小乖剪 Reels：把一段影片自動剪成直式 9:16 短影音，上中英字幕、配背景音樂。

在 GitHub Actions 上跑（.github/workflows/reels.yml），由小乖的 Apps Script 觸發：
  你在 Telegram 傳影片給小乖 → 小乖叫這支程式 → 剪好直接傳回 Telegram。

流程：
  1. 從 Telegram 下載影片
  2. 用 OpenAI 語音辨識拿到逐句文字與時間
  3. 讓 AI 挑精華句子、改成短句字幕（繁中＋英文）、想開頭標題、重點標籤、重點字卡和貼文文案
  4. ffmpeg 剪接並剪掉講話中間的停頓、轉成 1080×1920（橫的影片上下補模糊背景）、
     燒上字幕與動畫字卡（開頭打字標題、標籤一個個打勾、重點跳出來）、混入配樂（有人說話時音樂自動變小）
  5. 傳回 Telegram，當作「第 N 版試剪」；你回覆「改 …」就照你說的再剪一版

風格：你傳一張喜歡的影片截圖給小乖，小乖記下字幕顏色、大小、位置（STYLE），之後都照這個剪。

需要的環境變數：TELEGRAM_BOT_TOKEN、OPENAI_API_KEY、CHAT_ID、FILE_ID；NOTE 是你寫在影片上的說明和修改要求（可空白）；
STYLE 是從截圖學到的風格（JSON，可空白）；VERSION 是第幾版。
本機測試：python3 reels/reels.py --input 影片.mp4 --out 成品.mp4 [--transcript 假字幕.json] [--note "剪 Reels 30秒"]
"""
import argparse
import glob
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
W, H, FPS = 1080, 1920, 30
FONT = os.environ.get('REELS_FONT') or 'Noto Sans CJK TC'
MODEL = os.environ.get('OPENAI_MODEL') or 'gpt-4.1-mini'
MAX_SOURCE_SEC = 20 * 60          # 原始影片最長 20 分鐘
TG_LIMIT = 48 * 1024 * 1024       # Telegram 機器人傳影片上限 50MB，留一點空間


class Oops(Exception):
    """要讓使用者看到的錯誤（繁體中文）。"""


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        log(' '.join(cmd[:6]), '…\n', p.stderr[-3000:])
        raise RuntimeError('ffmpeg 失敗')
    return p.stdout


# ---------------- 讀說明：時間長度、配樂、字幕選項 ----------------
DEFAULTS = {
    'target': 60, 'music': True, 'subs': 'both', 'mood': '', 'title': '',
    'jumpcut': True,        # 剪掉講話中間的停頓
    'cards': True,          # 動畫字卡：開頭打字標題、標籤打勾、重點跳出來
    'title_sec': 3.5,       # 開頭標題停留秒數
    'sub_size': 1.0,        # 字幕大小倍數
    'sub_pos': 'lower',     # 字幕位置：bottom 最下面、lower 下方偏中間（預設）、middle 中間、upper 上方
    'sub_color': '#FFFFFF', 'sub_outline': '#141414', 'sub_box': False,
    'accent': '#F5C842',    # 標籤打勾、重點字卡的顏色
}
POS_Y = {'bottom': 380, 'lower': 560, 'middle': 820, 'upper': 1250}   # 字幕底邊離畫面最下面的距離


def clamp_opt(opt):
    opt['target'] = max(10, min(90, int(float(opt.get('target') or 60))))
    opt['title_sec'] = max(1.5, min(8, float(opt.get('title_sec') or 3.5)))
    opt['sub_size'] = max(.6, min(1.6, float(opt.get('sub_size') or 1)))
    if opt.get('sub_pos') not in POS_Y:
        opt['sub_pos'] = 'lower'
    if opt.get('subs') not in ('both', 'zh', 'en', 'none'):
        opt['subs'] = 'both'
    for k in ('sub_color', 'sub_outline', 'accent'):
        if not re.match(r'^#[0-9A-Fa-f]{6}$', str(opt.get(k) or '')):
            opt[k] = DEFAULTS[k]
    for k in ('music', 'jumpcut', 'cards', 'sub_box'):
        opt[k] = bool(opt.get(k))
    return opt


def apply_style(opt, style):
    """從截圖學到的風格（Apps Script 用 AI 看圖整理的 JSON）。"""
    if not style:
        return opt
    try:
        st = json.loads(style) if isinstance(style, str) else style
    except ValueError:
        return opt
    for k in ('sub_size', 'sub_pos', 'sub_color', 'sub_outline', 'sub_box', 'accent', 'subs', 'cards'):
        if k in st and st[k] not in (None, ''):
            opt[k] = st[k]
    return clamp_opt(opt)


TWEAK_PROMPT = '''把使用者對短影音剪輯的說明和修改要求，轉成設定值。只改有提到的項目，沒提到的不要放。
後面的要求比前面的優先（例如先說 60 秒、後來說改 30 秒，就用 30）。可用的設定：
target 秒數(10-90)、music 要不要配樂(true/false)、mood 配樂風格(溫暖輕快/清新療癒/質感沉穩)、
subs 字幕(both 中英/zh 只要中文/en 只要英文/none 不要)、title 開頭標題文字、title_sec 標題停留秒數(1.5-8，
「久一點」在目前值 {title_sec} 加 1.5)、jumpcut 剪掉停頓(true/false)、cards 動畫字卡(true/false)、
sub_size 字幕大小倍數(目前 {sub_size}，「大一點」×1.2、「小一點」×0.85)、
sub_pos 字幕位置(bottom/lower/middle/upper)、sub_color 字幕顏色(#RRGGBB)、sub_box 字幕底色框(true/false)、
accent 標籤與字卡顏色(#RRGGBB)。另外把無法用設定表達、要給剪輯師參考的要求寫進 wish（一句話，沒有就空字串）。
只回 JSON，例如 {{"sub_size": 1.2, "title_sec": 5, "wish": ""}}'''


def apply_tweaks(opt, note):
    """說明或「改 …」的要求，交給 AI 轉成設定（有金鑰、而且說明不只是基本關鍵字時才問）。"""
    rest = re.sub(r'剪\s*reels|reels|\d+\s*(秒|分鐘?)|標題[：:\s]*\S+|[\s，,。；;、]', '', note or '', flags=re.I)
    if not rest or not os.environ.get('OPENAI_API_KEY'):
        return opt
    try:
        tw = ask_ai(TWEAK_PROMPT.format(title_sec=opt['title_sec'], sub_size=opt['sub_size']), note)
    except Oops:
        return opt
    for k, v in tw.items():
        if k in DEFAULTS and v not in (None, ''):
            opt[k] = v
    opt['wish'] = str(tw.get('wish') or '')[:200]
    return clamp_opt(opt)


def parse_note(note):
    note = note or ''
    opt = dict(DEFAULTS)
    m = re.search(r'(\d{1,3})\s*(秒|s|sec)', note, re.I)
    if m:
        opt['target'] = max(10, min(90, int(m.group(1))))
    elif re.search(r'(\d)\s*分(鐘)?', note):
        opt['target'] = max(10, min(90, int(re.search(r'(\d)\s*分', note).group(1)) * 60))
    if re.search(r'(不要|無|沒有|免|關掉?)\s*(配樂|音樂)', note):
        opt['music'] = False
    if re.search(r'(不要|不用|別)\s*剪\s*(掉)?\s*停頓', note):
        opt['jumpcut'] = False
    if re.search(r'(不要|無|沒有|免|關掉?)\s*(動畫|字卡)', note):
        opt['cards'] = False
    if re.search(r'(不要|無|沒有|免|關掉?)\s*字幕', note):
        opt['subs'] = 'none'
    elif re.search(r'只要?\s*中文', note):
        opt['subs'] = 'zh'
    elif re.search(r'只要?\s*英文', note):
        opt['subs'] = 'en'
    for f in sorted(glob.glob(os.path.join(HERE, 'music', '*.mp3'))):   # 說明寫了配樂檔名的前兩個字或後兩個字就用那首
        name = os.path.basename(f)[:-4]
        if name[:2] in note or name[-2:] in note:
            opt['mood'] = name
    t = re.search(r'標題[：:\s]*([^\s，,。]{1,20})', note)
    if t:
        opt['title'] = t.group(1).strip()
    return clamp_opt(opt)


# ---------------- Telegram ----------------
def tg(method, **data):
    token = os.environ['TELEGRAM_BOT_TOKEN']
    req = urllib.request.Request('https://api.telegram.org/bot%s/%s' % (token, method),
                                 data=json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b'{}')


def tg_download(file_id, dest):
    info = tg('getFile', file_id=file_id)
    if not info.get('ok'):
        if 'too big' in str(info.get('description', '')):
            raise Oops('影片超過 20MB，Telegram 不讓機器人下載。請在 Telegram 傳影片時選「壓縮」（不要用檔案傳），或先剪短一點再傳。')
        raise Oops('拿不到影片（%s），請再傳一次。' % info.get('description', ''))
    url = 'https://api.telegram.org/file/bot%s/%s' % (os.environ['TELEGRAM_BOT_TOKEN'], info['result']['file_path'])
    urllib.request.urlretrieve(url, dest)


def tg_send_video(chat_id, path, caption, thumb=None):
    cmd = ['curl', '-sS', '-F', 'chat_id=%s' % chat_id, '-F', 'video=@%s' % path, '-F', 'supports_streaming=true',
           '-F', 'width=%d' % W, '-F', 'height=%d' % H, '-F', 'caption=%s' % caption[:1000]]
    if thumb:
        cmd += ['-F', 'thumbnail=@%s' % thumb]
    cmd.append('https://api.telegram.org/bot%s/sendVideo' % os.environ['TELEGRAM_BOT_TOKEN'])
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        ok = json.loads(out).get('ok')
    except ValueError:
        ok = False
    if not ok:
        log('sendVideo 失敗：', out[:500])
        raise Oops('影片剪好了，但傳回 Telegram 失敗，請再試一次。')


# ---------------- OpenAI ----------------
def transcribe(audio):
    out = subprocess.run([
        'curl', '-sS', 'https://api.openai.com/v1/audio/transcriptions',
        '-H', 'Authorization: Bearer %s' % os.environ['OPENAI_API_KEY'],
        '-F', 'file=@%s' % audio, '-F', 'model=whisper-1', '-F', 'response_format=verbose_json',
        '-F', 'timestamp_granularities[]=segment', '-F', 'prompt=以下是繁體中文（台灣）的口語影片。',
    ], capture_output=True, text=True).stdout
    try:
        data = json.loads(out)
    except ValueError:
        data = {}
    if 'segments' not in data:
        log('語音辨識回應：', out[:300])
        raise Oops('語音辨識失敗，請稍後再試一次。')
    return [{'start': float(s['start']), 'end': float(s['end']), 'text': s['text'].strip()}
            for s in data['segments'] if s.get('text', '').strip()]


def ask_ai(system, user):
    body = {'model': MODEL, 'response_format': {'type': 'json_object'},
            'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]}
    req = urllib.request.Request('https://api.openai.com/v1/chat/completions', data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json',
                                          'Authorization': 'Bearer %s' % os.environ['OPENAI_API_KEY']})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(json.load(r)['choices'][0]['message']['content'])
    except Exception as e:   # noqa: BLE001
        log('AI 失敗：', e)
        raise Oops('AI 整理字幕失敗，請稍後再試一次。')


PLAN_PROMPT = '''你是 Instagram Reels 剪輯師，幫一位台灣的直銷事業經營者剪短影音。
會給你影片逐句辨識結果（i 是編號，秒數是時間），和使用者的說明。請：
1. 挑出要保留的句子，總長不超過 {target} 秒（原片比較短就全部留，只刪口誤、重複、無意義的句子）。
   要挑最吸引人、意思完整、前後接得起來的段落，第一句最好能抓住注意力。保留的句子照原本順序。
2. 每一句改成字幕：繁體中文（台灣用語），依上下文修正辨識錯字，句尾不加標點；
   拆成短句，一行 6～12 個字、照說話的停頓斷句（像抖音、Reels 那種一句一句跳出來的字幕）。
   每行附上自然口語的英文翻譯。
3. 想一個 12 個字以內、像在跟 AI 下指令或抓住注意力的開頭標題（使用者說明裡有指定標題就用那個）。
4. 挑 3～4 個影片重點標籤，每個 2～4 個字（例如：字幕、剪輯、動畫、字卡）。
5. 挑 1～3 句最重要的話做重點字卡：給那句的 i 和 10 個字以內的重點。
6. 寫一段 IG 貼文文案（3～5 行，繁體中文，結尾 5 個 hashtag）。
{wish}只回 JSON：{{"title": "", "tags": [""], "keep": [{{"i": 0, "lines": [{{"zh": "", "en": ""}}]}}], "pops": [{{"i": 0, "text": ""}}], "post": ""}}'''


def plan_clips(segs, opt, note):
    if not segs:
        return None
    lines = '\n'.join('i=%d [%.1f-%.1f] %s' % (i, s['start'], s['end'], s['text']) for i, s in enumerate(segs))
    wish = '使用者另外的要求：%s\n' % opt['wish'] if opt.get('wish') else ''
    plan = ask_ai(PLAN_PROMPT.format(target=opt['target'], wish=wish),
                  '使用者說明：%s\n\n逐句辨識：\n%s' % (note or '（無）', lines))
    keep, total, seen = [], 0.0, set()
    for k in plan.get('keep') or []:
        try:
            i = int(k.get('i'))
        except (TypeError, ValueError):
            continue
        if i in seen or not 0 <= i < len(segs):
            continue
        dur = segs[i]['end'] - segs[i]['start']
        if keep and total + dur > opt['target'] * 1.15:
            break
        seen.add(i)
        total += dur
        ls = [l for l in (k.get('lines') or []) if (l.get('zh') or '').strip()]
        keep.append({'i': i, 'lines': ls or [{'zh': segs[i]['text'], 'en': ''}]})
    keep.sort(key=lambda k: k['i'])
    tags = [str(t).strip()[:5] for t in (plan.get('tags') or []) if str(t).strip()][:4]
    pops = []
    for pp in plan.get('pops') or []:
        try:
            if int(pp.get('i')) in seen and str(pp.get('text') or '').strip():
                pops.append({'i': int(pp['i']), 'text': str(pp['text']).strip()[:12]})
        except (TypeError, ValueError, AttributeError):
            continue
    return {'title': opt['title'] or (plan.get('title') or '').strip()[:16], 'keep': keep, 'tags': tags,
            'pops': pops[:3], 'post': (plan.get('post') or '').strip()}


# ---------------- 影片處理 ----------------
def probe(path):
    out = json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]))
    dur = float(out['format'].get('duration') or 0)
    has_audio = any(s.get('codec_type') == 'audio' for s in out['streams'])
    if not any(s.get('codec_type') == 'video' for s in out['streams']):
        raise Oops('這個檔案裡沒有影片畫面。')
    return dur, has_audio


def clips_from_plan(plan, segs, dur):
    """保留的句子 → 剪輯區間（前後留一點空間，靠很近的合併成一段）。"""
    spans = []
    for k in plan['keep']:
        s = segs[k['i']]
        a, b = max(0, s['start'] - .15), min(dur, s['end'] + .25)
        if spans and a - spans[-1][1] < .5 and a >= spans[-1][0]:
            spans[-1][1] = max(spans[-1][1], b)
        else:
            spans.append([a, b])
    return spans


def silences(src):
    """找出講話中間的停頓（安靜超過 0.35 秒的地方）。"""
    p = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', src, '-vn', '-af',
                        'silencedetect=noise=-33dB:d=0.35', '-f', 'null', '-'], capture_output=True, text=True)
    out, st = [], None
    for line in p.stderr.splitlines():
        m = re.search(r'silence_start: ([\d.]+)', line)
        if m:
            st = float(m.group(1))
        m = re.search(r'silence_end: ([\d.]+)', line)
        if m and st is not None:
            out.append((st, float(m.group(1))))
            st = None
    return out


def drop_pauses(spans, sil, keep=.12):
    """把停頓從剪輯區間挖掉，停頓前後各留一點點，聽起來才不會太趕。"""
    out = []
    for a, b in spans:
        pieces = [[a, b]]
        for s0, s1 in sil:
            s0, s1 = s0 + keep, s1 - keep
            if s1 - s0 < .2:
                continue
            nxt = []
            for x, y in pieces:
                if s1 <= x or s0 >= y:
                    nxt.append([x, y])
                    continue
                if s0 - x > .25:
                    nxt.append([x, s0])
                if y - s1 > .25:
                    nxt.append([s1, y])
            pieces = nxt
        out += pieces
    return out


def clips_without_speech(dur, target):
    """沒有人說話的影片：短的整段用；長的平均挑幾段，每段 4 秒。"""
    if dur <= target + 1:
        return [[0, dur]]
    n = max(3, int(target // 4))
    step = dur / n
    return [[i * step + (step - 4) / 2, i * step + (step - 4) / 2 + 4] for i in range(n)]


VF = ('[0:v]fps=%d,split[a][b];'
      '[a]scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,boxblur=30:3,eq=brightness=-0.08[bg];'
      '[b]scale=%d:%d:force_original_aspect_ratio=decrease[fg];'
      '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]') % (FPS, W, H, W, H, W, H)


def cut(src, spans, has_audio, work):
    parts = []
    for n, (a, b) in enumerate(spans):
        out = os.path.join(work, 'part%03d.mp4' % n)
        cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-ss', '%.3f' % a, '-t', '%.3f' % (b - a), '-i', src]
        if not has_audio:
            cmd += ['-f', 'lavfi', '-t', '%.3f' % (b - a), '-i', 'anullsrc=r=48000:cl=stereo']
        cmd += ['-filter_complex', VF, '-map', '[v]', '-map', '0:a:0' if has_audio else '1:a',
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', str(FPS),
                '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', out]
        run(cmd)
        parts.append(out)
    lst = os.path.join(work, 'list.txt')
    with open(lst, 'w') as f:
        f.writelines("file '%s'\n" % p for p in parts)
    joined = os.path.join(work, 'joined.mp4')
    run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', joined])
    return joined


def ass_time(t):
    t = max(0, t)
    h, r = divmod(t, 3600)
    m, s = divmod(r, 60)
    return '%d:%02d:%05.2f' % (h, m, s)


def ass_text(s):
    return re.sub(r'[{}\\]', '', s).replace('\n', ' ').strip()


def ass_color(hexc, alpha=0):
    h = hexc.lstrip('#')
    return '&H%02X%s%s%s' % (alpha, h[4:6], h[2:4], h[0:2])


def remapper(spans):
    """原影片時間 → 剪好後的時間；落在被剪掉的地方，開頭往後靠、結尾往前靠。"""
    offs, acc = [], 0.0
    for a, b in spans:
        offs.append((a, b, acc))
        acc += b - a

    def remap(t, side='start'):
        prev = None
        for a, b, o in offs:
            if a - .01 <= t <= b + .01:
                return o + min(max(t, a), b) - a
            if t < a:
                return o if side == 'start' else (prev if prev is not None else o)
            prev = o + (b - a)
        return prev
    return remap


def chip_w(text, fs):
    return int(sum(fs * (.55 if ord(c) < 128 else 1.0) for c in text) + fs * .6)


def build_ass(plan, segs, spans, opt, total, path):
    k = opt['sub_size']
    fs, fs_en = int(74 * k), int(44 * k)
    box = opt['sub_box']
    head = '\n'.join([
        '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: %d' % W, 'PlayResY: %d' % H, 'WrapStyle: 0',
        'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, '
        'Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, '
        'MarginR, MarginV, Encoding',
        # 字幕：粗體大字、深色描邊＋淡陰影（像參考影片），也可以改成底色框
        'Style: Sub,%s,%d,%s,%s,%s,%s,-1,0,0,0,100,100,1,0,%d,%d,%d,2,80,80,%d,1' % (
            FONT, fs, ass_color(opt['sub_color']), ass_color(opt['sub_color']),
            ass_color(opt['sub_outline'], 0x30 if box else 0), '&H78000000',
            3 if box else 1, 14 if box else 4, 0 if box else 3, POS_Y[opt['sub_pos']]),
        # 開頭標題：深色半透明圓角輸入框裡打字
        'Style: Ask,%s,50,&H00FFFFFF,&H00FFFFFF,&H40262626,&H00000000,-1,0,0,0,100,100,1,0,3,22,0,8,80,80,270,1' % FONT,
        # 標籤：沒打勾是深灰、打勾後變亮色
        'Style: Chip,%s,44,&H00FFFFFF,&H00FFFFFF,&H50303030,&H00000000,-1,0,0,0,100,100,1,0,3,12,0,7,0,0,0,1' % FONT,
        'Style: ChipOn,%s,44,&H00151515,&H00151515,%s,&H00000000,-1,0,0,0,100,100,1,0,3,12,0,7,0,0,0,1' % (
            FONT, ass_color(opt['accent'])),
        # 重點字卡：亮色底、深色字，跳出來
        'Style: Pop,%s,60,&H00151515,&H00151515,%s,&H00000000,-1,0,0,0,100,100,1,0,3,20,0,5,0,0,0,1' % (
            FONT, ass_color(opt['accent'])),
        '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ''])
    ev = []

    def add(layer, a, b, style, text):
        if b - a > .05:
            ev.append('Dialogue: %d,%s,%s,%s,,0,0,0,,%s' % (layer, ass_time(a), ass_time(min(b, total)), style, text))

    remap = remapper(spans)
    plan = plan or {}
    end_intro = min(opt['title_sec'], total)
    if opt['cards'] and plan.get('title'):
        title = ass_text(plan['title'])
        t0, step = .25, .07   # 一個字一個字打出來
        for i in range(1, len(title) + 1):
            add(2, t0 + (i - 1) * step, t0 + i * step if i < len(title) else end_intro, 'Ask',
                ('{\\fad(150,0)}' if i == 1 else '') + title[:i] + ('{\\alpha&HFF&}' if i == len(title) else '') + '｜')
    elif plan.get('title'):
        add(2, .2, end_intro, 'Ask', '{\\fad(200,300)}' + ass_text(plan['title']))
    if opt['cards'] and plan.get('tags'):
        x, y = 60, 140
        for n, tag in enumerate(plan['tags']):
            tag = ass_text(tag)
            on = .5 + n * .35
            add(3, .15, on, 'Chip', '{\\pos(%d,%d)\\fad(150,0)}○ %s' % (x, y, tag))
            add(3, on, end_intro, 'ChipOn', '{\\pos(%d,%d)\\fscx80\\fscy80\\t(0,120,\\fscx106\\fscy106)'
                '\\t(120,220,\\fscx100\\fscy100)\\fad(0,250)}√ %s' % (x, y, tag))
            x += chip_w('√ ' + tag, 44) + 22
    if opt['subs'] != 'none':
        for kp in plan.get('keep') or []:
            s = segs[kp['i']]
            st, en = remap(s['start'], 'start'), remap(s['end'], 'end')
            if st is None or en is None or en - st < .2:
                continue
            weights = [max(1, len(l['zh'])) for l in kp['lines']]
            t = st
            for l, w in zip(kp['lines'], weights):
                d = (en - st) * w / sum(weights)
                zh, eng = ass_text(l.get('zh', '')), ass_text(l.get('en', ''))
                if opt['subs'] == 'zh' or not eng:
                    txt = zh
                elif opt['subs'] == 'en':
                    txt = eng
                else:
                    txt = zh + '\\N{\\fs%d\\b0\\alpha&H18&}' % fs_en + eng
                add(0, t, t + d, 'Sub', '{\\fad(60,0)}' + txt)
                t += d
    if opt['cards']:
        for pp in plan.get('pops') or []:
            st = remap(segs[pp['i']]['start'], 'start')
            if st is None or st < end_intro:
                continue
            add(4, st, st + 2.2, 'Pop', '{\\pos(%d,%d)\\fscx40\\fscy40\\t(0,160,\\fscx108\\fscy108)'
                '\\t(160,260,\\fscx100\\fscy100)\\fad(0,250)}%s' % (W // 2, 480, ass_text(pp['text'])))
    with open(path, 'w', encoding='utf-8') as f:
        f.write(head + '\n'.join(ev) + '\n')
    return sum(1 for e in ev if ',Sub,' in e)


def pick_music(opt):
    if not opt['music']:
        return None
    files = sorted(glob.glob(os.path.join(HERE, 'music', '*.mp3')))
    if not files:
        return None
    if opt['mood']:
        m = [f for f in files if opt['mood'] in os.path.basename(f)]
        if m:
            return m[0]
    return random.choice(files)


def finish(joined, ass, music, total, out, work):
    # 控制檔案大小，Telegram 機器人傳影片上限 50MB
    kbps = int(min(6000, (TG_LIMIT * 8 / 1000) / max(total, 1) - 200))
    vf = "[0:v]ass='%s'[v]" % ass.replace("'", "\\'").replace(':', '\\:')
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', joined]
    fade = 'afade=t=in:d=0.3,afade=t=out:st=%.2f:d=1.5' % max(0, total - 1.5)
    if music:
        cmd += ['-stream_loop', '-1', '-i', music]
        fc = (vf + ';[0:a]asplit[s1][s2];'
              '[1:a]volume=0.30,aresample=48000,aformat=channel_layouts=stereo[m0];'
              '[m0][s2]sidechaincompress=threshold=0.02:ratio=6:attack=30:release=500[m];'
              '[s1][m]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-14:TP=-1.5,%s[a]' % fade)
    else:
        fc = vf + ';[0:a]loudnorm=I=-14:TP=-1.5,%s[a]' % fade
    cmd += ['-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-t', '%.3f' % total,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', '%dk' % kbps, '-bufsize', '%dk' % (kbps * 2),
            '-r', str(FPS), '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', out]
    run(cmd)
    thumb = os.path.join(work, 'thumb.jpg')
    run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '%.2f' % min(1.0, total / 2), '-i', out, '-frames:v', '1',
         '-vf', 'scale=320:-2', '-q:v', '4', thumb])
    return thumb


def make(src, out, note, transcript=None, style=''):
    opt = apply_tweaks(apply_style(parse_note(note), style), note)
    work = tempfile.mkdtemp(prefix='reels_')
    try:
        dur, has_audio = probe(src)
        if dur > MAX_SOURCE_SEC:
            raise Oops('影片超過 20 分鐘，請先剪短一點再傳。')
        segs = []
        if transcript is not None:
            segs = transcript
        elif has_audio:
            audio = os.path.join(work, 'audio.mp3')
            run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', audio])
            segs = transcribe(audio)
        speech = sum(len(s['text']) for s in segs) >= 4
        plan = plan_clips(segs, opt, note) if speech and os.environ.get('OPENAI_API_KEY') else None
        if speech and plan is None and transcript is not None:   # 本機測試：沒有 AI 就全部保留、英文留空
            plan = {'title': opt['title'] or '測試標題', 'post': '', 'tags': ['字幕', '剪輯', '動畫', '字卡'],
                    'pops': [{'i': i, 'text': s['pop']} for i, s in enumerate(segs) if s.get('pop')],
                    'keep': [{'i': i, 'lines': s.get('lines') or [{'zh': s['text'], 'en': s.get('en', '')}]}
                             for i, s in enumerate(segs)]}
        if plan and plan['keep']:
            spans = clips_from_plan(plan, segs, dur)
            if opt['jumpcut'] and has_audio:
                spans = drop_pauses(spans, silences(src)) or spans
        else:
            spans = clips_without_speech(dur, opt['target'])
            if plan is None and opt['title']:
                plan = {'title': opt['title'], 'keep': [], 'post': '', 'tags': [], 'pops': []}
        total = sum(b - a for a, b in spans)
        log('原片 %.1f 秒 → 剪成 %d 段、共 %.1f 秒' % (dur, len(spans), total))
        joined = cut(src, spans, has_audio, work)
        total = float(json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-of', 'json', joined]))['format']['duration'])
        ass = os.path.join(work, 'subs.ass')
        n = build_ass(plan, segs, spans, opt, total, ass)
        music = pick_music(opt)
        thumb = finish(joined, ass, music, total, out, work)
        if os.path.getsize(out) > TG_LIMIT:
            raise Oops('剪好的影片太大，傳不回 Telegram。請在說明寫短一點的秒數（例如「剪 Reels 30秒」）再試一次。')
        shutil.copy(thumb, out + '.jpg')
        return {'seconds': total, 'clips': len(spans), 'subs': n, 'music': os.path.basename(music or '')[:-4],
                'title': (plan or {}).get('title', ''), 'post': (plan or {}).get('post', '')}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input')
    ap.add_argument('--out', default='reels.mp4')
    ap.add_argument('--note', default=os.environ.get('NOTE', ''))
    ap.add_argument('--transcript')
    ap.add_argument('--style', default=os.environ.get('STYLE', ''))
    a = ap.parse_args()

    chat = os.environ.get('CHAT_ID')
    try:
        src = a.input
        if not src:
            src = os.path.join(tempfile.mkdtemp(), 'input.mp4')
            tg_download(os.environ['FILE_ID'], src)
        tr = json.load(open(a.transcript, encoding='utf-8')) if a.transcript else None
        info = make(src, a.out, a.note, tr, a.style)
        log('完成：%.1f 秒、%d 段、%d 則字幕' % (info['seconds'], info['clips'], info['subs']))   # repo 公開，紀錄不寫內容
        if chat:
            ver = os.environ.get('VERSION') or '1'
            cap = '🎬 第 %s 版試剪好了（%d 秒）' % (ver, round(info['seconds']))
            if info['title']:
                cap += '\n標題：' + info['title']
            cap += '\n' + '、'.join(x for x in ['直式 9:16',
                                                '中英字幕' if info['subs'] else '',
                                                '配樂「%s」' % info['music'] if info['music'] else ''] if x)
            cap += ('\n\n想改哪裡，長按這支影片按「回覆」直接說，例如：'
                    '\n・字幕大一點／放上面一點\n・開頭標題久一點\n・剪成 30 秒\n・換清新的配樂／不要配樂'
                    '\n也可以傳一張喜歡的影片截圖，說「我要這種風格」。')
            tg_send_video(chat, a.out, cap, a.out + '.jpg')
            if info['post']:
                tg('sendMessage', chat_id=chat, text='📝 貼文文案參考（長按可複製）：\n\n' + info['post'])
    except Oops as e:
        log('Oops:', e)
        if chat:
            tg('sendMessage', chat_id=chat, text='🎬 ' + str(e))
        sys.exit(1)
    except Exception as e:   # noqa: BLE001
        log('錯誤：', repr(e))
        if chat:
            tg('sendMessage', chat_id=chat, text='🎬 剪輯失敗了，請再傳一次影片試試；一直失敗的話跟系統大師說一聲。')
        raise


if __name__ == '__main__':
    main()
