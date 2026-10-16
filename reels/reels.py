"""小乖剪 Reels：把一段影片自動剪成直式 9:16 短影音，上中英字幕、配背景音樂。

在 GitHub Actions 上跑（.github/workflows/reels.yml），由小乖的 Apps Script 觸發：
  你在 Telegram 傳影片給小乖 → 小乖叫這支程式 → 剪好直接傳回 Telegram。

流程：
  1. 從 Telegram 下載影片
  2. 用 OpenAI 語音辨識拿到逐句文字與時間
  3. 讓 AI 挑精華句子、改成短句字幕（繁中＋英文）、想開頭標題、重點標籤、重點字卡和貼文文案
  4. ffmpeg 剪接並剪掉講話中間的停頓、轉成 1080×1920（橫的影片上下補模糊背景）、
     燒上字幕與動畫字卡（開頭打字標題、標籤一個個打勾、重點跳出來）、混入配樂（有人說話時音樂自動變小）
     特效由 AI 看每支影片的內容和氣氛自己挑：調色、字幕動畫，口播每句的推近／慢推／震動／閃白，靜音的運鏡和轉場
  5. 傳回 Telegram，當作「第 N 版試剪」；你回覆「改 …」就照你說的再剪一版

風格：你傳一張喜歡的影片截圖給小乖，小乖記下字幕顏色、大小、位置（STYLE），之後都照這個剪。
教學框（2026-10-16 照使用者給的兩支教學影片）：說明寫「教學框」或有「教學」→ 綠底、畫面縮在中間圓角框、上方黑底標題框、
右上名牌、左上 ①②③ 段落小標、開頭大標題、結尾多 3 秒「重點整理」（build_frame_ass、frame_setup）。

需要的環境變數：TELEGRAM_BOT_TOKEN、OPENAI_API_KEY、CHAT_ID、FILE_ID；NOTE 是你寫在影片上的說明和修改要求（可空白）；
STYLE 是從截圖學到的風格（JSON，可空白）；VERSION 是第幾版；
MODE 是剪法：reels（預設，直式 9:16 挑精華、最長 90 秒）或 long（剪大片：保留原本橫直、不限長度，只剪掉停頓和口誤）；
MUSIC_FILE 是你在 Telegram 傳給小乖的配樂（音樂檔編號，可空白，空白就從 reels/music/ 挑一首）。
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
MODE = 'reels'   # reels 直式短影音；long 剪大片（保留原本比例），由 make() 設定
FRAME = None     # 教學框：(框寬, 框高, 左, 上, 底圖 png)，由 make() 設定；None 是滿版
OUTRO = 3.0      # 教學框結尾「重點整理」停留秒數
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


def resolve_font():
    """確認中文字型真的裝好；找不到指定的字型就換一個系統裡有的繁中字型，免得字幕變成空白或方塊。"""
    global FONT
    try:
        fams = subprocess.run(['fc-list', ':lang=zh-tw', 'family'], capture_output=True, text=True).stdout
    except OSError:
        return
    names = [n.strip().replace('\\', '') for line in fams.splitlines() for n in line.split(',') if n.strip()]
    if FONT in names:
        log('字型：', FONT)
        return
    pick = next((n for n in names if 'TC' in n), names[0] if names else '')
    if pick:
        log('字型：找不到 %s，改用 %s' % (FONT, pick))
        FONT = pick
    else:
        log('⚠️ 找不到中文字型，字幕可能顯示不出來')


def frame_gray(path, t, work, name):
    raw = os.path.join(work, name + '.gray')
    run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '%.2f' % t, '-i', path, '-frames:v', '1',
         '-vf', 'scale=180:320,format=gray', '-f', 'rawvideo', raw])
    with open(raw, 'rb') as f:
        return f.read()


def subs_check(joined, out, ass, work):
    """剪好後檢查字幕真的有畫上去：比對同一個時間點、有字幕和沒字幕的畫面。回傳差異值（越大越明顯）。"""
    t = None
    with open(ass, encoding='utf-8') as f:
        for line in f:
            if ',Sub,' in line or ',Cap,' in line or ',Head,' in line:
                a, b = line.split(',')[1:3]
                sec = lambda x: sum(float(v) * m for v, m in zip(x.split(':'), (3600, 60, 1)))
                t = (sec(a) + sec(b)) / 2
                break
    if t is None:
        return None
    x, y = frame_gray(joined, t, work, 'a'), frame_gray(out, t, work, 'b')
    n = min(len(x), len(y))
    return sum(abs(x[i] - y[i]) for i in range(n)) / max(n, 1)


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
    'mode': 'reels',        # reels 剪 Reels；long 剪大片
    'kind': 'auto',         # talk 口播（有人講話）；silent 靜音（沒講話：配樂卡點＋轉場＋文字動畫）；auto 自動判斷
    'bar': True,            # 上方進度條
    'fx': True,             # 特效：口播的推近鏡頭、靜音的運鏡和轉場、調色、字幕彈跳發光
    'sfx': True,            # 音效：打字聲、字卡「啵」、重點「叮」、轉場「咻」
    'layout': 'full',       # full 滿版；frame 教學框（綠底、畫面縮在中間圓角框、上方黑底標題框、右上名牌、結尾重點整理）
    'tag': '彥彬｜生活筆記',  # 教學框右上角的名牌
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
    for k in ('music', 'jumpcut', 'cards', 'sub_box', 'bar', 'fx', 'sfx'):
        opt[k] = bool(opt.get(k))
    if opt.get('kind') not in ('talk', 'silent'):
        opt['kind'] = 'auto'
    if opt.get('mode') != 'long':
        opt['mode'] = 'reels'
    if opt.get('layout') != 'frame' or opt['mode'] == 'long':
        opt['layout'] = 'full'
    opt['tag'] = str(opt.get('tag') or '')[:16]
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
target 秒數(10-90)、music 要不要配樂(true/false)、mood 配樂（只能填這些名稱之一：{moods}）、
subs 字幕(both 中英/zh 只要中文/en 只要英文/none 不要)、title 開頭標題文字、title_sec 標題停留秒數(1.5-8，
「久一點」在目前值 {title_sec} 加 1.5)、jumpcut 剪掉停頓(true/false)、cards 動畫字卡(true/false)、
sub_size 字幕大小倍數(目前 {sub_size}，「大一點」×1.2、「小一點」×0.85)、
sub_pos 字幕位置(bottom/lower/middle/upper)、sub_color 字幕顏色(#RRGGBB)、sub_box 字幕底色框(true/false)、
accent 標籤與字卡顏色(#RRGGBB)、layout 版面(full 滿版／frame 教學框：綠底、畫面縮在中間的圓角框、上方黑底標題)、
tag 教學框右上角名牌文字。另外把無法用設定表達、要給剪輯師參考的要求寫進 wish（一句話，沒有就空字串）。
只回 JSON，例如 {{"sub_size": 1.2, "title_sec": 5, "wish": ""}}'''


def apply_tweaks(opt, note):
    """說明或「改 …」的要求，交給 AI 轉成設定（有金鑰、而且說明不只是基本關鍵字時才問）。"""
    rest = re.sub(r'剪\s*reels|reels|\d+\s*(秒|分鐘?)|標題[：:\s]*\S+|[\s，,。；;、]', '', note or '', flags=re.I)
    if not rest or not os.environ.get('OPENAI_API_KEY'):
        return opt
    try:
        tw = ask_ai(TWEAK_PROMPT.format(title_sec=opt['title_sec'], sub_size=opt['sub_size'],
                                        moods='／'.join(music_names()) or '（無）'), note)
    except Oops:
        return opt
    for k, v in tw.items():
        if k in DEFAULTS and k not in ('mode', 'kind') and v not in (None, ''):
            opt[k] = v
    opt['wish'] = str(tw.get('wish') or '')[:200]
    return clamp_opt(opt)


def parse_note(note, mode='reels', kind='auto'):
    note = note or ''
    opt = dict(DEFAULTS)
    opt['kind'] = 'silent' if re.search(r'靜音', note) else 'talk' if re.search(r'口播', note) else kind
    if re.search(r'(不要|無|沒有|免|關掉?)\s*進度條', note):
        opt['bar'] = False
    if re.search(r'(不要|無|沒有|免|關掉?)\s*(特效|轉場|運鏡)', note):
        opt['fx'] = False
    opt['mode'] = 'long' if mode == 'long' or re.search(r'剪\s*大片|大片', note) else 'reels'
    if re.search(r'教學|錄螢幕|螢幕錄影|手機畫面', note) and not re.search(r'(不要|取消|關掉?)\s*(教學)?框', note):
        opt['layout'] = 'frame'   # 參考使用者 2026-10-16 給的兩支教學影片剪法
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
    if re.search(r'(不要|無|沒有|免|關掉?)\s*音效', note):
        opt['sfx'] = False
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


def tg_download(file_id, dest, what='影片'):
    info = tg('getFile', file_id=file_id)
    if not info.get('ok'):
        if what != '影片':
            raise Oops('拿不到你傳的%s（%s），這次先用小乖的配樂。' % (what, info.get('description', '')))
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


def ask_ai(system, user, images=None):
    if images:   # 附上影片畫面（base64 jpg）讓 AI 看
        user = [{'type': 'text', 'text': user}] + [
            {'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,' + b, 'detail': 'low'}} for b in images]
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


RULE_REELS = '''1. 挑出要保留的句子，總長不超過 {target} 秒（原片比較短就全部留，只刪口誤、重複、無意義的句子）。
   要挑最吸引人、意思完整、前後接得起來的段落，第一句最好能抓住注意力。保留的句子照原本順序。'''
RULE_LONG = '''1. 這是完整的長影片（剪大片）：保留全部句子，只刪掉口誤、講錯重講、重複和沒有意義的句子，不要刪內容，照原本順序。'''
PLAN_PROMPT = '''你是影片剪輯師，幫一位台灣的直銷事業經營者剪影片。
會給你影片逐句辨識結果（i 是編號，秒數是時間），和使用者的說明。請：
{rule}
2. 每一句改成字幕：繁體中文（台灣用語），依上下文修正辨識錯字，句尾不加標點；
   拆成短句，一行 6～12 個字、照說話的停頓斷句（像抖音、Reels 那種一句一句跳出來的字幕）。
   每行附上自然口語的英文翻譯；中文每行可以用 ** 標出最多一個重點詞（例如「每天**三分鐘**」），不是每行都要標。
3. 想一個 12 個字以內、像在跟 AI 下指令或抓住注意力的開頭標題（使用者說明裡有指定標題就用那個）。
4. 挑 3～4 個影片重點標籤，每個 2～4 個字（例如：字幕、剪輯、動畫、字卡）。
5. 挑 1～3 句最重要的話做重點字卡：給那句的 i 和 10 個字以內的重點。
6. 寫一段 IG 貼文文案（3～5 行，繁體中文，結尾 5 個 hashtag）。
7. 依影片內容和氣氛，從這些配樂挑最適合的一首，只寫名稱：{moods}
8. 看這支影片的內容和氣氛，自己決定動畫和特效（每支影片要不一樣，配合內容，不要亂加）：
{fx_menu}
   keep 每句另外給 fx，只有重點、情緒高、轉折的句子才加（大約三分之一的句子），其他給空字串：
   zoom 推近鏡頭（強調）／push 慢慢推近（娓娓道來、感動）／shake 震動（驚訝、超重要）／flash 閃白（換話題、轉折）。
9. 把保留的句子依內容分成 2～5 個段落（像教學影片的「第一步、第二步」），每段給開始那句的 i 和 4～8 個字的小標 name（不用寫編號）。
{wish}只回 JSON：{{"title": "", "tags": [""], "keep": [{{"i": 0, "fx": "", "lines": [{{"zh": "", "en": ""}}]}}], "pops": [{{"i": 0, "text": ""}}], "music": "", "look": "", "sub_anim": "", "sections": [{{"i": 0, "name": ""}}], "post": ""}}'''

FX_MENU = '''   look 調色，挑一個：clean 自然清爽／warm 溫暖（生活、感恩、家人）／cool 冷調（專業、科技）／vivid 鮮豔（活力、促銷）／film 電影感（故事、見證）／soft 柔和（療癒、女性、保養）
   sub_anim 字幕跳出方式，挑一個：pop 彈出來／slide 往上滑進來／wipe 由左往右刷出來／bounce 壓扁再彈起來'''
LOOKS = {   # 調色
    'clean': 'eq=contrast=1.06:saturation=1.12',
    'warm': 'eq=contrast=1.05:saturation=1.15,colorbalance=rs=.06:gs=.02:bs=-.06',
    'cool': 'eq=contrast=1.06:saturation=1.05,colorbalance=rs=-.05:bs=.07',
    'vivid': 'eq=contrast=1.12:saturation=1.35',
    'film': 'eq=contrast=1.08:saturation=.88,colorbalance=rs=.03:bs=-.03,vignette=PI/5',
    'soft': 'eq=brightness=.03:contrast=.95:saturation=1.05',
}
LOOK_NAME = {'clean': '自然', 'warm': '溫暖', 'cool': '冷調', 'vivid': '鮮豔', 'film': '電影感', 'soft': '柔和'}
SUB_ANIMS = {'pop': '彈出', 'slide': '上滑', 'wipe': '刷出', 'bounce': '彈跳'}
SHOT_FX = {'zoom': '推近', 'push': '慢推', 'shake': '震動', 'flash': '閃白'}


def pick(v, allowed, default=''):
    v = str(v or '').strip().lower()
    return v if v in allowed else default


def plan_clips(segs, opt, note):
    if not segs:
        return None
    lines = '\n'.join('i=%d [%.1f-%.1f] %s' % (i, s['start'], s['end'], s['text']) for i, s in enumerate(segs))
    wish = '使用者另外的要求：%s\n' % opt['wish'] if opt.get('wish') else ''
    rule = (RULE_LONG if opt['mode'] == 'long' else RULE_REELS).format(target=opt['target'])
    plan = ask_ai(PLAN_PROMPT.format(rule=rule, wish=wish, moods='／'.join(music_names()) or '（無）', fx_menu=FX_MENU),
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
        keep.append({'i': i, 'fx': pick(k.get('fx'), SHOT_FX), 'lines': ls or [{'zh': segs[i]['text'], 'en': ''}]})
    keep.sort(key=lambda k: k['i'])
    tags = [str(t).strip()[:5] for t in (plan.get('tags') or []) if str(t).strip()][:4]
    pops = []
    for pp in plan.get('pops') or []:
        try:
            if int(pp.get('i')) in seen and str(pp.get('text') or '').strip():
                pops.append({'i': int(pp['i']), 'text': str(pp['text']).strip()[:12]})
        except (TypeError, ValueError, AttributeError):
            continue
    secs = []   # 段落小標（教學框左上角的「① 小標」）
    for x in plan.get('sections') or []:
        try:
            i, name = int(x.get('i')), str(x.get('name') or '').strip()[:10]
        except (TypeError, ValueError, AttributeError):
            continue
        j = min((k['i'] for k in keep if k['i'] >= i), default=None)
        if name and j is not None and j not in [y['i'] for y in secs]:
            secs.append({'i': j, 'name': name})
    secs.sort(key=lambda x: x['i'])
    return {'title': opt['title'] or (plan.get('title') or '').strip()[:16], 'keep': keep, 'tags': tags, 'sections': secs[:5],
            'pops': pops[:3], 'post': (plan.get('post') or '').strip(), 'music': str(plan.get('music') or '').strip(),
            'look': pick(plan.get('look'), LOOKS, 'clean'), 'sub_anim': pick(plan.get('sub_anim'), SUB_ANIMS, 'pop')}


# ---------------- 影片處理 ----------------
def probe(path):
    out = json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]))
    dur = float(out['format'].get('duration') or 0)
    has_audio = any(s.get('codec_type') == 'audio' for s in out['streams'])
    vs = [s for s in out['streams'] if s.get('codec_type') == 'video']
    if not vs:
        raise Oops('這個檔案裡沒有影片畫面。')
    w, h = int(vs[0].get('width') or 1920), int(vs[0].get('height') or 1080)
    rot = int(float((vs[0].get('tags') or {}).get('rotate') or 0))
    for sd in vs[0].get('side_data_list') or []:
        if 'rotation' in sd:
            rot = int(float(sd['rotation']))
    if abs(rot) % 180 == 90:   # 手機直拍的影片常常是橫的畫面加「轉 90 度」標記
        w, h = h, w
    return dur, has_audio, (w, h)


def join_sources(paths, work):
    """好幾支影片：照順序統一大小、影格和聲音後接成一支，後面就當一支影片來剪。"""
    info = [probe(p) for p in paths]
    w, h = info[0][2]
    k = min(1.0, 1920 / max(w, h))
    w, h = max(2, int(w * k) // 2 * 2), max(2, int(h * k) // 2 * 2)
    parts = []
    for n, (p, (dur, has_audio, _)) in enumerate(zip(paths, info)):
        out = os.path.join(work, 'src%02d.mp4' % n)
        cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', p]
        if not has_audio:
            cmd += ['-f', 'lavfi', '-t', '%.3f' % dur, '-i', 'anullsrc=r=48000:cl=stereo']
        cmd += ['-vf', 'scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=%d,format=yuv420p'
                % (w, h, w, h, FPS), '-map', '0:v:0', '-map', '0:a:0' if has_audio else '1:a',
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
                '-b:a', '192k', '-shortest', out]
        run(cmd)
        parts.append(out)
    lst = os.path.join(work, 'sources.txt')
    with open(lst, 'w') as f:
        f.writelines("file '%s'\n" % x for x in parts)
    joined = os.path.join(work, 'source.mp4')
    run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', joined])
    log('接好 %d 支影片' % len(paths))
    return joined


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


def frame_setup(src_wh, work):
    """教學框（參考使用者 2026-10-16 給的影片）：綠色漸層底、畫面縮在中間的圓角框（帶陰影），上面留標題框的位置。
    先用 ffmpeg 畫一張底圖：漸層＋陰影，框的位置挖空（透明），剪接時影片墊在下面、底圖蓋上去。"""
    w, h = src_wh
    k = min(880 / w, 1400 / h)
    cw, ch = int(w * k) // 2 * 2, int(h * k) // 2 * 2
    x = (W - cw) // 2
    y = max(330, (H - ch) // 2 + 60) if ch < 1300 else 330
    r = 42
    hole = ("geq=lum='255*lte(hypot(max(max(%d-(X-%d),(X-%d)-%d),0),max(max(%d-(Y-%d),(Y-%d)-%d),0)),%d)'"
            % (r, x, x, cw - 1 - r, r, y, y, ch - 1 - r, r))
    sh = hole.replace('(Y-%d)' % y, '(Y-%d)' % (y + 18))   # 陰影往下一點
    png = os.path.join(work, 'frame.png')
    fc = ('gradients=s=%dx%d:c0=0x4C9C74:c1=0x23573F:x0=0:y0=0:x1=%d:y1=%d:n=2,format=rgba,trim=end_frame=1[g];'
          'color=black:s=%dx%d,format=gray,%s,boxblur=26:2,lut=y=val*0.5[sa];'
          'color=black:s=%dx%d,format=rgba[blk];[blk][sa]alphamerge[shadow];[g][shadow]overlay=format=auto[gs];'
          'color=black:s=%dx%d,format=gray,%s,negate[ha];[gs][ha]alphamerge[out]'
          % (W, H, W, H, W, H, sh, W, H, W, H, hole))
    run(['ffmpeg', '-y', '-loglevel', 'error', '-filter_complex', fc, '-map', '[out]', '-frames:v', '1', png])
    return cw, ch, x, y, png


def vf(zoom=1.0, move='', L=0, p=(0, 1), zp=''):
    """把畫面轉成輸出大小；zoom > 1 是推近鏡頭（口播剪接時一段近、一段遠，像爆款影片的跳剪）。
    move：push 這句慢慢推近（p 是這段在整句的位置，剪掉停頓後鏡頭也連續）、shake 開頭震一下（AI 依每句內容挑）。"""
    z = '' if zoom <= 1 else ',scale=%d:%d,crop=%d:%d' % (int(W * zoom) // 2 * 2, int(H * zoom) // 2 * 2, W, H)
    if move == 'push' and L > 0:
        z += ",zoompan=z='1+0.10*(%.3f+%.3f*on/%d)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=%dx%d:fps=%d" % (
            p[0], p[1] - p[0], max(1, int(L * FPS)), W, H, FPS)
    elif move == 'shake':
        z += (",scale=%d:%d,crop=%d:%d:x='(iw-ow)/2+if(lt(t,0.7),%d*sin(t*47),0)':y='(ih-oh)/2+if(lt(t,0.7),%d*cos(t*53),0)'"
              % (int(W * 1.08) // 2 * 2, int(H * 1.08) // 2 * 2, W, H, max(4, W // 60), max(4, H // 90)))
    if FRAME:   # 教學框：影片放進中間的圓角框（推近只在框裡面推；zp 是靜音剪的運鏡）
        cw, ch, x, y, png = FRAME
        inner = ',scale=%d:%d,crop=%d:%d' % (int(cw * zoom) // 2 * 2, int(ch * zoom) // 2 * 2, cw, ch) if zoom > 1 else ''
        if zp:
            inner += ',zoompan=%s:d=1:s=%dx%d:fps=%d' % (zp, cw, ch, FPS)
        return ("[0:v]fps=%d,scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,setsar=1%s,pad=%d:%d:%d:%d:color=0x1C4A35[fg];"
                "movie='%s',loop=loop=-1:size=1[fr];[fg][fr]overlay=0:0:shortest=1,setsar=1,format=yuv420p[v]"
                % (FPS, cw, ch, cw, ch, inner, W, H, x, y, png))
    if MODE == 'long':   # 剪大片：保留原本的畫面比例
        return '[0:v]fps=%d,scale=%d:%d,setsar=1%s,format=yuv420p[v]' % (FPS, W, H, z)
    return ('[0:v]fps=%d,split[a][b];'
            '[a]scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,boxblur=30:3,eq=brightness=-0.08[bg];'
            '[b]scale=%d:%d:force_original_aspect_ratio=decrease[fg];'
            '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1%s,format=yuv420p[v]') % (FPS, W, H, W, H, W, H, z)


# ---------------- 靜音剪：配樂卡點、運鏡、轉場 ----------------
SILENT_PROMPT = '''你是爆款短影音剪輯師，幫一位台灣的直銷事業經營者把「沒有人講話」的影片剪成短影音（像萬人按讚的那種）。
會給你影片裡的幾張畫面和使用者說明。請：
1. 想一個 12 個字以內、抓住注意力的開頭標題（說明裡有指定標題就用那個）。
2. 依畫面內容和說明，寫 {n} 句畫面字幕，每句 6～14 個字，照影片順序、像在說一個小故事、有節奏感；
   每句用 ** 標出一個重點詞（例如「每天 **3 分鐘**」），並附上自然口語的英文翻譯（en，不用標 **）。
3. 結尾一句行動呼籲，12 個字以內（例如「想知道更多 **留言** 告訴我」）。
4. 3～4 個重點標籤，每個 2～4 個字。
5. 依畫面氣氛，從這些配樂挑最適合的一首，只寫名稱：{moods}
6. 一段 IG 貼文文案（3～5 行，繁體中文，結尾 5 個 hashtag）。
7. 看畫面內容和氣氛，自己決定動畫和特效（每支影片要不一樣，配合畫面）：
{fx_menu}
   moves 每段運鏡，照順序給 4～8 個：in 推近／out 拉遠／right 往右移／left 往左移／up 往上移／down 往下移／shake 震動
   trans 段落之間的轉場，照順序給 3～8 個：{trans}
不可以寫療效、治療、收入或業績保證；「私訊」一律改說「留言」。繁體中文（台灣用語）。
{wish}只回 JSON：{{"title": "", "caps": [{{"zh": "", "en": ""}}], "cta": "", "tags": [""], "music": "", "look": "", "sub_anim": "", "moves": [""], "trans": [""], "post": ""}}'''

MUSIC_BPM = {'陽光吉他': 106, '輕快生活': 88, '浪漫鋼琴': 93, '療癒琴聲': 80, '活力節奏': 131,
             '大氣史詩': 68, '禪意東方': 57, '感動希望': 70, '清新午後': 68}
FX_ZOOM = ['in', 'out', 'right', 'up']   # AI 沒挑時每段輪流：推近、拉遠、往右移、往上移
FX_MOVES = FX_ZOOM + ['left', 'down', 'shake']
FX_XFADE = ['fadewhite', 'slideleft', 'zoomin', 'smoothup', 'circleopen', 'wipeleft', 'hblur', 'radial']   # AI 沒挑時輪流用
TRANS = {'fadewhite': '閃白', 'fadeblack': '黑場', 'slideleft': '左滑', 'slideup': '上滑', 'smoothup': '柔滑',
         'zoomin': '放大', 'circleopen': '圓形展開', 'circlecrop': '圓形收合', 'wipeleft': '擦去', 'hblur': '模糊',
         'radial': '旋轉', 'pixelize': '馬賽克', 'dissolve': '溶解', 'squeezeh': '擠壓', 'diagtl': '斜切'}
XF = .3   # 轉場秒數


def frames_b64(src, dur, work, n=4):
    import base64
    out = []
    for i in range(n):
        p = os.path.join(work, 'peek%d.jpg' % i)
        run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '%.2f' % (dur * (i + .5) / n), '-i', src, '-frames:v', '1',
             '-vf', 'scale=384:-2', '-q:v', '5', p])
        with open(p, 'rb') as f:
            out.append(base64.b64encode(f.read()).decode())
    return out


def cap_line(x, fix=lambda v: str(v or '').strip()):
    """畫面字幕一句：{'zh': 中文, 'en': 英文}（AI 可能只給字串）。"""
    if isinstance(x, dict):
        return {'zh': fix(x.get('zh'))[:22], 'en': fix(x.get('en')).replace('**', '')[:60]}
    return {'zh': fix(x)[:22], 'en': ''}


def silent_plan(src, dur, opt, note, work, n_caps):
    base = {'title': opt['title'], 'caps': [], 'cta': '', 'tags': [], 'music': '', 'post': '', 'keep': [], 'pops': [],
            'look': 'clean', 'sub_anim': '', 'moves': [], 'trans': []}
    if not os.environ.get('OPENAI_API_KEY'):
        return base
    wish = '使用者另外的要求：%s\n' % opt['wish'] if opt.get('wish') else ''
    p = ask_ai(SILENT_PROMPT.format(n=n_caps, moods='／'.join(music_names()) or '（無）', wish=wish, fx_menu=FX_MENU,
                                    trans='／'.join('%s %s' % kv for kv in TRANS.items())),
               '使用者說明：%s' % (note or '（無）'), frames_b64(src, dur, work))
    fix = lambda v: str(v or '').replace('私訊', '留言').strip()
    base.update({'title': opt['title'] or fix(p.get('title'))[:16], 'cta': fix(p.get('cta'))[:20],
                 'caps': [c for c in (cap_line(x, fix) for x in (p.get('caps') or [])) if c['zh']][:n_caps],
                 'tags': [fix(t)[:5] for t in (p.get('tags') or []) if fix(t)][:4],
                 'music': fix(p.get('music')), 'post': fix(p.get('post'))})
    base.update(silent_fx(p))
    return base


def silent_fx(p):
    """靜音剪的特效選擇（AI 給的，不在清單裡的丟掉）。"""
    return {'look': pick(p.get('look'), LOOKS, 'clean'), 'sub_anim': pick(p.get('sub_anim'), SUB_ANIMS, ''),
            'moves': [m for m in (pick(x, FX_MOVES) for x in (p.get('moves') or [])) if m][:8],
            'trans': [t for t in (pick(x, TRANS) for x in (p.get('trans') or [])) if t][:8]}


def scenes(src):
    """找出畫面切換的時間點（換場景）。"""
    p = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', src, '-an', '-vf',
                        "scale=320:-2,select='gt(scene,0.3)',showinfo", '-f', 'null', '-'], capture_output=True, text=True)
    return [float(m) for m in re.findall(r'pts_time:([\d.]+)', p.stderr)]


def silent_spans(src, dur, target, beat):
    """跟著配樂節拍切：每段 4 拍；優先從換場景的地方開始，平均分布在整支影片。"""
    L = max(1.5, min(4.5, 4 * beat))
    n = max(1, int(round(min(target, dur) / L)))
    if dur <= n * L + .5:   # 影片不長：從頭照順序切
        k = max(1, int(dur // L))
        return [[i * L, min(dur, (i + 1) * L)] for i in range(k)] if k > 1 else [[0, dur]]
    cands = sorted(set([0.0] + [t for t in scenes(src) if t < dur - L]))
    if len(cands) < n:
        cands = sorted(set(cands + [i * (dur - L) / max(1, n - 1) for i in range(n)]))
    pick = [cands[int(i * (len(cands) - 1) / max(1, n - 1))] for i in range(n)] if n > 1 else [cands[0]]
    spans, last = [], -1
    for st in sorted(pick):
        st = max(st, last)
        if st + L > dur:
            break
        spans.append([st, st + L])
        last = st + L
    return spans or [[0, min(dur, L)]]


def montage(src, spans, work, fx=True, moves=None, trans=None):
    """靜音剪：每段加運鏡（推近、拉遠、平移），段跟段之間用轉場，轉場時加「咻」的音效。回傳（成品, 每段在成品的開始秒數）。"""
    parts, lens = [], []
    for n, (a, b) in enumerate(spans):
        L = b - a
        N = max(1, int(L * FPS))
        e = (moves or FX_ZOOM)[n % len(moves or FX_ZOOM)]
        zp = {'in': "z='1+0.12*on/%d':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2'" % N,
              'out': "z='1.12-0.12*on/%d':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2'" % N,
              'right': "z='1.12':x='(iw-iw/zoom)*on/%d':y='ih/2-ih/zoom/2'" % N,
              'up': "z='1.12':x='iw/2-iw/zoom/2':y='(ih-ih/zoom)*(1-on/%d)'" % N,
              'left': "z='1.12':x='(iw-iw/zoom)*(1-on/%d)':y='ih/2-ih/zoom/2'" % N,
              'down': "z='1.12':x='iw/2-iw/zoom/2':y='(ih-ih/zoom)*on/%d'" % N,
              'shake': "z='1.08':x='iw/2-iw/zoom/2+%d*sin(on*1.6)':y='ih/2-ih/zoom/2+%d*cos(on*1.9)'" % (max(4, W // 70), max(4, H // 110))}.get(e)
        zp = zp or "z='1+0.12*on/%d':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2'" % N
        if FRAME:   # 教學框：運鏡只動框裡的畫面
            chain = vf(zp=zp if fx else '') + ';[v]null[w]'
        else:
            chain = vf() + (';[v]zoompan=%s:d=1:s=%dx%d:fps=%d,setsar=1[w]' % (zp, W, H, FPS) if fx else ';[v]null[w]')
        out = os.path.join(work, 'm%03d.mp4' % n)
        run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '%.3f' % a, '-t', '%.3f' % L, '-i', src,
             '-filter_complex', chain, '-map', '[w]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
             '-r', str(FPS), out])
        parts.append(out)
        lens.append(float(json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-of', 'json', out]))['format']['duration']))
    xf = XF if fx and len(parts) > 1 and min(lens) > XF * 2.5 else 0
    starts, t = [], 0.0
    for L in lens:
        starts.append(t)
        t += L - xf
    total = t + xf
    joined = os.path.join(work, 'montage.mp4')
    cmd = ['ffmpeg', '-y', '-loglevel', 'error']
    for p in parts:
        cmd += ['-i', p]
    if xf:
        fc, prev = [], '0:v'
        for i in range(1, len(parts)):
            fc.append('[%s][%d:v]xfade=transition=%s:duration=%.2f:offset=%.3f[x%d]' % (
                prev, i, (trans or FX_XFADE)[(i - 1) % len(trans or FX_XFADE)], xf, starts[i], i))
            prev = 'x%d' % i
        vmap = '[%s]' % prev
    else:
        fc = ['%sconcat=n=%d:v=1:a=0[x0]' % (''.join('[%d:v]' % i for i in range(len(parts))), len(parts))]
        vmap = '[x0]'
    # 聲音：靜音底（轉場的「咻」由 finish 的音效軌加）
    na = len(parts)
    cmd += ['-f', 'lavfi', '-t', '%.3f' % total, '-i', 'anullsrc=r=48000:cl=stereo']
    fc.append('[%d:a]anull[a]' % na)
    cmd += ['-filter_complex', ';'.join(fc), '-map', vmap, '-map', '[a]', '-t', '%.3f' % total,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', str(FPS), '-c:a', 'aac', '-ar', '48000', joined]
    run(cmd)
    return joined, starts


def long_size(src_wh, est_sec):
    """大片的輸出大小：長邊最多 1920；影片很長時縮小一點，才傳得回 Telegram（50MB）。"""
    w, h = src_wh
    kbps = (TG_LIMIT * 8 / 1000) / max(est_sec, 1) - 200
    side = 1920 if kbps >= 2500 else 1280 if kbps >= 1000 else 854
    k = min(1.0, side / max(w, h))
    return max(2, int(w * k) // 2 * 2), max(2, int(h * k) // 2 * 2)


def span_shots(spans, plan, segs):
    """每段剪輯區間的鏡頭特效：看這段屬於哪一句，用 AI 給那句的 fx。回傳 [(特效, 這段在整句的開始比例, 結束比例)]。"""
    out = []
    for a, b in spans:
        mid, shot = (a + b) / 2, ('', 0, 1)
        for kp in (plan or {}).get('keep') or []:
            s = segs[kp['i']]
            s0, s1 = s['start'] - .15, s['end'] + .25
            if s0 - .2 <= mid <= s1 + .2:
                fx, k = kp.get('fx') or '', max(.1, s1 - s0)
                p0, p1 = min(1, max(0, (a - s0) / k)), min(1, max(0, (b - s0) / k))
                if fx == 'shake' and p0 > .1:   # 震動只在這句一開始
                    fx = ''
                shot = (fx if fx in ('zoom', 'push', 'shake') else '', p0, max(p0, p1))
                break
        out.append(shot)
    return out


def cut(src, spans, has_audio, work, punch=False, shots=None):
    parts, near = [], False
    for n, (a, b) in enumerate(spans):
        shot = shots[n] if shots and n < len(shots) else ('', 0, 1)
        move = shot[0] if punch else ''
        if shots and punch:   # AI 有挑特效：照每句挑的；沒挑的句子不推近
            near = move == 'zoom'
            move = '' if move == 'zoom' else move
        elif punch and n and b - a >= 1.5:   # 夠長的段落才換鏡頭，太碎會晃
            near = not near
        zoom = 1.12 if punch and near else 1.0
        out = os.path.join(work, 'part%03d.mp4' % n)
        cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-ss', '%.3f' % a, '-t', '%.3f' % (b - a), '-i', src]
        if not has_audio:
            cmd += ['-f', 'lavfi', '-t', '%.3f' % (b - a), '-i', 'anullsrc=r=48000:cl=stereo']
        cmd += ['-filter_complex', vf(zoom, move, b - a, shot[1:]), '-map', '[v]', '-map', '0:a:0' if has_audio else '1:a',
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


def sub_anim(kind, x, y, extra='', an=2):
    """字幕跳出來的動畫（x, y 是字幕位置）：pop 彈出／slide 往上滑／wipe 由左刷出／bounce 壓扁再彈起來。"""
    if kind == 'slide':
        return '{\\an%d\\move(%d,%d,%d,%d,0,200)\\fad(100,0)%s}' % (an, x, y + max(30, H // 30), x, y, extra)
    if kind == 'wipe':
        return '{\\an%d\\pos(%d,%d)\\clip(0,0,0,%d)\\t(0,260,\\clip(0,0,%d,%d))%s}' % (an, x, y, H, W, H, extra)
    if kind == 'bounce':
        return ('{\\an%d\\pos(%d,%d)\\fscx125\\fscy65\\t(0,90,\\fscx92\\fscy115)\\t(90,170,\\fscx104\\fscy96)'
                '\\t(170,240,\\fscx100\\fscy100)\\fad(40,0)%s}' % (an, x, y, extra))
    return '{\\an%d\\pos(%d,%d)\\fad(60,0)\\fscx86\\fscy86\\t(0,110,\\fscx105\\fscy105)\\t(110,190,\\fscx100\\fscy100)%s}' % (an, x, y, extra)


LAND_Y = {'bottom': .06, 'lower': .09, 'middle': .40, 'upper': .72}   # 橫的大片：字幕底邊離下面的比例


SFX = []   # 音效時間點：(秒, 種類)，build_ass 填、finish 混進聲音


def rbox(w, h, r):
    """圓角矩形的 ASS 繪圖路徑（左上角是 0,0）。"""
    r = min(r, w // 2, h // 2)
    return ('m %d 0 l %d 0 b %d 0 %d 0 %d %d l %d %d b %d %d %d %d %d %d l %d %d b 0 %d 0 %d 0 %d l 0 %d b 0 0 0 0 %d 0'
            % (r, w - r, w, w, w, r, w, h - r, w, h, w, h, w - r, h, r, h, h, h, h - r, r, r))


def wrap2(t, n=13):
    """標題框的字：超過 n 個字就拆成兩行（盡量在標點後面斷），** 重點標記不算字數。"""
    vis = t.replace('**', '')
    if len(vis) <= n:
        return [t]
    cut = len(vis) // 2
    for d in range(0, len(vis) // 2):
        for c in (cut + d, cut - d):
            if 0 < c < len(vis) and vis[c - 1] in '，、。！？：；,!? ':
                cut = c
                break
        else:
            continue
        break
    i = k = 0   # 換算回含 ** 的位置；斷在重點詞中間就把 ** 補齊
    while k < cut:
        if t.startswith('**', i):
            i += 2
            continue
        i += 1
        k += 1
    a, b = t[:i], t[i:]
    if a.count('**') % 2:
        a, b = a + '**', '**' + b
    return [a.strip(), b.strip()]


def build_frame_ass(plan, segs, spans, opt, total, path):
    """教學框的字：右上名牌、上方黑底圓角標題框（重點詞亮色）、開頭大標題、重點字卡、結尾重點整理。"""
    cw, ch, fx0, fy, _ = FRAME
    acc = ass_color(opt['accent'])
    c_ = lambda hexc: ass_color(hexc).replace('&H00', '&H') + '&'   # #RRGGBB → 繪圖用的 &HBBGGRR&
    white = '&H00FFFFFF'
    k = opt['sub_size']
    head = '\n'.join([
        '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: %d' % W, 'PlayResY: %d' % H, 'WrapStyle: 2',
        'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, '
        'Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, '
        'MarginR, MarginV, Encoding',
        'Style: Head,%s,%d,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,2,0,1,0,0,2,0,0,0,1' % (FONT, int(66 * k)),
        'Style: Cap,%s,%d,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,2,0,1,0,0,2,0,0,0,1' % (FONT, int(66 * k)),
        'Style: Draw,%s,20,&H00141414,&H00141414,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1' % FONT,
        'Style: Big,%s,96,&H00FFFFFF,&H00FFFFFF,&H00141414,&H64000000,-1,0,0,0,100,100,3,0,1,7,4,5,0,0,0,1' % FONT,
        'Style: Tag,%s,34,&H001E1E1E,&H001E1E1E,&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,0,0,9,0,0,0,1' % FONT,
        'Style: Pop,%s,60,&H00151515,&H00151515,%s,&H00000000,-1,0,0,0,100,100,1,0,3,20,0,5,0,0,0,1' % (FONT, acc),
        'Style: Bar,%s,10,%s,%s,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1' % (FONT, acc, acc),
        '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ''])
    ev = []

    def add(layer, a, b, style, text):
        if b - a > .05:
            ev.append('Dialogue: %d,%s,%s,%s,,0,0,0,,%s' % (layer, ass_time(a), ass_time(min(b, total)), style, text))

    hl = lambda t: re.sub(r'\*\*(.+?)\*\*', lambda m: '{\\c%s}%s{\\c%s}' % (acc, m.group(1), white),
                          ass_text(t.replace('{', '').replace('}', '')))
    plain = lambda t: ass_text(t.replace('**', ''))

    def boxed(a, b, t, style='Head', fs=None, cy=None, layer=1, fade=(80, 60), dark='&H141414&', en=''):
        """黑底圓角框＋白字（重點詞亮色），en 是下面一行小字英文；cy 是框底邊，預設在畫面框上面。"""
        fs = fs or int(66 * k)
        fe = int(fs * .56)
        lines = wrap2(t, 12 if fs <= 70 else 9)
        en = plain(en)[:60]
        w = max([chip_w(plain(l), fs) for l in lines] + [chip_w(en, fe) if en else 0]) + int(fs * .9)
        h = int(len(lines) * fs * 1.28 + (fe * 1.35 if en else 0) + fs * .7)
        cy = cy or fy - 26
        x0 = (W - w) // 2
        f = '\\fad(%d,%d)' % fade
        add(layer, a, b, 'Draw', '{\\an7\\pos(%d,%d)\\1c%s\\1a&H08&%s\\p1}%s{\\p0}' % (x0, cy - h, dark, f, rbox(w, h, int(fs * .45))))
        add(layer + 1, a, b, style, '{\\an2\\pos(%d,%d)\\fs%d%s}%s' % (W // 2, cy - int(fs * .32), fs, f, '\\N'.join(hl(l) for l in lines)
                                    + ('\\N{\\fs%d\\b0\\alpha&H30&}%s' % (fe, en) if en else '')))

    plan = plan or {}
    remap = remapper(spans)
    end_intro = min(opt['title_sec'], total)
    body_end = total - (OUTRO if plan.get('tags') else 0)
    # 右上名牌：白色圓角、亮色小圓點
    if opt.get('tag'):
        tg_ = ass_text(opt['tag'])
        w = chip_w('● ' + tg_, 40) + 8
        add(7, 0, total, 'Draw', '{\\an7\\pos(%d,%d)\\1c&HFFFFFF&\\1a&H08&\\p1}%s{\\p0}' % (W - 40 - w, 44, rbox(w, 70, 35)))
        add(8, 0, total, 'Tag', '{\\an6\\pos(%d,%d)\\fs40}{\\c%s}●{\\c&H1E1E1E&} %s' % (W - 58, 79, c_('#E8742A'), tg_))
    # 左上段落小標：亮色圓角「① 小標」，換段落時彈出來（參考第二支影片）
    secs = [(remap(segs[x['i']]['start'], 'start'), x['name']) for x in plan.get('sections') or [] if x['i'] < len(segs)]
    secs = [(a, nm) for a, nm in secs if a is not None]
    for n, (a, nm) in enumerate(secs):
        b = secs[n + 1][0] if n + 1 < len(secs) else body_end
        a = max(a, end_intro if n == 0 else a)
        lab = '%s %s' % ('①②③④⑤'[n], ass_text(nm))
        w = chip_w(lab, 40) + 36
        SFX.append((a, 'pop'))
        add(7, a, b, 'Draw', '{\\an7\\pos(40,44)\\1c%s\\fscx60\\fscy60\\t(0,140,\\fscx100\\fscy100)\\p1}%s{\\p0}' % (c_(opt['accent']), rbox(w, 70, 35)))
        add(8, a, b, 'Tag', '{\\an4\\pos(%d,79)\\fs40\\fad(120,0)}%s' % (58, lab))
    # 開頭：亮色小標籤＋大標題，蓋在畫面框中間
    if plan.get('title'):
        t = plan['title']
        lines = wrap2(t if '**' in t else t, 7)
        cy = fy + min(ch, 1400) // 2
        SFX.append((.2, 'hit'))
        add(5, 0, end_intro, 'Draw', '{\\an7\\pos(%d,%d)\\1c%s\\1a&H30&\\fad(0,300)\\p1}%s{\\p0}' % (fx0, fy, c_('#1C4A35'), rbox(cw, ch, 42)))
        add(6, .15, end_intro, 'Big', '{\\an5\\pos(%d,%d)\\fscx70\\fscy70\\t(0,180,\\fscx104\\fscy104)\\t(180,260,\\fscx100\\fscy100)\\fad(0,300)}%s'
            % (W // 2, cy, '\\N'.join(hl(l) for l in lines)))
    # 口播字幕（只放中文；要英文就在中文下面）
    if opt['subs'] != 'none':
        for kp in plan.get('keep') or []:
            s_ = segs[kp['i']]
            st, en = remap(s_['start'], 'start'), remap(s_['end'], 'end')
            if st is None or en is None or en - st < .2:
                continue
            ws = [max(1, len(l['zh'])) for l in kp['lines']]
            t = st
            for l, w in zip(kp['lines'], ws):
                d = (en - st) * w / sum(ws)
                txt = plain(l.get('en', '')) if opt['subs'] == 'en' else l.get('zh', '')
                if txt:
                    boxed(t, t + d, txt, en=l.get('en', '') if opt['subs'] == 'both' else '')
                t += d
    # 靜音剪的畫面字幕
    for i, (a, b, cap) in enumerate(plan.get('caps_t') or []):
        cap = cap_line(cap)
        SFX.append((a, 'pop'))
        boxed(a, min(b, body_end), cap['zh'], style='Cap', en=cap['en'] if opt['subs'] in ('both', 'en') else '')
    for pp in plan.get('pops') or []:
        st = remap(segs[pp['i']]['start'], 'start')
        if st is None or st < end_intro:
            continue
        SFX.append((st, 'ding'))
        add(9, st, st + 2.2, 'Pop', '{\\pos(%d,%d)\\fscx40\\fscy40\\t(0,160,\\fscx108\\fscy108)\\t(160,260,\\fscx100\\fscy100)\\fad(0,250)}%s'
            % (W // 2, fy + ch * 2 // 3, ass_text(pp['text'])))
    if plan.get('cta_t'):
        a, b, txt = plan['cta_t']
        SFX.append((a, 'ding'))
        boxed(a, min(b, body_end), txt, layer=10, cy=min(H - 90, fy + ch + 160))   # 行動呼籲放在畫面框下面
    # 結尾重點整理：綠底、白色圓角條、亮色編號
    tags = [plain(x) for x in plan.get('tags') or [] if plain(x)][:4]
    if tags:
        a = body_end
        add(11, a, total, 'Draw', '{\\an7\\pos(0,0)\\1c%s\\fad(250,0)\\p1}m 0 0 l %d 0 %d %d 0 %d{\\p0}' % (c_('#2F6B4C'), W, W, H, H))
        top = (H - 180 - len(tags) * 170) // 2
        add(12, a + .1, total, 'Big', '{\\an5\\pos(%d,%d)\\bord0\\shad0\\fs96\\fad(200,0)}{\\c%s}重點整理' % (W // 2, top + 50, acc))
        for n, t in enumerate(tags):
            y, on = top + 180 + n * 170, a + .35 + n * .3
            SFX.append((on, 'pop'))
            add(12, on, total, 'Draw', '{\\an7\\pos(%d,%d)\\1c&HFFFFFF&\\fad(120,0)\\p1}%s{\\p0}' % (110, y, rbox(860, 130, 30)))
            add(13, on, total, 'Draw', '{\\an7\\pos(%d,%d)\\1c%s\\fad(120,0)\\p1}%s{\\p0}' % (140, y + 25, c_(opt['accent']), rbox(80, 80, 40)))
            add(14, on, total, 'Tag', '{\\an5\\pos(%d,%d)\\fs48\\fad(120,0)}%d' % (180, y + 65, n + 1))
            add(14, on, total, 'Tag', '{\\an4\\pos(%d,%d)\\fs56\\fad(120,0)}%s' % (255, y + 65, ass_text(t)))
    if opt.get('bar') and total > 3:
        add(15, 0, total, 'Bar', '{\\an7\\pos(0,0)\\clip(0,0,1,10)\\t(0,%d,\\clip(0,0,%d,10))\\p1}m 0 0 l %d 0 %d 10 0 10{\\p0}'
            % (int(total * 1000), W, W, W))
    with open(path, 'w', encoding='utf-8') as f:
        f.write(head + '\n'.join(ev) + '\n')
    return sum(1 for e in ev if ',Head,' in e or ',Cap,' in e)


def build_ass(plan, segs, spans, opt, total, path):
    del SFX[:]
    if FRAME:
        return build_frame_ass(plan, segs, spans, opt, total, path)
    fx = opt.get('fx', True)
    z = min(W, H) / 1080   # 依畫面大小縮放（直式 1080×1920 時是 1）
    land = W > H
    k = opt['sub_size'] * z * (.82 if land else 1)
    fs, fs_en = int(74 * k), int(44 * k)
    box = opt['sub_box']
    mv = int(LAND_Y[opt['sub_pos']] * H) if land else int(POS_Y[opt['sub_pos']] * H / 1920)
    px = lambda v: max(1, int(v * z))
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
            3 if box else 1, px(14 if box else 4), px(0 if box else 3), mv),
        # 字幕後面的柔光（深色暈開，讓字更立體、更好讀）
        'Style: Glow,%s,%d,&HFF000000,&HFF000000,&H60000000,&HFF000000,-1,0,0,0,100,100,1,0,1,%d,0,2,80,80,%d,1' % (
            FONT, fs, px(14), mv),
        # 開頭標題：深色半透明圓角輸入框裡打字
        'Style: Ask,%s,%d,&H00FFFFFF,&H00FFFFFF,&H40262626,&H00000000,-1,0,0,0,100,100,1,0,3,%d,0,8,80,80,%d,1' % (
            FONT, px(50), px(22), px(270) if not land else int(H * .16)),
        # 標籤：沒打勾是深灰、打勾後變亮色
        'Style: Chip,%s,%d,&H00FFFFFF,&H00FFFFFF,&H50303030,&H00000000,-1,0,0,0,100,100,1,0,3,%d,0,7,0,0,0,1' % (
            FONT, px(44), px(12)),
        'Style: ChipOn,%s,%d,&H00151515,&H00151515,%s,&H00000000,-1,0,0,0,100,100,1,0,3,%d,0,7,0,0,0,1' % (
            FONT, px(44), ass_color(opt['accent']), px(12)),
        # 靜音剪的畫面字幕：大字、粗描邊，重點詞換亮色，彈出來
        'Style: Cap,%s,%d,&H00FFFFFF,&H00FFFFFF,&H00141414,&H64000000,-1,0,0,0,100,100,2,0,1,%d,%d,5,60,60,0,1' % (
            FONT, px(88 if not land else 64), px(6), px(3)),
        # 進度條
        'Style: Bar,%s,10,%s,%s,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1' % (
            FONT, ass_color(opt['accent']), ass_color(opt['accent'])),
        # 重點字卡：亮色底、深色字，跳出來
        'Style: Pop,%s,%d,&H00151515,&H00151515,%s,&H00000000,-1,0,0,0,100,100,1,0,3,%d,0,5,0,0,0,1' % (
            FONT, px(60), ass_color(opt['accent']), px(20)),
        '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ''])
    ev = []

    def add(layer, a, b, style, text):
        if b - a > .05:
            ev.append('Dialogue: %d,%s,%s,%s,,0,0,0,,%s' % (layer, ass_time(a), ass_time(min(b, total)), style, text))

    remap = remapper(spans)
    plan = plan or {}
    acc = ass_color(opt['accent'])
    hl = lambda t, back='&H00FFFFFF': re.sub(r'\*\*(.+?)\*\*', lambda m: '{\\c%s}%s{\\c%s}' % (acc, m.group(1), back),
                                         ass_text(t.replace('{', '').replace('}', '')))   # 重點詞換亮色
    plain = lambda t: ass_text(t.replace('**', ''))
    end_intro = min(opt['title_sec'], total)
    if opt['cards'] and plan.get('title'):
        title = ass_text(plan['title'])
        t0, step = .25, .07   # 一個字一個字打出來
        for i in range(1, len(title) + 1):
            if i <= 20:
                SFX.append((t0 + (i - 1) * step, 'type%d' % (i % 3 + 1)))
            add(2, t0 + (i - 1) * step, t0 + i * step if i < len(title) else end_intro, 'Ask',
                ('{\\fad(150,0)}' if i == 1 else '') + title[:i] + ('{\\alpha&HFF&}' if i == len(title) else '') + '｜')
        SFX.append((t0 + len(title) * step + .05, 'hit'))   # 打完「咚」一聲
    elif plan.get('title'):
        add(2, .2, end_intro, 'Ask', '{\\fad(200,300)}' + ass_text(plan['title']))
    if opt['cards'] and plan.get('tags'):
        x, y = px(60), px(140) if not land else int(H * .06)
        for n, tag in enumerate(plan['tags']):
            tag = ass_text(tag)
            on = .5 + n * .35
            SFX.append((on, 'pop'))
            add(3, .15, on, 'Chip', '{\\pos(%d,%d)\\fad(150,0)}○ %s' % (x, y, tag))
            add(3, on, end_intro, 'ChipOn', '{\\pos(%d,%d)\\fscx80\\fscy80\\t(0,120,\\fscx106\\fscy106)'
                '\\t(120,220,\\fscx100\\fscy100)\\fad(0,250)}√ %s' % (x, y, tag))
            x += chip_w('√ ' + tag, px(44)) + px(22)
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
                zh, eng = l.get('zh', ''), plain(l.get('en', ''))
                if opt['subs'] == 'zh' or not eng:
                    txt, flat = hl(zh, ass_color(opt['sub_color'])), plain(zh)
                elif opt['subs'] == 'en':
                    txt = flat = eng
                else:
                    txt = hl(zh, ass_color(opt['sub_color'])) + '\\N{\\fs%d\\b0\\alpha&H18&}' % fs_en + eng
                    flat = plain(zh) + '\\N{\\fs%d\\b0}' % fs_en + eng
                if fx:   # 每句照 AI 挑的方式跳出來，後面一層柔光；震動的句子字也抖一下
                    first = l is kp['lines'][0]
                    shake = '\\frz-4\\t(0,70,\\frz4)\\t(70,140,\\frz-3)\\t(140,210,\\frz2)\\t(210,280,\\frz0)' if kp.get('fx') == 'shake' and first else ''
                    add(0, t, t + d, 'Glow', sub_anim(plan.get('sub_anim'), W // 2, H - mv, '\\blur%d' % px(10)) + flat)
                    add(1, t, t + d, 'Sub', sub_anim(plan.get('sub_anim'), W // 2, H - mv, shake) + txt)
                else:
                    add(1, t, t + d, 'Sub', '{\\fad(60,0)}' + txt)
                t += d
    if fx:   # 閃白：換話題、轉折的句子開頭整個畫面白一下
        for kp in plan.get('keep') or []:
            st = remap(segs[kp['i']]['start'], 'start') if kp.get('fx') in ('flash', 'shake') else None
            if st is None or st < .3:
                continue
            if kp['fx'] == 'flash':
                SFX.append((max(0, st - .2), 'whoosh'))
                add(6, st, st + .35, 'Bar', '{\\an7\\pos(0,0)\\1c&HFFFFFF&\\1a&H30&\\t(0,350,\\1a&HFF&)\\p1}m 0 0 l %d 0 %d %d 0 %d{\\p0}' % (W, W, H, H))
            else:
                SFX.append((st, 'hit'))
    if opt['cards']:
        for pp in plan.get('pops') or []:
            st = remap(segs[pp['i']]['start'], 'start')
            if st is None or st < end_intro:
                continue
            SFX.append((st, 'ding'))
            add(4, st, st + 2.2, 'Pop', '{\\pos(%d,%d)\\fscx40\\fscy40\\t(0,160,\\fscx108\\fscy108)'
                '\\t(160,260,\\fscx100\\fscy100)\\fad(0,250)}%s' % (W // 2, int(H * .25), ass_text(pp['text'])))
    # 靜音剪：每句字幕跟著段落換，輪流「彈出來」和「往上滑進來」，重點詞亮色
    cy = int(H * (.62 if not land else .72))
    for i, (a, b, cap) in enumerate(plan.get('caps_t') or []):
        cap = cap_line(cap)
        en = cap['en'] if opt['subs'] in ('both', 'en') else ''
        txt = hl(cap['zh']) + ('\\N{\\fs%d\\b0\\alpha&H10&}%s' % (px(44 if not land else 34), plain(en)) if en else '')
        SFX.append((a, 'pop' if i % 2 == 0 else 'swish'))
        if fx:   # 柔光
            add(0, a, b, 'Cap', '{\\an5\\pos(%d,%d)\\1a&HFF&\\3c&H000000&\\3a&H70&\\bord%d\\blur%d\\fad(200,150)}%s'
                % (W // 2, cy, px(16), px(12), plain(cap['zh']) + ('\\N{\\fs%d}%s' % (px(44 if not land else 34), plain(en)) if en else '')))
        if fx and plan.get('sub_anim'):   # AI 挑了字幕動畫就統一用那種
            anim = sub_anim(plan['sub_anim'], W // 2, cy, '', an=5)
        elif i % 2 == 0:
            anim = '{\\an5\\pos(%d,%d)\\fscx55\\fscy55\\t(0,150,\\fscx112\\fscy112)\\t(150,260,\\fscx100\\fscy100)\\fad(60,150)}' % (W // 2, cy)
        else:
            anim = '{\\an5\\move(%d,%d,%d,%d,0,220)\\fad(120,150)}' % (W // 2, cy + px(90), W // 2, cy)
        add(1, a, b, 'Cap', anim + txt)
    if plan.get('cta_t'):
        a, b, txt = plan['cta_t']
        SFX.append((a, 'ding'))
        add(4, a, b, 'Pop', '{\\pos(%d,%d)\\fscx40\\fscy40\\t(0,160,\\fscx108\\fscy108)\\t(160,260,\\fscx100\\fscy100)}%s'
            % (W // 2, int(H * .5), ass_text(txt.replace('**', ''))))
    if opt.get('bar') and total > 3:   # 上方進度條：跟著時間慢慢變長
        bh = px(10)
        add(5, 0, total, 'Bar', '{\\an7\\pos(0,0)\\clip(0,0,1,%d)\\t(0,%d,\\clip(0,0,%d,%d))\\p1}m 0 0 l %d 0 %d %d 0 %d{\\p0}'
            % (bh, int(total * 1000), W, bh, W, W, bh, bh))
    with open(path, 'w', encoding='utf-8') as f:
        f.write(head + '\n'.join(ev) + '\n')
    return sum(1 for e in ev if (',Sub,' in e or ',Cap,' in e) and '\\1a&HFF&' not in e)


def music_files():
    return sorted(glob.glob(os.path.join(HERE, 'music', '*.mp3')))


def music_names():
    return [os.path.basename(f)[:-4] for f in music_files()]


def music_credit(path):
    """配樂的授權署名（reels/music/credits.json），發到社群時要放在貼文裡。"""
    try:
        with open(os.path.join(HERE, 'music', 'credits.json'), encoding='utf-8') as f:
            return json.load(f).get(os.path.basename(path or '')[:-4], '')
    except (OSError, ValueError):
        return ''


def pick_music(opt, plan=None):
    """配樂：說明有指定就用那首，不然用 AI 依影片氣氛挑的，再不然隨機。"""
    if not opt['music']:
        return None
    files = music_files()
    if not files:
        return None
    for want in (opt['mood'], (plan or {}).get('music')):
        if want:
            m = [f for f in files if want in os.path.basename(f) or os.path.basename(f)[:-4] in want]
            if m:
                return m[0]
    return random.choice(files)


SFX_VOL = {'type1': .22, 'type2': .22, 'type3': .22, 'pop': .45, 'ding': .38, 'swish': .32, 'whoosh': .5, 'hit': .4}


def sfx_inputs(events, total, first):
    """音效：每種音效檔讀一次，分成好幾份延遲到各自的時間點，再混成一軌 [fx]。回傳（輸入參數, 濾鏡）。"""
    by = {}
    for t, k in events:
        f = os.path.join(HERE, 'sfx', k + '.mp3')
        if 0 <= t < total - .2 and os.path.exists(f):
            by.setdefault(k, []).append(t)
    args, fc, outs = [], [], []
    for n, (k, ts) in enumerate(sorted(by.items())):
        ts = sorted(set(round(t, 2) for t in ts))
        idx = first + n
        args += ['-i', os.path.join(HERE, 'sfx', k + '.mp3')]
        names = ['%s%d' % (k, j) for j in range(len(ts))]
        fc.append('[%d:a]aresample=48000,aformat=channel_layouts=stereo,volume=%.2f%s' % (
            idx, SFX_VOL.get(k, .4), ',asplit=%d%s' % (len(ts), ''.join('[%s]' % x for x in names)) if len(ts) > 1 else '[%s]' % names[0]))
        for x, t in zip(names, ts):
            ms = int(max(0, t) * 1000)
            fc.append('[%s]adelay=%d|%d[%sd]' % (x, ms, ms, x))
            outs.append('[%sd]' % x)
    if not outs:
        return [], ''
    fc.append('%samix=inputs=%d:normalize=0:duration=longest[fx]' % (''.join(outs), len(outs)) if len(outs) > 1 else '%sanull[fx]' % outs[0])
    return args, ';'.join(fc)


def finish(joined, ass, music, total, out, work, music_vol=0.35, grade=True, sfx=None, look='clean', pad=0):
    # 控制檔案大小，Telegram 機器人傳影片上限 50MB
    kbps = int(min(6000, (TG_LIMIT * 8 / 1000) / max(total, 1) - 200))
    vf = "[0:v]%s%sass='%s'[v]" % ('tpad=stop_mode=clone:stop_duration=%.2f,' % pad if pad else '',   # 教學框結尾停在最後一格放重點整理
                                  LOOKS.get(look, LOOKS['clean']) + ',' if grade else '',
                                ass.replace("'", "\\'").replace(':', '\\:'))   # 調色：AI 依氣氛挑（溫暖、冷調、電影感…）
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', joined]
    fade = 'afade=t=in:d=0.3,afade=t=out:st=%.2f:d=1.5' % max(0, total - 1.5)
    if music:
        cmd += ['-stream_loop', '-1', '-i', music]
    fx_args, fx_fc = sfx_inputs(sfx or [], total, 2 if music else 1)
    cmd += fx_args
    mix = ['[s1]']
    if music:
        # 配樂：先把每首的音量校成一樣，開頭淡入；有人講話時自動壓低（講完慢慢回來）
        fc = (vf + ';[0:a]%sasplit[s1][s2];' % ('apad,' if pad else '') +
              '[1:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-18:TP=-2:LRA=9,aresample=48000,'
              'afade=t=in:d=1.2,volume=%.2f[m0];'
              '[m0][s2]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=450[m]' % music_vol)
        mix.append('[m]')
    else:
        fc = vf + ';[0:a]%s[s1]' % ('apad' if pad else 'anull')
    if fx_fc:
        fc += ';' + fx_fc
        mix.append('[fx]')
    fc += ';%samix=inputs=%d:normalize=0:duration=first,loudnorm=I=-14:TP=-1.5,%s[a]' % (''.join(mix), len(mix), fade) if len(mix) > 1 \
        else ';[s1]loudnorm=I=-14:TP=-1.5,%s[a]' % fade
    cmd += ['-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-t', '%.3f' % total,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', '%dk' % kbps, '-bufsize', '%dk' % (kbps * 2),
            '-r', str(FPS), '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', out]
    run(cmd)
    thumb = os.path.join(work, 'thumb.jpg')
    run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '%.2f' % min(1.0, total / 2), '-i', out, '-frames:v', '1',
         '-vf', 'scale=320:-2', '-q:v', '4', thumb])
    return thumb


def get_music(music_file, opt, plan, work):
    """配樂：你在 Telegram 傳的優先，不然從配樂庫挑。回傳（檔案, 是不是你的）。"""
    if music_file and opt['music']:
        try:
            path = os.path.join(work, 'mine_music')
            tg_download(music_file, path, '配樂')
            return path, True
        except Oops as e:
            log('自己的配樂拿不到：', e)
    return pick_music(opt, plan), False


def spread(caps, slots):
    """把幾句字幕平均分到幾個時段（每段 [開始, 結束]），回傳 [(開始, 結束, 字)]。"""
    caps = caps[:len(slots)]
    out = []
    for j, txt in enumerate(caps):
        a = slots[int(j * len(slots) / len(caps))][0]
        b = slots[int((j + 1) * len(slots) / len(caps)) - 1][1]
        out.append((a, b, txt))
    return out


def silent_cut(src, opt, note, dur, has_audio, work, music_file, given):
    """靜音剪：配樂卡點、運鏡、轉場、文字動畫。回傳（成品, 段落, 計畫, 配樂, 是不是你的配樂）。"""
    if MODE == 'reels' and not re.search(r'\d+\s*(秒|s|sec|分)', note or '', re.I):
        opt['target'] = 20   # 靜音短影音預設 20 秒左右
    if opt['title_sec'] == DEFAULTS['title_sec']:
        opt['title_sec'] = 2.5
    n_caps = max(3, min(12, int(opt['target'] / 2.6))) if MODE == 'reels' else max(3, min(12, int(dur / 6)))
    try:
        plan = silent_plan(src, dur, opt, note, work, n_caps)
    except Oops as e:
        log('AI 寫字幕失敗：', e)
        plan = {'title': opt['title'], 'caps': [], 'cta': '', 'tags': [], 'music': '', 'post': '', 'keep': [], 'pops': []}
    if isinstance(given, dict):   # 本機測試：直接給字幕
        plan.update({k: v for k, v in given.items() if v})
        plan.update(silent_fx(plan))
    music, mine = get_music(music_file, opt, plan, work)
    if MODE == 'long':
        spans = [[0, dur]]
        joined = cut(src, spans, has_audio, work)
        starts = None
    else:
        beat = 60.0 / MUSIC_BPM.get(os.path.basename(music or '')[:-4], 100)
        spans = silent_spans(src, dur, opt['target'], beat)
        joined, starts = montage(src, spans, work, opt['fx'], plan.get('moves'), plan.get('trans'))
        plan['xfades'] = starts[1:] if opt['fx'] else []   # 轉場的時間點（加「咻」）
    total = float(json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-of', 'json', joined]))['format']['duration'])
    intro = min(opt['title_sec'], total) if plan.get('title') else 0
    tail = total - (2.5 if plan.get('cta') and total > intro + 5 else 0)
    if starts:
        edges = starts[1:] + [total]
        slots = [[max(a, intro), min(b, tail)] for a, b in zip(starts, edges)]
    else:
        n = max(1, len(plan['caps']))
        step = (tail - intro) / n
        slots = [[intro + i * step, intro + (i + 1) * step] for i in range(n)]
    slots = [s for s in slots if s[1] - s[0] >= .8]
    plan['caps_t'] = spread(plan['caps'], slots) if plan['caps'] and slots else []
    if tail < total:
        plan['cta_t'] = (tail, total, plan['cta'])
    plan['tags'] = []   # 靜音剪畫面字很多，開頭不放標籤
    return joined, spans, plan, total, music, mine


def fx_summary(plan, opt, silent):
    """這支影片用了哪些特效（給 Telegram 說明用）。"""
    if not opt['fx'] or not plan:
        return ''
    out = ['%s調色' % LOOK_NAME.get(plan.get('look') or 'clean', '自然')]
    if plan.get('sub_anim'):
        out.append('%s字幕' % SUB_ANIMS[plan['sub_anim']])
    if silent and MODE == 'long':   # 靜音大片整段保留，沒有運鏡和轉場
        pass
    elif silent:
        mv = {'in': '推近', 'out': '拉遠', 'right': '右移', 'left': '左移', 'up': '上移', 'down': '下移', 'shake': '震動'}
        if plan.get('moves'):
            out.append('運鏡' + '／'.join(dict.fromkeys(mv[m] for m in plan['moves'])))
        if plan.get('trans'):
            out.append('轉場' + '／'.join(dict.fromkeys(TRANS[t] for t in plan['trans'])))
    else:
        n = {}
        for k in plan.get('keep') or []:
            if k.get('fx'):
                n[k['fx']] = n.get(k['fx'], 0) + 1
        out += ['%s×%d' % (SHOT_FX[k], v) for k, v in n.items()]
    return '、'.join(out)


def make(src, out, note, transcript=None, style='', mode='reels', music_file='', kind='auto'):
    global MODE, W, H, FRAME
    opt = apply_tweaks(apply_style(parse_note(note, mode, kind), style), note)
    MODE = opt['mode']
    W, H = 1080, 1920
    FRAME = None
    work = tempfile.mkdtemp(prefix='reels_')
    try:
        dur, has_audio, src_wh = probe(src)
        if opt['layout'] == 'frame':
            FRAME = frame_setup(src_wh, work)
            log('教學框：畫面 %dx%d' % FRAME[:2])
        if MODE == 'long':
            opt['target'] = int(dur) + 1   # 大片不限長度
            W, H = long_size(src_wh, dur)
        if dur > MAX_SOURCE_SEC:
            raise Oops('影片超過 20 分鐘，請先剪短一點再傳。')
        segs = []
        if opt['kind'] != 'silent':
            if isinstance(transcript, list):
                segs = transcript
            elif has_audio:
                audio = os.path.join(work, 'audio.mp3')
                run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', audio])
                segs = transcribe(audio)
        speech = sum(len(s['text']) for s in segs) >= 4
        if opt['kind'] == 'auto':
            opt['kind'] = 'talk' if speech else 'silent'
            log('自動判斷：%s' % ('口播' if speech else '靜音'))
        if opt['kind'] == 'silent':
            segs = []
            joined, spans, plan, total, music, mine = silent_cut(src, opt, note, dur, has_audio, work, music_file, transcript)
            log('靜音剪：原片 %.1f 秒 → %d 段、共 %.1f 秒、%d 句字幕（%s %dx%d）'
                % (dur, len(spans), total, len(plan['caps_t']), MODE, W, H))
        else:
            plan = plan_clips(segs, opt, note) if speech and os.environ.get('OPENAI_API_KEY') else None
            if speech and plan is None and transcript is not None:   # 本機測試：沒有 AI 就全部保留、英文留空
                plan = {'title': opt['title'] or '測試標題', 'post': '', 'tags': segs[0].get('tags') or ['字幕', '剪輯', '動畫', '字卡'],
                        'look': pick(segs[0].get('look'), LOOKS, 'clean'), 'sub_anim': pick(segs[0].get('sub_anim'), SUB_ANIMS, 'pop'),
                        'pops': [{'i': i, 'text': s['pop']} for i, s in enumerate(segs) if s.get('pop')],
                        'sections': [{'i': i, 'name': s['sec']} for i, s in enumerate(segs) if s.get('sec')],
                        'keep': [{'i': i, 'fx': pick(s.get('fx'), SHOT_FX), 'lines': s.get('lines') or [{'zh': s['text'], 'en': s.get('en', '')}]}
                                 for i, s in enumerate(segs)]}
            if plan and plan['keep']:
                spans = clips_from_plan(plan, segs, dur)
                if opt['jumpcut'] and has_audio:
                    spans = drop_pauses(spans, silences(src)) or spans
            else:
                spans = [[0, dur]] if MODE == 'long' else clips_without_speech(dur, opt['target'])
                if plan is None and opt['title']:
                    plan = {'title': opt['title'], 'keep': [], 'post': '', 'tags': [], 'pops': []}
            if MODE == 'long':
                W, H = long_size(src_wh, sum(b - a for a, b in spans))
            log('口播剪：原片 %.1f 秒 → 剪成 %d 段、共 %.1f 秒（%s %dx%d）'
                % (dur, len(spans), sum(b - a for a, b in spans), MODE, W, H))
            shots = span_shots(spans, plan, segs) if plan and any(k.get('fx') for k in plan.get('keep') or []) else None
            joined = cut(src, spans, has_audio, work, punch=opt['fx'], shots=shots)
            total = float(json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-of', 'json', joined]))['format']['duration'])
            music, mine = get_music(music_file, opt, plan, work)
        ass = os.path.join(work, 'subs.ass')
        pad = OUTRO if FRAME and (plan or {}).get('tags') else 0   # 教學框：結尾多 3 秒放重點整理
        total += pad
        n = build_ass(plan, segs, spans, opt, total, ass)
        silent = opt['kind'] == 'silent'
        sfx = (list(SFX) + [(t - .25, 'whoosh') for t in (plan or {}).get('xfades') or []]) if opt['sfx'] else []
        log('音效 %d 個' % len(sfx))
        look = (plan or {}).get('look') or 'clean'
        thumb = finish(joined, ass, music, total, out, work, music_vol=.85 if silent else .35, grade=opt['fx'], sfx=sfx, look=look, pad=pad)
        fx_desc = fx_summary(plan, opt, silent)
        log('特效：' + (fx_desc or '無'))
        diff = subs_check(joined, out, ass, work) if n else None
        if diff is not None:
            log('字幕檢查：畫面差異 %.1f%s' % (diff, '' if diff >= 1.5 else '　⚠️ 字幕可能沒有畫上去'))
        if os.path.getsize(out) > TG_LIMIT:
            raise Oops('剪好的影片太大，傳不回 Telegram。請在說明寫短一點的秒數（例如「剪 Reels 30秒」）再試一次。')
        shutil.copy(thumb, out + '.jpg')
        return {'seconds': total, 'clips': len(spans), 'subs': n, 'subs_diff': diff, 'subs_lang': opt['subs'],
                'kind': opt['kind'], 'fx': opt['fx'], 'fx_desc': fx_desc,
                'music': '你的配樂' if mine else os.path.basename(music or '')[:-4],
                'credit': '' if mine else music_credit(music),
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
    ap.add_argument('--mode', default=os.environ.get('MODE', '') or 'reels')
    ap.add_argument('--music-file', default=os.environ.get('MUSIC_FILE', ''))
    ap.add_argument('--kind', default=os.environ.get('KIND', '') or 'auto', help='talk 口播／silent 靜音／auto 自動')
    ap.add_argument('--selftest', action='store_true', help='字幕沒畫上去就失敗（GitHub 上測試用）')
    a = ap.parse_args()
    resolve_font()

    chat = os.environ.get('CHAT_ID')
    try:
        tmp = tempfile.mkdtemp()
        if a.input:
            srcs = [x for x in a.input.split(',') if x]
        else:
            ids = [x.strip() for x in os.environ['FILE_ID'].split(',') if x.strip()]
            srcs = []
            for n, fid in enumerate(ids):
                srcs.append(os.path.join(tmp, 'input%02d.mp4' % n))
                tg_download(fid, srcs[-1])
        src = srcs[0] if len(srcs) == 1 else join_sources(srcs, tmp)
        tr = json.load(open(a.transcript, encoding='utf-8')) if a.transcript else None
        info = make(src, a.out, a.note, tr, a.style, a.mode, a.music_file, a.kind)
        log('完成：%.1f 秒、%d 段、%d 則字幕' % (info['seconds'], info['clips'], info['subs']))   # repo 公開，紀錄不寫內容
        if a.selftest and info['subs'] and (info['subs_diff'] or 0) < 1.5:
            log('自我測試失敗：字幕沒有畫上去')
            sys.exit(2)
        if chat:
            ver = os.environ.get('VERSION') or '1'
            secs = round(info['seconds'])
            cap = '🎬 第 %s 版試剪好了（%s）' % (ver, '%d 秒' % secs if secs < 90 else '%d 分 %d 秒' % divmod(secs, 60))
            if info['title']:
                cap += '\n標題：' + info['title']
            if info.get('fx_desc'):
                cap += '\n特效（小乖依這支影片挑的）：' + info['fx_desc']
            silent = info['kind'] == 'silent'
            cap += '\n' + '、'.join(x for x in ['大片 %d×%d' % (W, H) if MODE == 'long' else 'Reels 直式 9:16',
                                                '教學框' if FRAME else '',
                                                '靜音剪' if silent else '口播剪',
                                                ('文字動畫' if silent else {'both': '中英字幕', 'zh': '中文字幕', 'en': '英文字幕'}.get(info['subs_lang'], '')) if info['subs'] else '',
                                                ('運鏡＋轉場' if silent else '推近鏡頭') if info['fx'] and not info.get('fx_desc') else '',
                                                '配樂「%s」' % info['music'] if info['music'] else ''] if x)
            cap += ('\n\n想改哪裡，長按這支影片按「回覆」直接說，例如：'
                    '\n・字幕大一點／放上面一點\n・開頭標題久一點\n・剪成 30 秒\n・用教學框（綠底、畫面放中間）／不要教學框\n・換溫暖鋼琴的配樂／不要配樂\n・不要特效／不要進度條'
                    '\n也可以先傳一首音樂給小乖當配樂。'
                    '\n也可以傳一張喜歡的影片截圖，說「我要這種風格」。')
            tg_send_video(chat, a.out, cap, a.out + '.jpg')
            post = info['post'] + ('\n\n' + info['credit'] if info.get('credit') else '')
            if post.strip():
                tg('sendMessage', chat_id=chat, text='📝 貼文文案參考（長按可複製；配樂署名要保留）：\n\n' + post.strip())
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
