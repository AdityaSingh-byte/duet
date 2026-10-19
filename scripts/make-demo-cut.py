"""Cuts the comment demo's two recordings into the short video and GIF in docs/media.

    duet scenario run examples/comment-after-rename.yaml --record --pace 900 --runs-dir .duet/takes/comments-bug    # server with COMMUNITY_BUG=1
    duet scenario run examples/comment-after-rename.yaml --record --pace 900 --runs-dir .duet/takes/comments-fixed  # server without it
    python3 scripts/make-demo-cut.py .duet/takes/comments-bug/<run>/video/run.mp4 .duet/takes/comments-fixed/<run>/video/run.mp4

Real footage only: the run with the bug and the run with the fix, sped up, with plain captions,
a FAIL and a PASS freeze that box the comment in question, and a title and end card.
Writes docs/media/demo-comments.mp4 and demo-comments.gif. Needs ffmpeg, Pillow and macOS
(for the system font). The pane positions and the boxed rows below are for that scenario's
layout (Chrome at 960x900 beside a 1080x2340 phone); another layout needs them measured again,
and the cut points follow the step times in each run's events.jsonl.
"""

import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

BUG_RUN = os.path.abspath(sys.argv[1])
FIX_RUN = os.path.abspath(sys.argv[2])
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', 'media')
WORK = tempfile.mkdtemp(prefix='duet-demo-cut-')

W, H, FPS = 1600, 1080, 25
BAR = 120                       # caption bar above the footage
SRC_W, SRC_H = 1566, 1044       # duet's run video
SCALE = (H - BAR) / SRC_H
FOOT_W = round(SRC_W * SCALE) // 2 * 2
FOOT_X = (W - FOOT_W) // 4 * 2  # even, as the encoder wants
# Each pane's left and right edge in the run video, and the panes' top and bottom.
PANELS = {'maya': (24, 1086), 'phone': (1110, 1542)}
PANEL_Y = (56, 956)
# The comment rows the freezes point at, in run-video pixels.
BROWSER_ALEX = (205, 627, 900, 688)
PHONE_ALEX = (1122, 652, 1528, 702)
BROWSER_ALEX_AND_REPLY = (205, 627, 900, 765)
PHONE_ALEX_AND_REPLY = (1122, 652, 1528, 770)

BG = (20, 20, 20)  # duet's own video background, so no seam shows
TEXT = (240, 240, 242)
MUTED = (150, 150, 158)
RED = (229, 72, 77)
GREEN = (48, 164, 108)
NEUTRAL = (82, 82, 91)



def font(size, weight='Regular'):
    face = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', size)
    face.set_variation_by_name(weight)
    return face


MONO = lambda size: ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', size)


def place(x0, y0, x1, y1):
    """A run-video rectangle on the output canvas."""
    return (FOOT_X + x0 * SCALE, BAR + y0 * SCALE, FOOT_X + x1 * SCALE, BAR + y1 * SCALE)


def labels(draw):
    """Who each pane is, in place of the recording's actor names."""
    for name, title in (('maya', 'Maya, in Chrome'), ('phone', 'Alex, on an Android phone')):
        x0, y0, x1, _ = place(PANELS[name][0], PANEL_Y[0], PANELS[name][1], PANEL_Y[1])
        draw.rectangle([x0 - 4, BAR, x1 + 4, y0 - 1], fill=BG)
        draw.text(((x0 + x1) / 2, (BAR + y0) / 2), title, font=font(24, 'Semibold'), fill=TEXT, anchor='mm')


def overlay(path, tag=None, caption=None, color=TEXT, boxes=()):
    """The caption bar and pane names, transparent over the footage, and any boxes."""
    image = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, W, BAR], fill=BG)
    labels(draw)
    if tag:
        draw.text((FOOT_X, 22), tag, font=font(28, 'Semibold'), fill=MUTED)
    if caption:
        draw.text((FOOT_X, 58), caption, font=font(42, 'Semibold'), fill=color)
    for rect, line in boxes:
        x0, y0, x1, y1 = place(*rect)
        draw.rounded_rectangle([x0 - 10, y0 - 6, x1 + 10, y1 + 6], radius=8, outline=line, width=5)
    image.save(path)
    return path


def card(path, lines):
    image = Image.new('RGB', (W, H), BG)
    draw = ImageDraw.Draw(image)
    y = H / 2 - sum(height for _, _, height, _ in lines) / 2
    for text, face, height, color in lines:
        draw.text((W / 2, y + height / 2), text, font=face, fill=color, anchor='mm')
        y += height
    image.save(path)
    return path


def run(args):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *args], check=True)


ENCODE = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', str(FPS), '-preset', 'slow', '-crf', '20', '-an']
FIT = f'scale={FOOT_W}:{H - BAR},format=rgba,pad={W}:{H}:{FOOT_X}:{BAR}:color=0x141414ff'


