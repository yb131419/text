"""卡片特效（2026-10-17 照使用者給的 Canva「Claude 卡片環繞特效教學」）：剪片時一起傳的截圖變成卡片，疊在影片裡的人身邊。

  環繞 orbit：圓角、白邊、有陰影的卡片沿橢圓軌道繞著人轉；轉到後面變小、變模糊、被人擋住，轉到前面變大、蓋在人身上。
              分層：背景 → 後面的卡片 → 人 → 前面的卡片；軌道中心跟著頭移動，前面的卡片不擋臉。
  標題牆 wall：截圖從畫面外飛進來，散在人的上方和兩側（在人後面，不會擋到人）。
  兩種都是：開頭彈出、結尾縮小淡出，只出現在指定的那幾秒，其他段落和聲音都不動。

人像去背用 rembg 的 isnet-general-use.onnx（onnxruntime 逐格跑），第一次會自動下載約 180MB 的模型。
說明可以寫：「環繞」「標題牆」「第 3 到 8 秒」「卡片大 20%」「轉一圈 6 秒」「只用 4 張」「卡片擋到臉」「不要環繞」。
本機測試：python3 reels/orbit.py 影片.mp4 卡片資料夾 開始秒數 結束秒數 [output.mp4] [--wall] [--preview 預覽.jpg]
"""
import glob
import math
import os
import re
import subprocess
import sys
import urllib.request

try:   # 只有真的要做卡片特效才需要（GitHub 上的流程會裝好）；讀說明的 card_opts 不需要
    import cv2
    import numpy as np
except ImportError:
    cv2 = np = None

# ---- 可以調整的參數（教學說的：卡片擋到臉就把 CENTER_DROP 調大，想轉慢一點就把 PERIOD 調大）----
RX = 0.40           # 橢圓軌道左右半徑（畫面寬的幾倍）
RY = 0.055          # 橢圓軌道上下半徑（畫面高的幾倍）
CENTER_DROP = 0.17  # 軌道中心在頭頂下面多少（畫面高的幾倍）；越大卡片越往下、越不會擋臉
PERIOD = 6.0        # 轉一圈幾秒
CARD_W = 0.28       # 卡片最寬（畫面寬的幾倍）
CARD_H = 0.22       # 卡片最高（畫面高的幾倍），直的手機截圖會被這個限制
MAX_CARDS = 6
SEC = 5.0           # 沒寫秒數時特效幾秒（教學建議 5 秒內）
POP_IN, POP_OUT = .55, .45

MODEL_URL = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx'
MODEL_PATH = os.environ.get('REMBG_MODEL') or os.path.join(os.path.expanduser('~'), '.u2net', 'isnet-general-use.onnx')
IMG_EXT = ('.jpg', '.jpeg', '.png', '.webp')


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------- 說明裡的要求 ----------------
NUM = r'(\d+(?:\.\d+)?)'
WINDOW = re.compile(r'第?\s*' + NUM + r'\s*秒?\s*(?:到|至|~|～|-|－|—)\s*(?:第\s*)?' + NUM + r'\s*秒')


