"""小乖剪 Reels：把一段影片自動剪成直式 9:16 短影音，上中英字幕、配背景音樂。

在 GitHub Actions 上跑（.github/workflows/reels.yml），由小乖的 Apps Script 觸發：
  你在 Telegram 傳影片給小乖 → 小乖叫這支程式 → 剪好直接傳回 Telegram。

流程：
  1. 從 Telegram 下載影片
  2. 用 OpenAI 語音辨識拿到逐句文字與時間
  3. 讓 AI 挑精華句子、改成繁體中文字幕、翻成英文、想一個標題和貼文文案
  4. ffmpeg 剪接、轉成 1080×1920（橫的影片上下補模糊背景）、燒上字幕、混入配樂（有人說話時音樂自動變小）
  5. 傳回 Telegram

需要的環境變數：TELEGRAM_BOT_TOKEN、OPENAI_API_KEY、CHAT_ID、FILE_ID；NOTE 是你寫在影片上的說明（可空白）。
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
def parse_note(note):
    note = note or ''
    opt = {'target': 60, 'music': True, 'subs': 'both', 'mood': '', 'title': ''}
    m = re.search(r'(\d{1,3})\s*(秒|s|sec)', note, re.I)
    if m:
        opt['target'] = max(10, min(90, int(m.group(1))))
    elif re.search(r'(\d)\s*分(鐘)?', note):
        opt['target'] = max(10, min(90, int(re.search(r'(\d)\s*分', note).group(1)) * 60))
    if re.search(r'(不要|無|沒有|免|關掉?)\s*(配樂|音樂)', note):
        opt['music'] = False
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
    return opt


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
2. 每一句改成字幕：繁體中文（台灣用語），依上下文修正辨識錯字，不加標點以外的內容；
   中文太長就拆成多行，每行不超過 14 個字。每行附上自然口語的英文翻譯。
3. 想一個 12 個字以內、吸引人的影片標題（使用者說明裡有指定標題就用那個）。
4. 寫一段 IG 貼文文案（3～5 行，繁體中文，結尾 5 個 hashtag）。
只回 JSON：{{"title": "", "keep": [{{"i": 0, "lines": [{{"zh": "", "en": ""}}]}}], "post": ""}}'''


def plan_clips(segs, opt, note):
    if not segs:
        return None
    lines = '\n'.join('i=%d [%.1f-%.1f] %s' % (i, s['start'], s['end'], s['text']) for i, s in enumerate(segs))
    plan = ask_ai(PLAN_PROMPT.format(target=opt['target']),
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
    return {'title': opt['title'] or (plan.get('title') or '').strip()[:16], 'keep': keep, 'post': (plan.get('post') or '').strip()}


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


def build_ass(plan, segs, spans, opt, total, path):
    head = '''[Script Info]
ScriptType: v4.00+
PlayResX: %d
PlayResY: %d
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,{f},64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,1,0,1,5,1,2,70,70,400,1
Style: Title,{f},84,&H00FFFFFF,&H00FFFFFF,&H00203A2E,&H64000000,-1,0,0,0,100,100,2,0,1,7,2,8,80,80,250,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
''' % (W, H)
    head = head.replace('{f}', FONT)
    ev = []
    if plan and plan.get('title'):
        ev.append('Dialogue: 1,%s,%s,Title,,0,0,0,,{\\fad(250,400)}%s' % (ass_time(0.2), ass_time(min(3.8, total)), ass_text(plan['title'])))
    if plan and opt['subs'] != 'none':
        # 原影片時間 → 剪好後的時間
        offs, acc = [], 0.0
        for a, b in spans:
            offs.append((a, b, acc))
            acc += b - a

        def remap(t):
            for a, b, o in offs:
                if a - .01 <= t <= b + .01:
                    return o + min(max(t, a), b) - a
            return None

        for k in plan['keep']:
            s = segs[k['i']]
            st, en = remap(s['start']), remap(s['end'])
            if st is None or en is None or en <= st:
                continue
            weights = [max(1, len(l['zh'])) for l in k['lines']]
            t = st
            for l, w in zip(k['lines'], weights):
                d = (en - st) * w / sum(weights)
                zh, eng = ass_text(l.get('zh', '')), ass_text(l.get('en', ''))
                if opt['subs'] == 'zh':
                    txt = zh
                elif opt['subs'] == 'en':
                    txt = eng or zh
                else:
                    txt = zh + ('\\N{\\fs42\\b0\\c&H8CE8FF&\\bord4}' + eng if eng else '')
                ev.append('Dialogue: 0,%s,%s,Sub,,0,0,0,,%s' % (ass_time(t), ass_time(min(t + d, total)), txt))
                t += d
    with open(path, 'w', encoding='utf-8') as f:
        f.write(head + '\n'.join(ev) + '\n')
    return len(ev)


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


def make(src, out, note, transcript=None):
    opt = parse_note(note)
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
            plan = {'title': opt['title'] or '測試標題', 'post': '',
                    'keep': [{'i': i, 'lines': [{'zh': s['text'], 'en': s.get('en', '')}]} for i, s in enumerate(segs)]}
        if plan and plan['keep']:
            spans = clips_from_plan(plan, segs, dur)
        else:
            spans = clips_without_speech(dur, opt['target'])
            if plan is None and opt['title']:
                plan = {'title': opt['title'], 'keep': [], 'post': ''}
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
    a = ap.parse_args()

    chat = os.environ.get('CHAT_ID')
    try:
        src = a.input
        if not src:
            src = os.path.join(tempfile.mkdtemp(), 'input.mp4')
            tg_download(os.environ['FILE_ID'], src)
        tr = json.load(open(a.transcript, encoding='utf-8')) if a.transcript else None
        info = make(src, a.out, a.note, tr)
        log('完成：%.1f 秒、%d 段、%d 則字幕' % (info['seconds'], info['clips'], info['subs']))   # repo 公開，紀錄不寫內容
        if chat:
            cap = '🎬 Reels 剪好了（%d 秒）' % round(info['seconds'])
            if info['title']:
                cap += '\n標題：' + info['title']
            cap += '\n' + '、'.join(x for x in ['直式 9:16',
                                                '中英字幕' if info['subs'] else '',
                                                '配樂「%s」' % info['music'] if info['music'] else ''] if x)
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
