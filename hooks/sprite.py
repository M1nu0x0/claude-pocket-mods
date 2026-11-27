"""Download a PokéAPI sprite and print it as JSON pixel frames (stdlib only).

Output: {"w": int, "h": int, "loop": seconds, "frames": [[row, ...], ...]} where each
row is 6 hex chars per pixel and "......" marks a transparent pixel. Frames come from
the Black/White animated GIF, evenly picked, cropped to the bounding box they share;
without a GIF, the still PNG is the one frame.
"""

from __future__ import annotations

import json
import struct
import sys
import urllib.error
import urllib.request
import zlib
from collections.abc import Iterator, Sequence
from http.client import HTTPResponse
from typing import NamedTuple, Optional, cast

BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon"
MAX_SIDE = 128
MAX_FRAMES = 12
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}

RGB = tuple[int, int, int]
Pixel = Optional[RGB]  # aliases run at import time, and 3.9 has no `X | None` there
Frame = list[list[Pixel]]


class Png(NamedTuple):
    w: int
    h: int
    depth: int
    ctype: int
    palette: list[RGB]
    trns: bytes
    idat: bytes


class Control(NamedTuple):
    delay: int = 10
    transparent: int | None = None
    disposal: int = 0


class Image(NamedTuple):
    x: int
    y: int
    w: int
    h: int
    interlaced: bool
    table: list[RGB]
    min_size: int
    packed: bytes


class Box(NamedTuple):
    x0: int
    y0: int
    x1: int
    y1: int


def download(url: str) -> bytes | None:
    try:
        with cast(HTTPResponse, urllib.request.urlopen(url, timeout=20)) as res:
            return res.read()
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return None
        sys.exit(f"download failed: HTTP {err.code} {url}")
    except (urllib.error.URLError, TimeoutError) as err:
        sys.exit(f"download failed: {getattr(err, 'reason', err)}")


def png_chunks(data: bytes) -> Iterator[tuple[bytes, bytes]]:
    pos = 8
    while pos < len(data):
        n: int = struct.unpack(">I", data[pos : pos + 4])[0]
        yield data[pos + 4 : pos + 8], data[pos + 8 : pos + 8 + n]
        pos += 12 + n


def parse_png(data: bytes) -> Png:
    if data[:8] != PNG_SIGNATURE:
        sys.exit("not a PNG")
    idat, trns = b"", b""
    pal: list[RGB] = []
    w = h = depth = ctype = 0
    interlace: int | None = None
    for kind, body in png_chunks(data):
        if kind == b"IHDR":
            ihdr: tuple[int, int, int, int, int, int, int] = struct.unpack(
                ">IIBBBBB", body
            )
            w, h, depth, ctype, _, _, interlace = ihdr
        elif kind == b"PLTE":
            pal = [
                (body[i], body[i + 1], body[i + 2]) for i in range(0, len(body) - 2, 3)
            ]
        elif kind == b"tRNS":
            trns = body
        elif kind == b"IDAT":
            idat += body
    if interlace is None:
        sys.exit("broken PNG")
    if interlace:
        sys.exit("interlaced PNG is not supported")
    return Png(w, h, depth, ctype, pal, trns, idat)


def paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