def card_opts(note):
    """從說明讀出卡片特效的設定，回傳（設定, 拿掉這些字的說明）。修改要求會一直接在後面，所以都以最後寫的為準。"""
    note = note or ''
    opt = {'fx': '', 'used': False, 't0': None, 't1': None, 'size': 1.0, 'period': PERIOD, 'n': MAX_CARDS, 'drop': CENTER_DROP}
    for m in re.finditer(r'(不要|取消|關掉?|拿掉)?\s*(環繞|繞著|orbit|標題牆|截圖牆|飛進來)', note, re.I):
        opt['used'] = True   # 提過卡片特效（後來說「不要環繞」也算）：截圖就不排進影片
        opt['fx'] = '' if m.group(1) else ('wall' if re.match(r'標題牆|截圖牆|飛進來', m.group(2)) else 'orbit')
    ws = list(WINDOW.finditer(note))
    if ws:
        a, b = float(ws[-1].group(1)), float(ws[-1].group(2))
        opt['t0'], opt['t1'] = min(a, b), max(a, b)
    for m in re.finditer(r'卡片\s*(放?大|縮?小)\s*' + NUM + r'\s*%', note):
        k = float(m.group(2)) / 100
        opt['size'] *= (1 + k) if '大' in m.group(1) else max(.3, 1 - k)
    opt['size'] *= 1.2 ** len(re.findall(r'卡片\s*大一?點', note)) / 1.2 ** len(re.findall(r'卡片\s*小一?點', note))
    m = None
    for m in re.finditer(r'(?:轉一圈|一圈)\s*' + NUM + r'\s*秒', note):
        pass
    if m:
        opt['period'] = float(m.group(1))
    opt['period'] *= 1.4 ** len(re.findall(r'轉慢一?點', note)) / 1.4 ** len(re.findall(r'轉快一?點', note))
    for m in re.finditer(r'只(?:用|要|放)\s*(\d+)\s*張', note):
        opt['n'] = int(m.group(1))
    opt['drop'] += .05 * len(re.findall(r'擋到臉|擋住臉|遮到臉|卡片(?:往|再)?下', note))
    opt['size'] = max(.4, min(2.0, opt['size']))
    opt['period'] = max(2.0, min(20.0, opt['period']))
    opt['n'] = max(1, min(MAX_CARDS * 2, opt['n']))
    rest = WINDOW.sub('', note)
    rest = re.sub(r'(不要|取消|關掉?|拿掉)?\s*(環繞特效|環繞|繞著人?轉?|orbit|標題牆|截圖牆|飛進來)|卡片\s*(放?大|縮?小)\s*\d+(\.\d+)?\s*%'
                  r'|卡片\s*[大小]一?點|(轉一圈|一圈)\s*\d+(\.\d+)?\s*秒|轉[慢快]一?點|只(用|要|放)\s*\d+\s*張|卡片?\s*(擋到臉|擋住臉|遮到臉)|卡片(往|再)?下',
                  '', rest, flags=re.I)
    return opt, rest


# ---------------- 去背 ----------------
class Seg:
    """rembg 的 isnet-general-use 模型：輸入 BGR 畫面，回傳 0～1 的人像遮罩（跟輸入同大小）。"""

    def __init__(self):
        import onnxruntime as ort
        if not os.path.exists(MODEL_PATH):
            os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
            log('下載去背模型（約 180MB）…')
            tmp = MODEL_PATH + '.part'
            urllib.request.urlretrieve(MODEL_URL, tmp)
            os.replace(tmp, MODEL_PATH)
        so = ort.SessionOptions()
        so.intra_op_num_threads = os.cpu_count() or 4
        self.s = ort.InferenceSession(MODEL_PATH, so, providers=['CPUExecutionProvider'])
        self.name = self.s.get_inputs()[0].name

    def __call__(self, bgr, out_wh=None):
        h, w = bgr.shape[:2]
        x = cv2.resize(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), (1024, 1024), interpolation=cv2.INTER_AREA).astype(np.float32)
        x = x / max(float(x.max()), 1e-6) - np.array([.485, .456, .406], np.float32)   # 跟 rembg 一樣的正規化（std 是 1）
        p = self.s.run(None, {self.name: x.transpose(2, 0, 1)[None]})[0][0, 0]
        p = (p - p.min()) / max(float(p.max() - p.min()), 1e-6)
        return cv2.resize(p, out_wh or (w, h), interpolation=cv2.INTER_LINEAR)


def head_of(mask, W, H):
    """遮罩 → 頭的位置（x, 頭頂 y, 頭寬）；找不到人就回 None。mask 可以是縮小過的，會換算回 W×H。
    舉高的手很細，所以從上往下找「夠寬」的那一列才算頭頂。"""
    h, w = mask.shape
    b = mask > .5
    top, runs = None, []
    for y in np.where(b.sum(1) > w * .09)[0]:   # 兩隻手加起來也可能很寬，所以看「連在一起最長的一段」
        d = np.diff(np.concatenate(([0], b[y].astype(np.int8), [0])))
        st, en = np.where(d == 1)[0], np.where(d == -1)[0]
        k = int(np.argmax(en - st))
        if en[k] - st[k] > w * .09:
            if top is None:
                top = y
            runs.append((st[k], en[k]))
            if y - top > h * .07:
                break
    if top is None or b.sum() < w * h * .01:
        return None
    x = float(np.mean([(a + c) / 2 for a, c in runs]))
    hw = float(np.median([c - a for a, c in runs]))
    return x * W / w, top * H / h, min(hw * W / w, W * .45)


