#!/usr/bin/env python3
"""Generate a 1024x1024 app-icon PNG (no PIL): dark rounded square + accent check."""
import struct, zlib, math, sys

W = H = 1024
BG = (0x16, 0x18, 0x1D)      # dark
PANEL = (0x5B, 0x8C, 0xFF)   # accent blue
CHECK = (0xFF, 0xFF, 0xFF)

def rounded(x, y, x0, y0, x1, y1, r):
    # inside rounded rect [x0,x1]x[y0,y1] with corner radius r?
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    qx, qy = ax + t * dx, ay + t * dy
    return math.hypot(px - qx, py - qy)

# checkmark path (two segments), thickness
c1 = (330, 540, 470, 680)
c2 = (470, 680, 720, 360)
TH = 46

raw = bytearray()
for y in range(H):
    raw.append(0)  # PNG filter type 0
    for x in range(W):
        r, g, b = BG
        if rounded(x, y, 130, 130, 894, 894, 150):
            r, g, b = PANEL
            d = min(seg_dist(x, y, *c1), seg_dist(x, y, *c2))
            if d <= TH:
                r, g, b = CHECK
        raw += bytes((r, g, b))

def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
png += chunk(b"IEND", b"")

out = sys.argv[1] if len(sys.argv) > 1 else "icon-source.png"
with open(out, "wb") as f:
    f.write(png)
print("wrote", out)