def unfilter_line(filt: int, line: bytearray, prev: bytearray, bpp: int) -> bytearray:
    for x in range(len(line)):
        a = line[x - bpp] if x >= bpp else 0
        b = prev[x]
        c = prev[x - bpp] if x >= bpp else 0
        if filt == 1:
            line[x] = (line[x] + a) & 255
        elif filt == 2:
            line[x] = (line[x] + b) & 255
        elif filt == 3:
            line[x] = (line[x] + (a + b) // 2) & 255
        elif filt == 4:
            line[x] = (line[x] + paeth(a, b, c)) & 255
    return line


def unfilter(raw: bytes, h: int, stride: int, bpp: int) -> list[bytearray]:
    rows: list[bytearray] = []
    prev = bytearray(stride)
    for y in range(h):
        i = y * (1 + stride)
        prev = unfilter_line(raw[i], bytearray(raw[i + 1 : i + 1 + stride]), prev, bpp)
        rows.append(prev)
    return rows


def samples(line: bytearray, x: int, channels: int, depth: int) -> Sequence[int]:
    if depth == 8:
        return line[x * channels : (x + 1) * channels]
    if depth == 16:
        return [line[(x * channels + k) * 2] for k in range(channels)]
    bit = x * depth
    return [(line[bit // 8] >> (8 - depth - bit % 8)) & ((1 << depth) - 1)]


def to_pixel(s: Sequence[int], png: Png) -> Pixel:
    if png.ctype == 3:
        alpha = png.trns[s[0]] if s[0] < len(png.trns) else 255
        return png.palette[s[0]] if alpha >= 128 else None
    if png.ctype == 6:
        return (s[0], s[1], s[2]) if s[3] >= 128 else None
    if png.ctype == 2:
        return (s[0], s[1], s[2])
    if png.ctype == 4:
        return (s[0], s[0], s[0]) if s[1] >= 128 else None
    v = s[0] * 255 // ((1 << png.depth) - 1) if png.depth < 8 else s[0]
    return (v, v, v)


def decode_png(data: bytes) -> tuple[int, int, Frame]:
    png = parse_png(data)
    channels = CHANNELS[png.ctype]
    bpp = max(1, channels * png.depth // 8)
    stride = (png.w * channels * png.depth + 7) // 8
    rows = unfilter(zlib.decompress(png.idat), png.h, stride, bpp)
    pixels = [
        [to_pixel(samples(line, x, channels, png.depth), png) for x in range(png.w)]
        for line in rows
    ]
    return png.w, png.h, pixels


def lzw(data: bytes, min_size: int, count: int) -> bytearray:
    clear, end = 1 << min_size, (1 << min_size) + 1
    size = min_size + 1
    table = [bytes([i]) for i in range(clear)] + [b"", b""]
    data = data + b"\0\0\0"
    prev: bytes | None = None
    out, bit, total = bytearray(), 0, (len(data) - 3) * 8
    while bit + size <= total and len(out) < count:
        i = bit >> 3
        code = ((data[i] | data[i + 1] << 8 | data[i + 2] << 16) >> (bit & 7)) & (
            (1 << size) - 1
        )
        bit += size
        if code == clear:
            size, table, prev = min_size + 1, table[: clear + 2], None
            continue
        if code == end:
            break
        if prev is None:
            entry = table[code]
        else:
            entry = table[code] if code < len(table) else prev + prev[:1]
            if len(table) < 4096:
                table.append(prev + entry[:1])
                if len(table) == 1 << size and size < 12:
                    size += 1
        out += entry
        prev = entry
    return out


def color_table(data: bytes, pos: int, flags: int) -> tuple[list[RGB], int]:
    n = 2 << (flags & 7)
    return [
        (data[pos + 3 * i], data[pos + 3 * i + 1], data[pos + 3 * i + 2])
        for i in range(n)
    ], pos + 3 * n


def sub_blocks(data: bytes, pos: int) -> tuple[bytes, int]:
    body = bytearray()
    while data[pos]:
        body += data[pos + 1 : pos + 1 + data[pos]]
        pos += 1 + data[pos]
    return bytes(body), pos + 1


def gif_header(data: bytes) -> tuple[int, int, list[RGB] | None, int]:
    if data[:6] not in (b"GIF87a", b"GIF89a"):
        sys.exit("not a GIF")
    header: tuple[int, int, int] = struct.unpack("<HHB", data[6:11])
    w, h, flags = header
    if flags & 0x80:
        gct, pos = color_table(data, 13, flags)
        return w, h, gct, pos
    return w, h, None, 13


def graphic_control(body: bytes) -> Control:
    gce: tuple[int, int, int] = struct.unpack("<BHB", body)
    packed, delay, index = gce
    return Control(delay or 10, index if packed & 1 else None, (packed >> 2) & 7)


def gif_image(data: bytes, pos: int, gct: list[RGB] | None) -> tuple[Image, int]:
    desc: tuple[int, int, int, int, int] = struct.unpack("<HHHHB", data[pos : pos + 9])
    x, y, w, h, local = desc
    pos += 9
    table = gct
    if local & 0x80:
        table, pos = color_table(data, pos, local)
    if table is None:
        sys.exit("broken GIF")
    min_size = data[pos]
    packed, pos = sub_blocks(data, pos + 1)
    return Image(x, y, w, h, bool(local & 0x40), table, min_size, packed), pos


def row_order(h: int, interlaced: bool) -> list[int]:
    if not interlaced:
        return list(range(h))
    return (
        list(range(0, h, 8))
        + list(range(4, h, 8))
        + list(range(2, h, 4))
        + list(range(1, h, 2))
    )


def paint(
    canvas: list[Pixel], w: int, h: int, image: Image, transparent: int | None
) -> None:
    order = row_order(image.h, image.interlaced)
    for i, index in enumerate(lzw(image.packed, image.min_size, image.w * image.h)):
        if index == transparent or index >= len(image.table):
            continue
        x, y = image.x + i % image.w, image.y + order[i // image.w]
        if x < w and y < h:
            canvas[y * w + x] = image.table[index]


def clear(canvas: list[Pixel], w: int, h: int, image: Image) -> None:
    for y in range(image.y, min(image.y + image.h, h)):
        for x in range(image.x, min(image.x + image.w, w)):
            canvas[y * w + x] = None


def decode_gif(data: bytes) -> tuple[int, int, list[Frame], float]:
    w, h, gct, pos = gif_header(data)
    canvas: list[Pixel] = [None] * (w * h)
    frames: list[Frame] = []
    delays: list[int] = []
    control = Control()
    while pos < len(data):
        block = data[pos]
        pos += 1
        if block == 0x3B:
            break
        if block == 0x21:
            if data[pos] == 0xF9:
                control = graphic_control(data[pos + 2 : pos + 6])
            _, pos = sub_blocks(data, pos + 1)
            continue
        if block != 0x2C:
            sys.exit("broken GIF")
        image, pos = gif_image(data, pos, gct)
        saved = list(canvas) if control.disposal == 3 else None
        paint(canvas, w, h, image, control.transparent)
        frames.append([canvas[y * w : (y + 1) * w] for y in range(h)])
        delays.append(control.delay)
        if control.disposal == 2:
            clear(canvas, w, h, image)
        elif saved is not None:
            canvas = saved
        control = Control()
    return w, h, frames, sum(delays) / 100


def pick_frames(frames: list[Frame]) -> list[Frame]:
    if len(frames) <= MAX_FRAMES:
        return frames
    return [frames[i * len(frames) // MAX_FRAMES] for i in range(MAX_FRAMES)]


def bounding_box(frames: list[Frame], w: int, h: int) -> Box | None:
    opaque = [
        (x, y)
        for f in frames
        for y in range(h)
        for x in range(w)
        if f[y][x] is not None
    ]
    if not opaque:
        return None
    x0, x1 = min(x for x, _ in opaque), max(x for x, _ in opaque) + 1
    y0, y1 = min(y for _, y in opaque), max(y for _, y in opaque) + 1
    return Box(x0, y0, min(x1, x0 + MAX_SIDE), min(y1, y0 + MAX_SIDE))


def hex_rows(frame: Frame, box: Box) -> list[str]:
    return [
        "".join(bytes(p).hex() if p else "......" for p in frame[y][box.x0 : box.x1])
        for y in range(box.y0, box.y1)
    ]


def encode(frames: list[Frame], w: int, h: int, loop: float) -> dict[str, object]:
    frames = pick_frames(frames)
    box = bounding_box(frames, w, h)
    if box is None:
        sys.exit("sprite is empty")
    return {
        "w": box.x1 - box.x0,
        "h": box.y1 - box.y0,
        "loop": max(loop, 0.1),
        "frames": [hex_rows(f, box) for f in frames],
    }


def main(pid: int, shiny: bool = False) -> dict[str, object]:
    folder = "shiny/" if shiny else ""
    black_white = f"{BASE}/versions/generation-v/black-white"
    gif = download(f"{black_white}/animated/{folder}{pid}.gif")
    if gif:
        w, h, frames, loop = decode_gif(gif)
        return encode(frames, w, h, loop)
    png = download(f"{black_white}/{folder}{pid}.png") or download(
        f"{BASE}/{folder}{pid}.png"
    )
    if not png:
        sys.exit(f"no {'shiny ' if shiny else ''}sprite for #{pid}")
    w, h, pixels = decode_png(png)
    return encode([pixels], w, h, 1)


if __name__ == "__main__":
    print(json.dumps(main(int(sys.argv[1]), sys.argv[2:] == ["shiny"])))