# ---------------- 卡片 ----------------
def make_card(img, box_w, box_h):
    """截圖 → 圓角、白邊、有陰影的卡片（BGRA，四周留陰影的空間）。"""
    h, w = img.shape[:2]
    k = min(box_w / w, box_h / h)
    cw, ch = max(8, int(w * k)), max(8, int(h * k))
    border = max(4, int(min(cw, ch) * .035))
    r = max(6, int(min(cw, ch) * .09))
    pad = int(max(cw, ch) * .12)
    face = cv2.resize(img[:, :, :3], (cw - 2 * border, ch - 2 * border), interpolation=cv2.INTER_AREA)
    W, H = cw + 2 * pad, ch + 2 * pad
    out = np.zeros((H, W, 4), np.float32)

    def rounded(w_, h_, rr):
        m = np.zeros((h_, w_), np.uint8)
        cv2.rectangle(m, (rr, 0), (w_ - rr - 1, h_ - 1), 255, -1)
        cv2.rectangle(m, (0, rr), (w_ - 1, h_ - rr - 1), 255, -1)
        for cx, cy in ((rr, rr), (w_ - rr - 1, rr), (rr, h_ - rr - 1), (w_ - rr - 1, h_ - rr - 1)):
            cv2.circle(m, (cx, cy), rr, 255, -1, cv2.LINE_AA)
        return m.astype(np.float32) / 255

    outer = rounded(cw, ch, r)
    inner = rounded(cw - 2 * border, ch - 2 * border, max(2, r - border))
    sh = np.zeros((H, W), np.float32)   # 陰影：往下偏一點、模糊
    dy = int(ch * .04)
    sh[pad + dy:pad + dy + ch, pad:pad + cw] = outer
    sh = cv2.GaussianBlur(sh, (0, 0), max(2, pad * .45)) * .45
    out[:, :, 3] = sh
    body = np.zeros((ch, cw, 3), np.float32) + 255
    body[border:ch - border, border:cw - border] = (face.astype(np.float32) * inner[..., None]
                                                    + 255 * (1 - inner[..., None]))
    reg = out[pad:pad + ch, pad:pad + cw]
    a = outer[..., None]
    reg[:, :, :3] = body * a + reg[:, :, :3] * (1 - a)   # 陰影區的顏色是黑的（0），卡片蓋上去
    reg[:, :, 3] = outer + reg[:, :, 3] * (1 - outer)
    out[:, :, :3] *= (out[:, :, 3:] > 0)
    return out


