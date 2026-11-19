#!/usr/bin/env python3
"""Build docs/images/demo.gif from the frames scripts/demo/record.mjs took (needs Pillow).

Usage: python3 scripts/demo/make-gif.py FRAMES_DIR OUT.gif [--width PX]

FRAMES_DIR holds the PNG frames and frames.json ({"frames": [{"file", "ms"}]}). Every frame is scaled to --width
(default 1100), then all of them share one 255-colour palette made from the frames that change the most, with entries
set aside for the coloured accents (no dithering: the UI is flat, and dithering would make every frame differ).
Identical neighbours are merged into one longer frame, and Pillow stores each frame as the rectangle that changed,
unchanged pixels transparent. Loops forever.
"""
import argparse
import json
import math
import os

from PIL import Image, ImageChops

PALETTE_SOURCES = 14  # frames stacked to build the shared palette
ACCENTS = 64  # palette entries kept for coloured pixels (the rest go to the greys of the dark UI)


def load(folder, width):
    with open(os.path.join(folder, 'frames.json')) as f:
        meta = json.load(f)
    out = []
    for fr in meta['frames']:
        im = Image.open(os.path.join(folder, fr['file'])).convert('RGB')
        h = round(im.height * width / im.width)
        im = im.resize((width, h), Image.Resampling.LANCZOS, reducing_gap=2.0)
        if out and ImageChops.difference(out[-1][0], im).getbbox() is None:
            out[-1][1] += fr['ms']
        else:
            out.append([im, fr['ms']])
    return out


def changed_area(a, b):
    box = ImageChops.difference(a, b).getbbox()
    return 0 if box is None else (box[2] - box[0]) * (box[3] - box[1])


def median_cut(colors, k, damp):
    """k colours for a list of (count, rgb). Counts are damped (count ** damp): plain median cut spends the palette on
    the dark background and turns the small amber and violet accents grey."""
    px = []
    for c, rgb in colors:
        px.extend([rgb] * max(1, round(c**damp)))
    side = math.ceil(math.sqrt(len(px)))
    im = Image.new('RGB', (side, side))
    im.putdata(px + [px[-1]] * (side * side - len(px)))
    return im.quantize(colors=k, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).getpalette()[: 3 * k]


def shared_palette(frames):
    # The first and last frames plus the ones that change the most (new pages, the dialog, scrolling).
    scored = sorted(range(1, len(frames)), key=lambda i: changed_area(frames[i - 1][0], frames[i][0]), reverse=True)
    picks = sorted({0, len(frames) - 1, *scored[: PALETTE_SOURCES - 2]})
    w, h = frames[0][0].size
    sheet = Image.new('RGB', (w, h * len(picks)))
    for n, i in enumerate(picks):
        sheet.paste(frames[i][0], (0, n * h))
    colors = sheet.getcolors(maxcolors=1 << 24)
    accents = [c for c in colors if max(c[1]) - min(c[1]) > 24]
    greys = [c for c in colors if max(c[1]) - min(c[1]) <= 24]
    # 255 colours in all: Pillow uses the free index for the unchanged (transparent) pixels of delta frames.
    pal = Image.new('P', (1, 1))
    # (greys damped less: the near-blacks behind the dialog need their own entries, or they turn brown)
    n = min(ACCENTS, len(accents))
    pal.putpalette((median_cut(accents, n, 0.25) if n else []) + median_cut(greys, 255 - n, 0.4))
    return pal


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('frames')
    ap.add_argument('out')
    ap.add_argument('--width', type=int, default=1100)
    a = ap.parse_args()

    frames = load(a.frames, a.width)
    pal = shared_palette(frames)
    images, durations = [], []
    for im, ms in frames:
        q = im.quantize(palette=pal, dither=Image.Dither.NONE)
        if images and ImageChops.difference(images[-1].convert('RGB'), q.convert('RGB')).getbbox() is None:
            durations[-1] += ms
            continue
        images.append(q)
        durations.append(ms)
    # GIF delays are in hundredths of a second
    durations = [max(20, round(ms / 10) * 10) for ms in durations]
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    images[0].save(a.out, save_all=True, append_images=images[1:], duration=durations, loop=0, disposal=1, optimize=True)
    w, h = images[0].size
    print(f'{a.out}: {w}×{h}, {len(images)} frames, {sum(durations) / 1000:.1f} s, {os.path.getsize(a.out) / 1024:.0f} KB')


if __name__ == '__main__':
    main()
