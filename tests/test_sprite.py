from __future__ import annotations

import struct
import zlib

import pytest
import sprite

RED = (255, 0, 0)
BLUE = (0, 0, 255)


def pack_codes(codes: list[int], width: int) -> bytes:
    bits = sum(code << (i * width) for i, code in enumerate(codes))
    return bits.to_bytes((len(codes) * width + 7) // 8, "little")


def lzw_stream(indices: list[int]) -> bytes:
    return pack_codes([4, *indices, 5], 3)


def gif_frame(
    x: int,
    y: int,
    w: int,
    h: int,
    indices: list[int],
    disposal: int = 0,
    transparent: int | None = None,
    delay: int = 10,
) -> bytes:
    packed = disposal << 2 | (transparent is not None)
    control = b"\x21\xf9\x04" + struct.pack("<BHB", packed, delay, transparent or 0)
    data = lzw_stream(indices)
    descriptor = b"\x2c" + struct.pack("<HHHHB", x, y, w, h, 0)
    return (
        control + b"\x00" + descriptor + b"\x02" + bytes([len(data)]) + data + b"\x00"
    )


def gif(w: int, h: int, *frames: bytes) -> bytes:
    header = b"GIF89a" + struct.pack("<HHBBB", w, h, 0x80, 0, 0)
    return header + bytes([*RED, *BLUE]) + b"".join(frames) + b"\x3b"


def png_chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + b"\0\0\0\0"


def rgba_png(rows: list[list[tuple[int, int, int, int]]]) -> bytes:
    ihdr = struct.pack(">IIBBBBB", len(rows[0]), len(rows), 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + bytes(c for px in row for c in px) for row in rows)
    return (
        sprite.PNG_SIGNATURE
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", zlib.compress(raw))
        + png_chunk(b"IEND", b"")
    )


def test_lzw_decodes_literal_codes() -> None:
    data = pack_codes([4, 1, 0, 5], 3)

    out = sprite.lzw(data, 2, 100)

    assert out == bytearray([1, 0])


def test_lzw_decodes_code_not_yet_in_table() -> None:
    data = pack_codes([4, 1, 6, 5], 3)

    out = sprite.lzw(data, 2, 100)

    assert out == bytearray([1, 1, 1])


def test_lzw_stops_at_end_code() -> None:
    data = pack_codes([4, 2, 5, 3], 3)

    out = sprite.lzw(data, 2, 100)

    assert out == bytearray([2])


def test_paeth_picks_nearest_neighbour() -> None:
    assert sprite.paeth(10, 20, 10) == 20
    assert sprite.paeth(20, 10, 10) == 20
    assert sprite.paeth(5, 5, 5) == 5


@pytest.mark.parametrize(
    ("filt", "expected"),
    [
        (0, [1, 2, 3]),
        (1, [1, 3, 6]),
        (2, [11, 22, 33]),
        (3, [6, 15, 25]),
        (4, [11, 22, 33]),
    ],
)
def test_unfilter_line_restores_each_filter(filt: int, expected: list[int]) -> None:
    prev = bytearray([10, 20, 30])

    line = sprite.unfilter_line(filt, bytearray([1, 2, 3]), prev, 1)

    assert list(line) == expected


def test_unfilter_feeds_each_row_into_the_next() -> None:
    raw = bytes([0, 5, 6, 2, 1, 1])

    rows = sprite.unfilter(raw, 2, 2, 1)

    assert [list(r) for r in rows] == [[5, 6], [6, 7]]


def test_samples_unpacks_sub_byte_depths() -> None:
    line = bytearray([0b10_01_11_00])

    values = [sprite.samples(line, x, 1, 2)[0] for x in range(4)]

    assert values == [2, 1, 3, 0]


def test_to_pixel_hides_low_alpha_palette_entries() -> None:
    png = sprite.Png(1, 1, 8, 3, [RED, BLUE], b"\xff\x00", b"")

    assert sprite.to_pixel([0], png) == RED
    assert sprite.to_pixel([1], png) is None


def test_decode_png_reads_rgba_pixels() -> None:
    data = rgba_png([[(255, 0, 0, 255), (0, 0, 255, 0)]])

    w, h, pixels = sprite.decode_png(data)

    assert (w, h, pixels) == (2, 1, [[RED, None]])


def test_decode_png_rejects_interlaced() -> None:
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 1)
    data = sprite.PNG_SIGNATURE + png_chunk(b"IHDR", ihdr)

    with pytest.raises(SystemExit, match="interlaced"):
        sprite.decode_png(data)