def paste(dst, card, cx, cy, scale, alpha=1.0, blur=0.0, angle=0.0):
    """把卡片（BGRA float）縮放、旋轉、模糊後，以 (cx, cy) 為中心蓋到 dst（BGR float）上。"""
    if scale <= .02 or alpha <= .01:
        return
    h, w = card.shape[:2]
    nw, nh = max(2, int(w * scale)), max(2, int(h * scale))
    c = cv2.resize(card, (nw, nh), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
    if abs(angle) > .3:
        M = cv2.getRotationMatrix2D((nw / 2, nh / 2), angle, 1.0)
        cos, sin = abs(M[0, 0]), abs(M[0, 1])
        bw, bh = int(nh * sin + nw * cos) + 2, int(nh * cos + nw * sin) + 2
        M[0, 2] += bw / 2 - nw / 2
        M[1, 2] += bh / 2 - nh / 2
        c = cv2.warpAffine(c, M, (bw, bh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
        nw, nh = bw, bh
    if blur > .3:
        c = cv2.GaussianBlur(c, (0, 0), blur)
    x0, y0 = int(round(cx - nw / 2)), int(round(cy - nh / 2))
    H, W = dst.shape[:2]
    ax, ay, bx, by = max(0, x0), max(0, y0), min(W, x0 + nw), min(H, y0 + nh)
    if ax >= bx or ay >= by:
        return
    piece = c[ay - y0:by - y0, ax - x0:bx - x0]
    a = piece[:, :, 3:] * alpha
    dst[ay:by, ax:bx] = piece[:, :, :3] * a + dst[ay:by, ax:bx] * (1 - a)


def ease_back(x):   # 彈出：衝過頭一點再回來
    x = min(1.0, max(0.0, x))
    c = 1.70158
    return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2


def ease_out(x):
    x = min(1.0, max(0.0, x))
    return 1 - (1 - x) ** 3


def envelope(t, dur, delay=0.0):
    """開頭彈出、結尾縮小淡出：回傳（大小倍數, 透明度）。"""
    a = (t - delay) / POP_IN
    if a <= 0:
        return 0.0, 0.0
    s = ease_back(a)
    out = (dur - t) / POP_OUT
    if out < 1:
        o = max(0.0, out)
        return s * (.35 + .65 * o), o
    return s, min(1.0, a * 2)


# ---------------- 兩種特效每一格怎麼排 ----------------
def orbit_layout(t, n, head, W, H, opt, base_h):
    """每張卡片的（深度 z, x, y, 大小, 模糊）；z > 0 在人前面。"""
    hx, top, hw = head
    face_bottom = top + hw * 1.65   # 頭頂往下大約到下巴（含頭髮、帽子，約頭寬的 1.6 倍）
    cx, cy = hx, max(top + opt['drop'] * H, face_bottom + (opt['drop'] - CENTER_DROP) * H + RY * H)
    out = []
    for i in range(n):
        th = 2 * math.pi * (t / opt['period'] + i / n)
        z = math.sin(th)
        x = cx + RX * W * math.cos(th)
        y = cy + RY * H * z
        k = (z + 1) / 2
        s = opt['size'] * (.62 + .52 * k)
        if z > 0:   # 前面的卡片不要擋到臉：卡片上緣比下巴高、又跟臉左右重疊，就往下推
            half = base_h * s / 2 * .8
            if abs(x - hx) < hw * .7 + half * .6 and y - half < face_bottom:
                y = face_bottom + half
        out.append((z, x, y, s, (1 - k) * 5.0, i))
    return out


def wall_slots(n, head, W, H):
    """標題牆：卡片落在人的上方和兩側（左右交錯，越後面的越往下）。"""
    hx, top, hw = head
    side = [(.22, .15), (.78, .12), (.50, .07), (.15, .36), (.85, .33), (.27, .55), (.75, .58), (.12, .74), (.88, .76)]
    slots = []
    for fx_, fy in side:
        x, y = fx_ * W, fy * H
        if abs(x - hx) < W * .18 and top - H * .12 < y < top + H * .25:   # 太靠近頭就跳過
            continue
        slots.append((x, y))
    while len(slots) < n:
        slots.append((W * (.15 + .7 * (len(slots) % 2)), H * (.2 + .1 * len(slots))))
    return slots[:n]


def wall_layout(t, n, head, W, H, opt, slots):
    out = []
    for i in range(n):
        delay = i * .16
        p = ease_out((t - delay) / .6)
        if p <= 0:
            continue
        tx, ty = slots[i]
        dx = -1 if tx < W / 2 else 1   # 從比較近的那一邊飛進來
        sx, sy = tx + dx * W * .75, ty - H * .25
        x, y = sx + (tx - sx) * p, sy + (ty - sy) * p
        bob = math.sin(t * 2.2 + i) * H * .004   # 停住後輕輕浮動
        ang = (1 - p) * 28 * dx + (6 if i % 2 else -6) * p
        out.append((x, y + bob * p, opt['size'] * (1.25 - .25 * p), ang, delay, i))
    return out


# ---------------- 主程式：把特效疊上影片 ----------------
def probe_wh(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                          '-of', 'csv=p=0', path], capture_output=True, text=True).stdout.strip().split(',')
    return int(out[0]), int(out[1])


def load_cards(paths, n):
    imgs = []
    for p in paths[:n]:
        im = cv2.imread(p, cv2.IMREAD_COLOR)
        if im is not None:
            imgs.append(im)
    return imgs


def render(video, card_paths, out, opt, total, fps=30, preview=None):
    """在 video 的 opt['t0']～opt['t1'] 秒疊上卡片特效，存成 out（聲音原封不動）。回傳實際做的（開始, 結束）秒數；沒做回 None。"""
    W, H = probe_wh(video)
    imgs = load_cards(card_paths, opt['n'])
    if not imgs:
        return None
    t0 = opt['t0'] if opt['t0'] is not None else min(1.5, total * .12)
    t1 = opt['t1'] if opt['t1'] is not None else t0 + SEC
    t0, t1 = max(0.0, min(t0, total - 1.5)), min(t1, total - .05)
    if t1 - t0 < 1.2:
        return None
    dur = t1 - t0
    nfr = int(dur * fps)
    seg = Seg()
    bw, bh = W * CARD_W * 1.15, H * CARD_H * 1.15   # 卡片以最大時的大小先做好，之後只縮小
    cards = [make_card(im, bw, bh) for im in imgs]
    base_h = max(c.shape[0] for c in cards) * .76   # 去掉陰影留白後大約的卡片高
    n = len(cards)
    rd = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', '%.3f' % t0, '-i', video, '-t', '%.3f' % dur, '-an',
                           '-vf', 'fps=%d' % fps, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], stdout=subprocess.PIPE)
    part = out + '.fx.mp4'
    wr = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', '%dx%d' % (W, H),
                           '-r', str(fps), '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17',
                           '-pix_fmt', 'yuv420p', part], stdin=subprocess.PIPE)
    head, slots, k, shots = None, None, 0, []
    want = [int(nfr * f) for f in (.12, .45, .8)] if preview else []
    mw, mh = W // 2, H // 2
    while True:
        buf = rd.stdout.read(W * H * 3)
        if len(buf) < W * H * 3:
            break
        fr = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
        t = k / fps
        m = seg(fr, (mw, mh))
        h = head_of(m, W, H)
        if h:
            head = h if head is None else tuple(a * .75 + b * .25 for a, b in zip(head, h))   # 平滑，避免抖
        hd = head or (W / 2, H * .25, W * .2)
        mfull = cv2.GaussianBlur(cv2.resize(m, (W, H), interpolation=cv2.INTER_LINEAR), (0, 0), 1.2)[..., None]
        canvas = fr.astype(np.float32)
        if opt['fx'] == 'wall':
            if slots is None:
                slots = wall_slots(n, hd, W, H)
            for x, y, s, ang, delay, i in wall_layout(t, n, hd, W, H, opt, slots):
                o = min(1.0, (dur - t) / POP_OUT)   # 飛進來就是開場；結尾縮小淡出
                paste(canvas, cards[i], x, y, s * (.35 + .65 * o), o, 0, ang)
            canvas = canvas * (1 - mfull) + fr.astype(np.float32) * mfull   # 卡片在人後面
        else:
            lay = sorted(orbit_layout(t, n, hd, W, H, opt, base_h))
            for z, x, y, s, blur, i in lay:   # 後面的卡片
                if z <= 0:
                    es, ea = envelope(t, dur, i * .07)
                    paste(canvas, cards[i], x, y, s * es, ea * (.82 + .18 * (z + 1)), blur * (.5 + .5 * es))
            canvas = canvas * (1 - mfull) + fr.astype(np.float32) * mfull   # 人蓋在後面的卡片上
            for z, x, y, s, blur, i in lay:   # 前面的卡片
                if z > 0:
                    es, ea = envelope(t, dur, i * .07)
                    paste(canvas, cards[i], x, y, s * es, ea, 0)
        img = np.clip(canvas, 0, 255).astype(np.uint8)
        wr.stdin.write(img.tobytes())
        if k in want:
            shots.append(img)
        if k % 30 == 0:
            log('卡片特效 %d/%d 格' % (k, nfr))
        k += 1
    rd.wait()
    wr.stdin.close()
    wr.wait()
    if not k:
        return None
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', video, '-i', part, '-filter_complex',
                    '[1:v]setpts=PTS-STARTPTS+%.3f/TB[o];[0:v][o]overlay=eof_action=pass[v]' % t0,
                    '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
                    '-pix_fmt', 'yuv420p', '-r', str(fps), '-c:a', 'copy', out], check=True)
    os.remove(part)
    if preview and shots:
        th = [cv2.resize(s, (W * 640 // H, 640)) for s in shots]
        cv2.imwrite(preview, np.hstack(th), [cv2.IMWRITE_JPEG_QUALITY, 88])
    return t0, t0 + k / fps


if __name__ == '__main__':
    a = sys.argv[1:]
    wall = '--wall' in a
    pv = a[a.index('--preview') + 1] if '--preview' in a else None
    a = [x for i, x in enumerate(a) if not x.startswith('--') and (i == 0 or a[i - 1] != '--preview')]
    vid, folder, s0, s1 = a[:4]
    dst = a[4] if len(a) > 4 else 'output.mp4'
    o, _ = card_opts('')
    o.update(fx='wall' if wall else 'orbit', t0=float(s0), t1=float(s1))
    pics = sorted(p for p in glob.glob(os.path.join(folder, '*')) if p.lower().endswith(IMG_EXT))
    tot = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', vid],
                               capture_output=True, text=True).stdout)
    print(render(vid, pics, dst, o, tot, preview=pv))