def still(name, image, seconds):
    out = os.path.join(WORK, f'{name}.mp4')
    run(['-loop', '1', '-t', str(seconds), '-i', image, '-vf', f'fps={FPS},format=yuv420p', *ENCODE, out])
    return out


def footage(name, source, start, end, speed, overlays):
    """A sped-up stretch of a recording; each overlay shown from its start second (output time)."""
    out = os.path.join(WORK, f'{name}.mp4')
    inputs = ['-ss', str(start), '-to', str(end), '-i', source]
    for _, image in overlays:
        inputs += ['-i', image]
    chain = f'[0:v]setpts=PTS/{speed},{FIT}[v0]'
    for index, (begin, _) in enumerate(overlays):
        until = overlays[index + 1][0] if index + 1 < len(overlays) else 999
        chain += f';[v{index}][{index + 1}:v]overlay=0:0:enable=\'between(t,{begin},{until})\'[v{index + 1}]'
    chain += f';[v{len(overlays)}]format=yuv420p,scale={W}:{H}[out]'
    run([*inputs, '-filter_complex', chain, '-map', '[out]', *ENCODE, out])
    return out


def freeze(name, source, at, seconds, overlay_image):
    frame = os.path.join(WORK, f'{name}.png')
    run(['-ss', str(at), '-i', source, '-frames:v', '1', '-vf', FIT, frame])
    base = Image.open(frame).convert('RGBA')
    base.alpha_composite(Image.open(overlay_image))
    base.convert('RGB').save(frame)
    return still(name, frame, seconds)


def main():
    title = card(os.path.join(WORK, 'title.png'), [
        ('duet', font(120, 'Bold'), 170, TEXT),
        ('An AI agent tests one feature on a real Android phone', font(44), 62, TEXT),
        ('and in a browser, at the same time.', font(44), 90, TEXT),
        ('A real run, recorded by duet. Sped up.', font(28), 50, MUTED),
    ])
    end = card(os.path.join(WORK, 'end.png'), [
        ('duet', font(120, 'Bold'), 170, TEXT),
        ('npm install -g duet-qa', MONO(46), 80, TEXT),
        ('github.com/AdityaSingh-byte/duet', font(42, 'Semibold'), 80, TEXT),
        ('Open source, MIT', font(28), 50, MUTED),
    ])
    one = 'Run 1: the server has a bug'
    two = 'Run 2: with the fix'
    o = lambda key, *args, **kw: overlay(os.path.join(WORK, f'{key}.png'), *args, **kw)

    parts = [
        still('p1', title, 2.4),
        footage('p2', BUG_RUN, 5.5, 26.8, 5, [
            (0, o('r1a', one, 'Alex opens the post on the phone and comments')),
            (3.2, o('r1b', one, "The comment shows up in Maya's browser, live")),
        ]),
        footage('p3', BUG_RUN, 26.8, 50.6, 5, [
            (0, o('r1c', one, 'Alex changes their name to Alex Rivera')),
            (3.5, o('r1d', one, 'On the phone, the comment shows the new name')),
        ]),
        footage('p4', BUG_RUN, 50.6, 56.6, 3, [
            (0, o('r1e', one, "Maya's browser must show it too")),
        ]),
        freeze('p5', BUG_RUN, 59, 3.8, o(
            'fail', one, 'FAIL: the phone says Alex Rivera, Maya still sees Alex', RED,
            boxes=[(BROWSER_ALEX, RED), (PHONE_ALEX, NEUTRAL)],
        )),
        footage('p6', FIX_RUN, 5.5, 51.1, 10, [
            (0, o('r2a', two, 'The same 29 steps, after the fix')),
        ]),
        footage('p7', FIX_RUN, 51.1, 57.5, 2.5, [
            (0, o('r2b', two, 'Maya sees Alex Rivera, replies, and the phone gets it')),
        ]),
        freeze('p8', FIX_RUN, 58.5, 3.8, o(
            'pass', two, 'PASS: 29 of 29 steps, on the phone and in the browser', GREEN,
            boxes=[(BROWSER_ALEX_AND_REPLY, GREEN), (PHONE_ALEX_AND_REPLY, GREEN)],
        )),
        still('p9', end, 3.4),
    ]
    listing = os.path.join(WORK, 'parts.txt')
    with open(listing, 'w') as out:
        out.write(''.join(f"file '{part}'\n" for part in parts))
    video = os.path.join(OUT, 'demo-comments.mp4')
    run(['-f', 'concat', '-safe', '0', '-i', listing, '-c', 'copy', '-movflags', '+faststart', video])
    gif = os.path.join(OUT, 'demo-comments.gif')
    run(['-i', video, '-vf', 'fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none', '-loop', '0', gif])
    for path in (video, gif):
        print(path, f'{os.path.getsize(path) / 1e6:.1f} MB')
    print('work folder:', WORK)


main()