def test_row_order_interlaced_takes_the_four_passes() -> None:
    assert sprite.row_order(8, True) == [0, 4, 2, 6, 1, 3, 5, 7]
    assert sprite.row_order(3, False) == [0, 1, 2]


def test_decode_gif_keeps_pixels_under_transparent_index() -> None:
    data = gif(
        2,
        1,
        gif_frame(0, 0, 2, 1, [0, 1], delay=20),
        gif_frame(0, 0, 2, 1, [1, 0], transparent=0, delay=30),
    )

    w, h, frames, loop = sprite.decode_gif(data)

    assert (w, h, loop) == (2, 1, 0.5)
    assert frames == [[[RED, BLUE]], [[BLUE, BLUE]]]


def test_decode_gif_disposal_2_clears_the_frame_area() -> None:
    data = gif(
        2,
        1,
        gif_frame(0, 0, 2, 1, [0, 0], disposal=2),
        gif_frame(1, 0, 1, 1, [1]),
    )

    _, _, frames, _ = sprite.decode_gif(data)

    assert frames == [[[RED, RED]], [[None, BLUE]]]


def test_decode_gif_disposal_3_restores_the_previous_canvas() -> None:
    data = gif(
        2,
        1,
        gif_frame(0, 0, 2, 1, [0, 0]),
        gif_frame(0, 0, 1, 1, [1], disposal=3),
        gif_frame(1, 0, 1, 1, [1]),
    )

    _, _, frames, _ = sprite.decode_gif(data)

    assert frames == [[[RED, RED]], [[BLUE, RED]], [[RED, BLUE]]]


def test_pick_frames_spreads_evenly_past_the_limit() -> None:
    frames: list[sprite.Frame] = [[[(i, 0, 0)]] for i in range(24)]

    picked = sprite.pick_frames(frames)

    assert [f[0][0] for f in picked] == [(i, 0, 0) for i in range(0, 24, 2)]


def test_encode_crops_to_the_box_all_frames_share() -> None:
    first: sprite.Frame = [[None] * 3, [None, RED, None], [None] * 3]
    second: sprite.Frame = [[None] * 3, [None, None, BLUE], [None] * 3]

    out = sprite.encode([first, second], 3, 3, 0.05)

    assert out == {
        "w": 2,
        "h": 1,
        "loop": 0.1,
        "frames": [["ff0000......"], ["......0000ff"]],
    }


def test_bounding_box_clamps_to_max_side() -> None:
    side = sprite.MAX_SIDE + 2
    frame: sprite.Frame = [[RED] * side for _ in range(side)]

    box = sprite.bounding_box([frame], side, side)

    assert box == sprite.Box(0, 0, sprite.MAX_SIDE, sprite.MAX_SIDE)


def test_encode_exits_on_an_empty_sprite() -> None:
    with pytest.raises(SystemExit, match="empty"):
        sprite.encode([[[None]]], 1, 1, 1)


def test_shiny_never_falls_back_to_the_normal_colors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    urls: list[str] = []
    monkeypatch.setattr(sprite, "download", urls.append)

    with pytest.raises(SystemExit, match="no shiny sprite for #25"):
        sprite.main(25, shiny=True)

    assert [url.removeprefix(sprite.BASE) for url in urls] == [
        "/versions/generation-v/black-white/animated/shiny/25.gif",
        "/versions/generation-v/black-white/shiny/25.png",
        "/shiny/25.png",
    ]
