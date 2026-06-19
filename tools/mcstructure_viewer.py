#!/usr/bin/env python3
"""
mcstructure_viewer.py — viewer + registry editor for the FallingFalling
challenge structures.

Two things in one window, no pip installs (pure stdlib: tkinter + struct):

  VIEW   any Bedrock .mcstructure file, layer by layer (Y / X / Z slices).
  EDIT   FF_BP/scripts/structures/index.js — add/edit/delete spawn points and
         chests visually on the structure, set per-phase mobs & loot, flags,
         baseWeight, etc. Saves back to index.js (preserving the comment
         banners) with a timestamped backup and a round-trip safety check.

Run:
  python mcstructure_viewer.py                 (auto-loads the nearby index.js)
  python mcstructure_viewer.py some.mcstructure (just view that file)

Spawn/chest coordinates are LOCAL offsets from the .mcstructure MIN corner,
y = feet position — exactly what the engine expects.
"""

import os
import sys
import struct
import datetime
import tkinter as tk
from tkinter import ttk, filedialog, messagebox


# ==========================================================================
# Little-endian NBT reader (Bedrock .mcstructure)
# ==========================================================================
class _Reader:
    def __init__(self, data):
        self.d = data
        self.i = 0

    def u8(self):
        v = self.d[self.i]; self.i += 1; return v

    def i8(self):
        v = struct.unpack_from('<b', self.d, self.i)[0]; self.i += 1; return v

    def i16(self):
        v = struct.unpack_from('<h', self.d, self.i)[0]; self.i += 2; return v

    def i32(self):
        v = struct.unpack_from('<i', self.d, self.i)[0]; self.i += 4; return v

    def i64(self):
        v = struct.unpack_from('<q', self.d, self.i)[0]; self.i += 8; return v

    def f32(self):
        v = struct.unpack_from('<f', self.d, self.i)[0]; self.i += 4; return v

    def f64(self):
        v = struct.unpack_from('<d', self.d, self.i)[0]; self.i += 8; return v

    def string(self):
        n = self.i16()
        v = self.d[self.i:self.i + n].decode('utf-8', 'replace')
        self.i += n
        return v


def _read_payload(r, t):
    if t == 1:  return r.i8()
    if t == 2:  return r.i16()
    if t == 3:  return r.i32()
    if t == 4:  return r.i64()
    if t == 5:  return r.f32()
    if t == 6:  return r.f64()
    if t == 7:
        n = r.i32(); v = list(r.d[r.i:r.i + n]); r.i += n; return v
    if t == 8:  return r.string()
    if t == 9:
        et = r.u8(); n = r.i32()
        return [_read_payload(r, et) for _ in range(n)]
    if t == 10:
        c = {}
        while True:
            tt = r.u8()
            if tt == 0:
                break
            name = r.string()
            c[name] = _read_payload(r, tt)
        return c
    if t == 11:
        n = r.i32(); return [r.i32() for _ in range(n)]
    if t == 12:
        n = r.i32(); return [r.i64() for _ in range(n)]
    raise ValueError("Unknown NBT tag id %d at offset %d" % (t, r.i))


def load_nbt(path):
    with open(path, 'rb') as f:
        data = f.read()
    r = _Reader(data)
    t = r.u8()
    r.string()
    return _read_payload(r, t)


class Structure:
    """Parsed .mcstructure with O(1) block lookup by (x, y, z) local coords."""

    def __init__(self, path):
        root = load_nbt(path)
        self.path = path
        self.size = root['size']
        self.sx, self.sy, self.sz = self.size
        st = root['structure']
        self.indices = st['block_indices'][0]      # primary layer
        pal = st['palette']['default']['block_palette']
        self.palette = [self._short(b.get('name', '?')) for b in pal]

    @staticmethod
    def _short(name):
        return name.split(':', 1)[1] if ':' in name else name

    def palette_index(self, x, y, z):
        return self.indices[(x * self.sy * self.sz) + (y * self.sz) + z]

    def block_name(self, x, y, z):
        pi = self.palette_index(x, y, z)
        return None if pi < 0 else self.palette[pi]

    def in_bounds(self, x, y, z):
        return 0 <= x < self.sx and 0 <= y < self.sy and 0 <= z < self.sz

    def is_empty(self, x, y, z):
        """True if no block / air at this cell."""
        if not self.in_bounds(x, y, z):
            return True
        n = self.block_name(x, y, z)
        return n is None or n == "air"

    def is_solid(self, x, y, z):
        if not self.in_bounds(x, y, z):
            return False
        return not self.is_empty(x, y, z)


# ==========================================================================
# Tolerant parser / emitter for index.js  (CHALLENGE_STRUCT_DEFS)
# ==========================================================================
EXPORT_MARKER = "export const CHALLENGE_STRUCT_DEFS"
PHASES = ["early", "mid", "late", "end"]
RARITIES = ["common", "uncommon", "rare", "mythic"]


class _JS:
    """Recursive-descent reader for a single JS object/array/value literal."""

    def __init__(self, t):
        self.t = t
        self.i = 0

    def ws(self):
        t, n = self.t, len(self.t)
        while self.i < n:
            c = t[self.i]
            if c in ' \t\r\n':
                self.i += 1
            elif c == '/' and self.i + 1 < n and t[self.i + 1] == '/':
                j = t.find('\n', self.i)
                self.i = n if j < 0 else j + 1
            elif c == '/' and self.i + 1 < n and t[self.i + 1] == '*':
                j = t.find('*/', self.i)
                self.i = n if j < 0 else j + 2
            else:
                break

    def value(self):
        self.ws()
        c = self.t[self.i]
        if c == '{':
            return self.obj()
        if c == '[':
            return self.arr()
        if c in '"\'':
            return self.string()
        return self.literal()

    def obj(self):
        self.i += 1
        d = {}
        while True:
            self.ws()
            if self.t[self.i] == '}':
                self.i += 1
                break
            key = self.key()
            self.ws()
            assert self.t[self.i] == ':', "expected ':' near %d" % self.i
            self.i += 1
            d[key] = self.value()
            self.ws()
            if self.t[self.i] == ',':
                self.i += 1
            elif self.t[self.i] == '}':
                self.i += 1
                break
        return d

    def arr(self):
        self.i += 1
        a = []
        while True:
            self.ws()
            if self.t[self.i] == ']':
                self.i += 1
                break
            a.append(self.value())
            self.ws()
            if self.t[self.i] == ',':
                self.i += 1
            elif self.t[self.i] == ']':
                self.i += 1
                break
        return a

    def key(self):
        self.ws()
        if self.t[self.i] in '"\'':
            return self.string()
        j = self.i
        while self.t[self.i] not in ' \t\r\n:':
            self.i += 1
        return self.t[j:self.i]

    def string(self):
        q = self.t[self.i]
        self.i += 1
        buf = []
        while True:
            c = self.t[self.i]
            if c == '\\':
                buf.append(self.t[self.i + 1])
                self.i += 2
                continue
            if c == q:
                self.i += 1
                break
            buf.append(c)
            self.i += 1
        return ''.join(buf)

    def literal(self):
        j = self.i
        while self.i < len(self.t) and self.t[self.i] not in ',}]: \t\r\n':
            self.i += 1
        tok = self.t[j:self.i]
        if tok == 'true':
            return True
        if tok == 'false':
            return False
        if tok == 'null':
            return None
        try:
            if '.' in tok or 'e' in tok or 'E' in tok:
                return float(tok)
            return int(tok)
        except ValueError:
            return tok


def _find_matching(text, open_idx, open_ch, close_ch):
    depth = 0
    i = open_idx
    in_str = None
    n = len(text)
    while i < n:
        c = text[i]
        if in_str:
            if c == '\\':
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in '"\'':
            in_str = c
        elif c == '/' and i + 1 < n and text[i + 1] == '/':
            j = text.find('\n', i)
            i = n if j < 0 else j
            continue
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError("unbalanced %s%s" % (open_ch, close_ch))


def parse_index_js(text):
    """Return (header_text, list_of_defs). Each def is a dict; the leading
    comment banner is stored under '__comment__'."""
    mi = text.find(EXPORT_MARKER)
    if mi < 0:
        raise ValueError("could not find '%s' in file" % EXPORT_MARKER)
    header = text[:mi]
    bi = text.find('[', mi)
    if bi < 0:
        raise ValueError("could not find the def array '['")
    close = _find_matching(text, bi, '[', ']')
    inner = text[bi + 1:close]

    defs = []
    i = 0
    n = len(inner)
    comment = []
    while i < n:
        c = inner[i]
        if c in ' \t\r\n' or c == ',':
            if c == '\n':
                # blank line between a comment and a far-off object: keep simple,
                # comments are always directly above their object in this file.
                pass
            i += 1
            continue
        if c == '/' and i + 1 < n and inner[i + 1] == '/':
            j = inner.find('\n', i)
            line = inner[i:(n if j < 0 else j)].rstrip()
            comment.append(line)
            i = n if j < 0 else j + 1
            continue
        if c == '{':
            end = _find_matching(inner, i, '{', '}')
            obj = _JS(inner[i:end + 1]).value()
            obj['__comment__'] = '\n'.join(comment)
            comment = []
            defs.append(obj)
            i = end + 1
            continue
        i += 1
    return header, defs


def _esc(s):
    return str(s).replace('\\', '\\\\').replace('"', '\\"')


def _fmt_point(p):
    return "{x:%d,y:%d,z:%d}" % (int(p['x']), int(p['y']), int(p['z']))


def _fmt_chest(c):
    parts = ["x:%d" % int(c['x']), "y:%d" % int(c['y']), "z:%d" % int(c['z'])]
    extra = []
    if c.get('rarity'):
        extra.append('rarity:"%s"' % c['rarity'])
    if c.get('slots') not in (None, ""):
        s = c['slots']
        if isinstance(s, (list, tuple)):
            extra.append("slots:[%d,%d]" % (int(s[0]), int(s[1])))
        else:
            extra.append("slots:%s" % s)
    body = ",".join(parts)
    if extra:
        body += ", " + ", ".join(extra)
    return "{" + body + "}"


def _fmt_inline(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return '"%s"' % _esc(v)
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, int):
        return str(v)
    if isinstance(v, list):
        return "[" + ", ".join(_fmt_inline(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ", ".join("%s: %s" % (k, _fmt_inline(val))
                               for k, val in v.items()) + "}"
    return "null"


KNOWN_KEYS = {"type", "label", "structureId", "fireproof", "minPhase",
              "baseWeight", "spawns", "chests", "mobs", "lootTier",
              "__comment__"}


def emit_def(d):
    L = []
    cm = d.get('__comment__', '')
    if cm:
        L.append(cm)
    L.append("  {")
    L.append('    type: "%s", label: "%s", structureId: "%s",'
             % (_esc(d.get('type', '')), _esc(d.get('label', '')),
                _esc(d.get('structureId', ''))))
    flags = []
    if d.get('fireproof'):
        flags.append("fireproof: true")
    if d.get('minPhase'):
        flags.append('minPhase: "%s"' % d['minPhase'])
    if d.get('baseWeight') not in (None, ""):
        flags.append("baseWeight: %s" % d['baseWeight'])
    if flags:
        L.append("    " + ", ".join(flags) + ",")
    if d.get('spawns'):
        L.append("    spawns: [" + ", ".join(_fmt_point(p)
                 for p in d['spawns']) + "],")
    if d.get('chests'):
        L.append("    chests: [" + ", ".join(_fmt_chest(c)
                 for c in d['chests']) + "],")
    mobs = d.get('mobs') or {}
    if any(mobs.get(ph) for ph in PHASES):
        L.append("    mobs: {")
        for ph in PHASES:
            if mobs.get(ph):
                arr = ", ".join('"%s"' % _esc(m) for m in mobs[ph])
                L.append("      %-6s [%s]," % (ph + ":", arr))
        L.append("    },")
    loot = d.get('lootTier') or {}
    if any(ph in loot for ph in PHASES):
        items = ", ".join('%s: "%s"' % (ph, loot[ph])
                          for ph in PHASES if ph in loot)
        L.append("    lootTier: { %s }," % items)
    for k, v in d.items():
        if k not in KNOWN_KEYS:
            L.append("    %s: %s," % (k, _fmt_inline(v)))
    L.append("  },")
    return "\n".join(L)


def emit_index_js(header, defs):
    body = "\n\n".join(emit_def(d) for d in defs)
    return header.rstrip() + "\n\n" + EXPORT_MARKER + " = [\n" + body + "\n];\n"


def struct_path_for(index_path, structure_id):
    """ff:<name> -> <repo>/FF_BP/structures/ff/<name>.mcstructure"""
    if ':' not in (structure_id or ''):
        return None
    ns, name = structure_id.split(':', 1)
    base = os.path.dirname(os.path.abspath(index_path))  # .../scripts/structures
    return os.path.normpath(os.path.join(
        base, '..', '..', 'structures', ns, name + '.mcstructure'))


# ==========================================================================
# Block -> colour
# ==========================================================================
_KEYWORDS = [
    ("water", "#3a6fd6"), ("lava", "#e2700f"), ("magma", "#7a2b12"),
    ("glass", "#bfe9f0"), ("ice", "#a6d8ef"), ("snow", "#f4fbff"),
    ("leaves", "#3f8f3f"), ("leaf", "#3f8f3f"),
    ("grass", "#5fa83a"), ("dirt", "#7a5230"), ("podzol", "#6a4a26"),
    ("sand", "#e2d6a0"), ("gravel", "#8d8a86"), ("clay", "#a3a9b0"),
    ("netherrack", "#6b2b2b"), ("nether_brick", "#2e1416"),
    ("nether", "#5a2433"), ("soul", "#4a3a2c"), ("blackstone", "#2a2730"),
    ("obsidian", "#1c1830"), ("bedrock", "#3a3a3a"),
    ("cobblestone", "#888888"), ("stone_brick", "#9a9a9a"),
    ("deepslate", "#4c4c52"), ("stone", "#9d9d9d"), ("andesite", "#a8a8a8"),
    ("granite", "#b78a72"), ("diorite", "#d6d6d6"),
    ("prismarine", "#4f9a8f"), ("quartz", "#ece7df"),
    ("dark_oak", "#3f2c18"), ("spruce", "#5b4327"), ("birch", "#d8c79a"),
    ("jungle", "#a87b4f"), ("acacia", "#b5651d"),
    ("mangrove", "#7a3b2e"), ("crimson", "#7a3247"), ("warped", "#2c7b76"),
    ("oak", "#b9965a"), ("log", "#6b4f2a"), ("wood", "#9c7846"),
    ("plank", "#bb9a5e"), ("fence", "#9c7846"), ("door", "#8a6a3a"),
    ("trapdoor", "#8a6a3a"), ("stairs", "#a98a55"), ("slab", "#a98a55"),
    ("wool", "#dcdcdc"), ("carpet", "#cfcfcf"), ("concrete", "#9aa0a6"),
    ("terracotta", "#9c5a3c"), ("brick", "#9c4a3a"),
    ("gold", "#f2c84b"), ("iron", "#d8d8d8"), ("diamond", "#5fd6cf"),
    ("emerald", "#3fcf6a"), ("copper", "#c5744a"), ("redstone", "#c62828"),
    ("lapis", "#1f4fb0"), ("coal", "#2b2b2b"), ("amethyst", "#9a6ad6"),
    ("torch", "#ffd24a"), ("lantern", "#ffcf6a"), ("glowstone", "#f5d680"),
    ("lamp", "#f3e29a"), ("fire", "#ff7a1a"), ("campfire", "#d98a2b"),
    ("flower", "#e85aa0"), ("tulip", "#e85a5a"), ("rose", "#d23a3a"),
    ("mushroom", "#c08a6a"), ("vine", "#3f7a3a"), ("moss", "#5a8a3a"),
    ("hay", "#cfa83a"), ("wheat", "#cfc23a"), ("pumpkin", "#e08020"),
    ("melon", "#5aa83a"), ("chest", "#a9772f"), ("barrel", "#9c7846"),
    ("bookshelf", "#a98a55"), ("bed", "#c23a3a"), ("banner", "#cccccc"),
    ("wall", "#8f8f8f"), ("bars", "#5a5a5a"), ("chain", "#3a3a3a"),
    ("sign", "#9c7846"), ("ladder", "#9c7846"), ("button", "#9c7846"),
    ("pressure", "#9c7846"), ("rail", "#9a8a6a"),
    ("purpur", "#a86ca8"), ("end_stone", "#dad6a0"), ("end_rod", "#efe6d8"),
    ("sea_lantern", "#cfeee8"), ("sponge", "#d6c84a"),
    ("bone", "#e6e0cf"), ("calcite", "#e2e2dc"), ("tuff", "#6f706a"),
    ("mud", "#4d3f33"), ("dripstone", "#8a6f5a"),
]


class ColorMap:
    def __init__(self):
        self.cache = {}

    def color(self, name):
        if name in self.cache:
            return self.cache[name]
        low = name.lower()
        col = None
        for key, c in _KEYWORDS:
            if key in low:
                col = c
                break
        if col is None:
            h = 0
            for ch in name:
                h = (h * 131 + ord(ch)) & 0xFFFFFF
            col = "#%02x%02x%02x" % (80 + (h & 0x7F),
                                     80 + ((h >> 7) & 0x7F),
                                     80 + ((h >> 14) & 0x7F))
        self.cache[name] = col
        return col


# ==========================================================================
# Validation (mirrors the engine's footing/air checks)
# ==========================================================================
def validate_spawn(struct, p):
    """Return list of problem strings (empty == ok). y is feet position."""
    if struct is None:
        return []
    x, y, z = int(p['x']), int(p['y']), int(p['z'])
    if not struct.in_bounds(x, y, z):
        return ["out of bounds"]
    issues = []
    if not struct.is_empty(x, y, z):
        issues.append("feet inside a block")
    if not struct.is_empty(x, y + 1, z):
        issues.append("no headroom")
    if y - 1 < 0 or not struct.is_solid(x, y - 1, z):
        issues.append("no footing below")
    return issues


def validate_chest(struct, c):
    if struct is None:
        return []
    x, y, z = int(c['x']), int(c['y']), int(c['z'])
    if not struct.in_bounds(x, y, z):
        return ["out of bounds"]
    issues = []
    if not struct.is_empty(x, y, z):
        issues.append("buried in a block")
    if y - 1 < 0 or not struct.is_solid(x, y - 1, z):
        issues.append("floating (no block below)")
    return issues


# ==========================================================================
# GUI
# ==========================================================================
MODE_SELECT, MODE_SPAWN, MODE_CHEST = "select", "spawn", "chest"

# How many layers above/below the current slice an off-layer marker may be and
# still be drawn as a faded "ghost" (depth context for spawns/chests).
GHOST_RANGE = 10


class App(tk.Tk):
    def __init__(self, initial=None):
        super().__init__()
        self.title("mcstructure viewer + registry editor")
        self.geometry("1280x820")
        self.minsize(900, 600)

        self.colors = ColorMap()
        self.struct = None          # currently displayed Structure
        self.axis = "Y"
        self.layer = 0
        self.cell = 14
        self.cell_meta = {}         # canvas item -> (name, x, y, z)

        self.index_path = None
        self.header = ""
        self.defs = []              # list of dicts
        self.cur = None             # selected def dict
        self.dirty = False
        self.mode = tk.StringVar(value=MODE_SELECT)
        self.sel_kind = None        # 'spawn' or 'chest' currently selected
        self.sel_idx = None

        self._build_ui()
        self._bind_keys()

        if initial and initial.lower().endswith('.mcstructure'):
            self.view_only(initial)
        else:
            self._autoload_index()

    # ---- layout -----------------------------------------------------------
    def _build_ui(self):
        bar = ttk.Frame(self, padding=4)
        bar.pack(side="top", fill="x")
        ttk.Button(bar, text="Open index.js…",
                   command=self.open_index).pack(side="left")
        ttk.Button(bar, text="Open .mcstructure…",
                   command=self.open_struct).pack(side="left", padx=(4, 12))
        self.save_btn = ttk.Button(bar, text="Save index.js",
                                   command=self.save_index)
        self.save_btn.pack(side="left")

        ttk.Separator(bar, orient="vertical").pack(side="left", fill="y", padx=10)
        ttk.Label(bar, text="Axis:").pack(side="left")
        self.axis_var = tk.StringVar(value="Y")
        ab = ttk.Combobox(bar, textvariable=self.axis_var, width=3,
                          state="readonly", values=["Y", "X", "Z"])
        ab.pack(side="left")
        ab.bind("<<ComboboxSelected>>", self._on_axis)
        ttk.Button(bar, text="◀", width=3,
                   command=lambda: self.step(-1)).pack(side="left", padx=(8, 2))
        ttk.Button(bar, text="▶", width=3,
                   command=lambda: self.step(1)).pack(side="left")
        self.slider = ttk.Scale(bar, from_=0, to=0, orient="horizontal",
                                command=self._on_slider, length=200)
        self.slider.pack(side="left", padx=8)
        self.layer_lbl = ttk.Label(bar, text="—", width=14)
        self.layer_lbl.pack(side="left")
        ttk.Button(bar, text="–", width=3,
                   command=lambda: self.zoom(-2)).pack(side="left", padx=(8, 2))
        ttk.Button(bar, text="+", width=3,
                   command=lambda: self.zoom(2)).pack(side="left")

        ttk.Separator(bar, orient="vertical").pack(side="left", fill="y", padx=10)
        ttk.Label(bar, text="Click mode:").pack(side="left")
        for txt, val in (("Select", MODE_SELECT), ("Add spawn", MODE_SPAWN),
                         ("Add chest", MODE_CHEST)):
            ttk.Radiobutton(bar, text=txt, value=val,
                            variable=self.mode).pack(side="left")

        paned = ttk.Panedwindow(self, orient="horizontal")
        paned.pack(side="top", fill="both", expand=True)

        # left: structure list
        left = ttk.Frame(paned, padding=4)
        ttk.Label(left, text="Structures").pack(anchor="w")
        self.struct_list = tk.Listbox(left, width=24, exportselection=False)
        self.struct_list.pack(fill="both", expand=True)
        self.struct_list.bind("<<ListboxSelect>>", self._on_pick_struct)
        bb = ttk.Frame(left)
        bb.pack(fill="x", pady=4)
        ttk.Button(bb, text="Add", width=7,
                   command=self.add_struct).pack(side="left")
        ttk.Button(bb, text="Dup", width=7,
                   command=self.dup_struct).pack(side="left")
        ttk.Button(bb, text="Delete", width=7,
                   command=self.del_struct).pack(side="left")
        paned.add(left, weight=0)

        # center: canvas
        mid = ttk.Frame(paned)
        self.canvas = tk.Canvas(mid, bg="#202024", highlightthickness=0)
        hb = ttk.Scrollbar(mid, orient="horizontal", command=self.canvas.xview)
        vb = ttk.Scrollbar(mid, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(xscrollcommand=hb.set, yscrollcommand=vb.set)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        vb.grid(row=0, column=1, sticky="ns")
        hb.grid(row=1, column=0, sticky="ew")
        mid.rowconfigure(0, weight=1)
        mid.columnconfigure(0, weight=1)
        self.canvas.bind("<Motion>", self._on_hover)
        self.canvas.bind("<Button-1>", self._on_click)
        paned.add(mid, weight=1)

        # right: editor notebook
        right = ttk.Frame(paned, padding=4)
        self.nb = ttk.Notebook(right)
        self.nb.pack(fill="both", expand=True)
        self._build_details_tab()
        self._build_spawns_tab()
        self._build_chests_tab()
        paned.add(right, weight=0)

        self.status = ttk.Label(self, text="", anchor="w",
                                relief="sunken", padding=4)
        self.status.pack(side="bottom", fill="x")

    def _build_details_tab(self):
        f = ttk.Frame(self.nb, padding=8)
        self.nb.add(f, text="Details")
        self.f_type = self._field(f, "type", 0)
        self.f_label = self._field(f, "label", 1)
        self.f_struct = self._field(f, "structureId", 2)

        ttk.Label(f, text="minPhase").grid(row=3, column=0, sticky="w", pady=2)
        self.f_minphase = ttk.Combobox(f, width=10, state="readonly",
                                       values=["(none)"] + PHASES)
        self.f_minphase.grid(row=3, column=1, sticky="w")

        self.f_fireproof = tk.IntVar()
        ttk.Checkbutton(f, text="fireproof", variable=self.f_fireproof
                        ).grid(row=4, column=1, sticky="w", pady=2)

        ttk.Label(f, text="baseWeight").grid(row=5, column=0, sticky="w", pady=2)
        self.f_weight = ttk.Entry(f, width=8)
        self.f_weight.grid(row=5, column=1, sticky="w")

        ttk.Separator(f, orient="horizontal").grid(
            row=6, column=0, columnspan=2, sticky="ew", pady=8)
        ttk.Label(f, text="Mobs per phase (comma-separated ids)").grid(
            row=7, column=0, columnspan=2, sticky="w")
        self.f_mobs = {}
        r = 8
        for ph in PHASES:
            ttk.Label(f, text=ph).grid(row=r, column=0, sticky="w", pady=1)
            e = ttk.Entry(f, width=42)
            e.grid(row=r, column=1, sticky="we", pady=1)
            self.f_mobs[ph] = e
            r += 1

        ttk.Label(f, text="Loot tier per phase").grid(
            row=r, column=0, columnspan=2, sticky="w", pady=(8, 0))
        r += 1
        self.f_loot = {}
        for ph in PHASES:
            ttk.Label(f, text=ph).grid(row=r, column=0, sticky="w", pady=1)
            cb = ttk.Combobox(f, width=12, state="readonly",
                              values=["(none)"] + RARITIES)
            cb.grid(row=r, column=1, sticky="w", pady=1)
            self.f_loot[ph] = cb
            r += 1

        ttk.Button(f, text="Apply to selected structure",
                   command=self.commit_details).grid(
            row=r, column=0, columnspan=2, sticky="we", pady=10)
        f.columnconfigure(1, weight=1)

    def _field(self, parent, label, row):
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", pady=2)
        e = ttk.Entry(parent, width=34)
        e.grid(row=row, column=1, sticky="we", pady=2)
        return e

    def _build_spawns_tab(self):
        f = ttk.Frame(self.nb, padding=8)
        self.nb.add(f, text="Spawns")
        ttk.Label(f, text="Spawn points  (red = problem)").pack(anchor="w")
        self.spawn_list = tk.Listbox(f, height=12, exportselection=False)
        self.spawn_list.pack(fill="both", expand=True)
        self.spawn_list.bind("<<ListboxSelect>>", self._on_pick_spawn)
        self.spawn_list.bind("<Double-Button-1>", lambda e: self._jump_sel('spawn'))

        g = ttk.Frame(f)
        g.pack(fill="x", pady=6)
        self.sp_x = self._xyz(g, "x", 0)
        self.sp_y = self._xyz(g, "y", 1)
        self.sp_z = self._xyz(g, "z", 2)
        ttk.Button(g, text="Update", command=self._update_spawn
                   ).grid(row=0, column=6, padx=4)
        ttk.Button(g, text="Delete", command=self._delete_spawn
                   ).grid(row=0, column=7)
        ttk.Label(f, text="Tip: set 'Add spawn' mode, then click the grid to "
                          "drop a point on the current layer.",
                  wraplength=300, foreground="#777").pack(anchor="w")

    def _build_chests_tab(self):
        f = ttk.Frame(self.nb, padding=8)
        self.nb.add(f, text="Chests")
        ttk.Label(f, text="Chests  (red = problem)").pack(anchor="w")
        self.chest_list = tk.Listbox(f, height=10, exportselection=False)
        self.chest_list.pack(fill="both", expand=True)
        self.chest_list.bind("<<ListboxSelect>>", self._on_pick_chest)
        self.chest_list.bind("<Double-Button-1>", lambda e: self._jump_sel('chest'))

        g = ttk.Frame(f)
        g.pack(fill="x", pady=6)
        self.ch_x = self._xyz(g, "x", 0)
        self.ch_y = self._xyz(g, "y", 1)
        self.ch_z = self._xyz(g, "z", 2)
        g2 = ttk.Frame(f)
        g2.pack(fill="x")
        ttk.Label(g2, text="rarity").grid(row=0, column=0, sticky="w")
        self.ch_rarity = ttk.Combobox(g2, width=10, state="readonly",
                                      values=["(tier)"] + RARITIES)
        self.ch_rarity.grid(row=0, column=1, padx=(2, 10))
        ttk.Label(g2, text="slots").grid(row=0, column=2, sticky="w")
        self.ch_slots = ttk.Entry(g2, width=8)
        self.ch_slots.grid(row=0, column=3, padx=2)
        ttk.Label(g2, text="(n or min,max)", foreground="#777"
                  ).grid(row=0, column=4, sticky="w")
        b = ttk.Frame(f)
        b.pack(fill="x", pady=6)
        ttk.Button(b, text="Update", command=self._update_chest
                   ).pack(side="left", padx=(0, 4))
        ttk.Button(b, text="Delete", command=self._delete_chest
                   ).pack(side="left")
        ttk.Label(f, text="Tip: set 'Add chest' mode, then click the grid.",
                  wraplength=300, foreground="#777").pack(anchor="w")

    def _xyz(self, parent, label, col):
        ttk.Label(parent, text=label).grid(row=0, column=col * 2, sticky="w")
        e = ttk.Entry(parent, width=5)
        e.grid(row=0, column=col * 2 + 1, padx=(2, 8))
        return e

    def _bind_keys(self):
        self.bind("<Left>", lambda e: self.step(-1))
        self.bind("<Right>", lambda e: self.step(1))
        self.bind("<Prior>", lambda e: self.step(5))
        self.bind("<Next>", lambda e: self.step(-5))
        self.bind("<Home>", lambda e: self.goto(0))
        self.bind("<End>", lambda e: self.goto(self._layer_count() - 1))

    # ---- index.js load/save ----------------------------------------------
    def _autoload_index(self):
        guess = os.path.normpath(os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            '..', 'FF_BP', 'scripts', 'structures', 'index.js'))
        if os.path.isfile(guess):
            self.load_index(guess)
        else:
            self.status.configure(
                text="Open index.js to edit the registry, or open a "
                     ".mcstructure to just view.")

    def open_index(self):
        start = os.path.dirname(self.index_path) if self.index_path else os.getcwd()
        p = filedialog.askopenfilename(
            title="Open index.js", initialdir=start,
            filetypes=[("JavaScript", "*.js"), ("All files", "*.*")])
        if p:
            self.load_index(p)

    def load_index(self, path):
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                text = fh.read()
            self.header, self.defs = parse_index_js(text)
        except Exception as e:
            messagebox.showerror("Parse failed", "%s\n\n%s" % (path, e))
            return
        self.index_path = path
        self.dirty = False
        self._refresh_struct_list()
        self.status.configure(
            text="Loaded %d structures from %s" %
                 (len(self.defs), os.path.basename(path)))
        if self.defs:
            self.struct_list.selection_set(0)
            self._select_def(0)

    def save_index(self):
        if not self.index_path:
            messagebox.showinfo("Nothing to save", "No index.js is loaded.")
            return
        self.commit_details()
        try:
            out = emit_index_js(self.header, self.defs)
            # round-trip safety: the output must re-parse to the same defs
            _, redo = parse_index_js(out)
            if len(redo) != len(self.defs):
                raise ValueError("round-trip def count mismatch (%d != %d)"
                                 % (len(redo), len(self.defs)))
        except Exception as e:
            messagebox.showerror("Save aborted",
                                 "Generated file failed its safety check:\n\n%s"
                                 % e)
            return
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        bak = self.index_path + ".bak-" + stamp
        try:
            if os.path.isfile(self.index_path):
                with open(self.index_path, 'r', encoding='utf-8') as fh:
                    old = fh.read()
                with open(bak, 'w', encoding='utf-8') as fh:
                    fh.write(old)
            with open(self.index_path, 'w', encoding='utf-8') as fh:
                fh.write(out)
        except Exception as e:
            messagebox.showerror("Write failed", str(e))
            return
        self.dirty = False
        self.status.configure(
            text="Saved %d structures. Backup: %s" %
                 (len(self.defs), os.path.basename(bak)))

    # ---- structure list ---------------------------------------------------
    def _refresh_struct_list(self):
        self.struct_list.delete(0, "end")
        for d in self.defs:
            self.struct_list.insert("end", d.get('type', '?'))

    def _on_pick_struct(self, _e):
        sel = self.struct_list.curselection()
        if sel:
            self._select_def(sel[0])

    def _select_def(self, idx):
        self.commit_details()  # save edits to the previously selected def
        self.cur = self.defs[idx]
        self.sel_kind = self.sel_idx = None
        self._load_details()
        # auto-load the matching .mcstructure
        self.struct = None
        sid = self.cur.get('structureId')
        if sid and self.index_path:
            sp = struct_path_for(self.index_path, sid)
            if sp and os.path.isfile(sp):
                try:
                    self.struct = Structure(sp)
                except Exception as e:
                    self.status.configure(text="Could not load %s: %s" % (sp, e))
            else:
                self.status.configure(
                    text="(.mcstructure not found for %s — editing values only)"
                         % sid)
        self.axis = self.axis_var.get()
        self.layer = 0
        self.slider.configure(to=max(0, self._layer_count() - 1))
        self._refresh_spawn_list()
        self._refresh_chest_list()
        self.draw()

    def add_struct(self):
        d = {"type": "new_structure", "label": "New Structure",
             "structureId": "ff:new_structure", "baseWeight": 10,
             "mobs": {}, "lootTier": {},
             "__comment__": "  // ── New structure ──"}
        self.defs.append(d)
        self.dirty = True
        self._refresh_struct_list()
        self.struct_list.selection_clear(0, "end")
        self.struct_list.selection_set("end")
        self._select_def(len(self.defs) - 1)

    def dup_struct(self):
        if self.cur is None:
            return
        self.commit_details()
        import copy
        d = copy.deepcopy(self.cur)
        d['type'] = d.get('type', 'structure') + "_copy"
        self.defs.append(d)
        self.dirty = True
        self._refresh_struct_list()
        self.struct_list.selection_clear(0, "end")
        self.struct_list.selection_set("end")
        self._select_def(len(self.defs) - 1)

    def del_struct(self):
        sel = self.struct_list.curselection()
        if not sel:
            return
        idx = sel[0]
        name = self.defs[idx].get('type', '?')
        if not messagebox.askyesno("Delete structure",
                                   "Remove '%s' from the registry?" % name):
            return
        del self.defs[idx]
        self.cur = None
        self.dirty = True
        self._refresh_struct_list()
        if self.defs:
            i = min(idx, len(self.defs) - 1)
            self.struct_list.selection_set(i)
            self._select_def(i)
        else:
            self.struct = None
            self.draw()

    # ---- details form -----------------------------------------------------
    def _set_entry(self, e, val):
        e.delete(0, "end")
        if val is not None:
            e.insert(0, str(val))

    def _load_details(self):
        d = self.cur
        if d is None:
            return
        self._set_entry(self.f_type, d.get('type', ''))
        self._set_entry(self.f_label, d.get('label', ''))
        self._set_entry(self.f_struct, d.get('structureId', ''))
        self.f_minphase.set(d.get('minPhase') or "(none)")
        self.f_fireproof.set(1 if d.get('fireproof') else 0)
        self._set_entry(self.f_weight, d.get('baseWeight', ''))
        mobs = d.get('mobs') or {}
        for ph in PHASES:
            self._set_entry(self.f_mobs[ph], ", ".join(mobs.get(ph, [])))
        loot = d.get('lootTier') or {}
        for ph in PHASES:
            self.f_loot[ph].set(loot.get(ph, "(none)"))

    def commit_details(self):
        d = self.cur
        if d is None:
            return
        d['type'] = self.f_type.get().strip()
        d['label'] = self.f_label.get().strip()
        d['structureId'] = self.f_struct.get().strip()
        mp = self.f_minphase.get()
        if mp and mp != "(none)":
            d['minPhase'] = mp
        else:
            d.pop('minPhase', None)
        if self.f_fireproof.get():
            d['fireproof'] = True
        else:
            d.pop('fireproof', None)
        w = self.f_weight.get().strip()
        if w == "":
            d.pop('baseWeight', None)
        else:
            try:
                d['baseWeight'] = int(w) if w.lstrip('-').isdigit() else float(w)
            except ValueError:
                d['baseWeight'] = w
        mobs = {}
        for ph in PHASES:
            toks = [t.strip() for t in self.f_mobs[ph].get()
                    .replace("\n", ",").split(",") if t.strip()]
            if toks:
                mobs[ph] = toks
        d['mobs'] = mobs
        loot = {}
        for ph in PHASES:
            v = self.f_loot[ph].get()
            if v and v != "(none)":
                loot[ph] = v
        d['lootTier'] = loot
        # reflect a possible type rename in the list — update the row that
        # belongs to *this* def (by identity), NOT whatever is currently
        # selected. commit_details() runs at the start of _select_def while
        # the listbox selection has already moved to the row being navigated
        # TO, so trusting curselection() here stamps the old def's name onto
        # the newly clicked row.
        idx = next((i for i, x in enumerate(self.defs) if x is d), None)
        if idx is not None and self.struct_list.get(idx) != d['type']:
            sel = self.struct_list.curselection()
            self.struct_list.delete(idx)
            self.struct_list.insert(idx, d['type'])
            for s in sel:
                self.struct_list.selection_set(s)
        self.dirty = True

    # ---- spawn / chest lists ---------------------------------------------
    def _refresh_spawn_list(self):
        self.spawn_list.delete(0, "end")
        if self.cur is None:
            return
        for i, p in enumerate(self.cur.get('spawns', []) or []):
            issues = validate_spawn(self.struct, p)
            tag = "  ⚠ " + "; ".join(issues) if issues else ""
            self.spawn_list.insert(
                "end", "%2d  (%d,%d,%d)%s" %
                       (i, p['x'], p['y'], p['z'], tag))
            if issues:
                self.spawn_list.itemconfig(i, foreground="#d23a3a")

    def _refresh_chest_list(self):
        self.chest_list.delete(0, "end")
        if self.cur is None:
            return
        for i, c in enumerate(self.cur.get('chests', []) or []):
            extra = []
            if c.get('rarity'):
                extra.append(c['rarity'])
            if c.get('slots') not in (None, ""):
                extra.append("slots=%s" % c['slots'])
            issues = validate_chest(self.struct, c)
            tag = "  ⚠ " + "; ".join(issues) if issues else ""
            label = "%2d  (%d,%d,%d) %s%s" % (
                i, c['x'], c['y'], c['z'],
                " ".join(extra), tag)
            self.chest_list.insert("end", label)
            if issues:
                self.chest_list.itemconfig(i, foreground="#d23a3a")

    def _on_pick_spawn(self, _e):
        sel = self.spawn_list.curselection()
        if not sel:
            return
        self.sel_kind, self.sel_idx = 'spawn', sel[0]
        p = self.cur['spawns'][sel[0]]
        self._set_entry(self.sp_x, p['x'])
        self._set_entry(self.sp_y, p['y'])
        self._set_entry(self.sp_z, p['z'])
        self.draw()

    def _on_pick_chest(self, _e):
        sel = self.chest_list.curselection()
        if not sel:
            return
        self.sel_kind, self.sel_idx = 'chest', sel[0]
        c = self.cur['chests'][sel[0]]
        self._set_entry(self.ch_x, c['x'])
        self._set_entry(self.ch_y, c['y'])
        self._set_entry(self.ch_z, c['z'])
        self.ch_rarity.set(c.get('rarity') or "(tier)")
        self._set_entry(self.ch_slots, c.get('slots', ''))
        self.draw()

    def _jump_sel(self, kind):
        """Double-click: jump the layer view to the selected point's plane."""
        if kind == 'spawn':
            sel = self.spawn_list.curselection()
            arr = self.cur.get('spawns', [])
        else:
            sel = self.chest_list.curselection()
            arr = self.cur.get('chests', [])
        if not sel:
            return
        p = arr[sel[0]]
        a = self.axis
        self.goto(p['y'] if a == "Y" else (p['x'] if a == "X" else p['z']))

    def _read_xyz(self, ex, ey, ez):
        try:
            return {'x': int(ex.get()), 'y': int(ey.get()), 'z': int(ez.get())}
        except ValueError:
            messagebox.showwarning("Bad coordinates",
                                   "x, y and z must be whole numbers.")
            return None

    def _update_spawn(self):
        if self.cur is None or self.sel_kind != 'spawn' or self.sel_idx is None:
            return
        p = self._read_xyz(self.sp_x, self.sp_y, self.sp_z)
        if p is None:
            return
        self.cur['spawns'][self.sel_idx] = p
        self.dirty = True
        self._refresh_spawn_list()
        self.spawn_list.selection_set(self.sel_idx)
        self.draw()

    def _delete_spawn(self):
        if self.cur is None or self.sel_kind != 'spawn' or self.sel_idx is None:
            return
        del self.cur['spawns'][self.sel_idx]
        self.sel_idx = None
        self.dirty = True
        self._refresh_spawn_list()
        self.draw()

    def _update_chest(self):
        if self.cur is None or self.sel_kind != 'chest' or self.sel_idx is None:
            return
        c = self._read_xyz(self.ch_x, self.ch_y, self.ch_z)
        if c is None:
            return
        rr = self.ch_rarity.get()
        if rr and rr != "(tier)":
            c['rarity'] = rr
        s = self.ch_slots.get().strip()
        if s:
            if ',' in s:
                a, b = s.split(',', 1)
                c['slots'] = [int(a), int(b)]
            else:
                c['slots'] = int(s)
        self.cur['chests'][self.sel_idx] = c
        self.dirty = True
        self._refresh_chest_list()
        self.chest_list.selection_set(self.sel_idx)
        self.draw()

    def _delete_chest(self):
        if self.cur is None or self.sel_kind != 'chest' or self.sel_idx is None:
            return
        del self.cur['chests'][self.sel_idx]
        self.sel_idx = None
        self.dirty = True
        self._refresh_chest_list()
        self.draw()

    # ---- slicing ----------------------------------------------------------
    def _layer_count(self):
        if not self.struct:
            return 0
        return {"Y": self.struct.sy, "X": self.struct.sx,
                "Z": self.struct.sz}[self.axis]

    def _plane(self):
        s = self.struct
        a, L = self.axis, self.layer
        if a == "Y":
            return s.sx, s.sz, (lambda c, r: (c, L, r))
        if a == "X":
            return s.sz, s.sy, (lambda c, r: (L, s.sy - 1 - r, c))
        return s.sx, s.sy, (lambda c, r: (c, s.sy - 1 - r, L))

    def _cell_of(self, x, y, z):
        """World offset -> (col,row) on the current plane, or None if off-layer."""
        a, L = self.axis, self.layer
        s = self.struct
        if a == "Y":
            return (x, z) if y == L else None
        if a == "X":
            return (z, s.sy - 1 - y) if x == L else None
        return (x, s.sy - 1 - y) if z == L else None

    def _project(self, x, y, z):
        """World offset -> (col, row, depth_offset) on the current plane.
        Unlike _cell_of this ALWAYS returns a column/row; depth_offset is how
        many layers the point sits in front of (>0) / behind (<0) the slice."""
        s = self.struct
        a = self.axis
        if a == "Y":
            return x, z, y - self.layer
        if a == "X":
            return z, s.sy - 1 - y, x - self.layer
        return x, s.sy - 1 - y, z - self.layer

    def _on_plane(self, col, row):
        cols, rows, _ = self._plane()
        return 0 <= col < cols and 0 <= row < rows

    @staticmethod
    def _dim(hexcol, frac):
        """Blend a #rrggbb colour toward the canvas background by frac (0..1)."""
        bg = (0x20, 0x20, 0x24)
        rr = int(hexcol[1:3], 16)
        gg = int(hexcol[3:5], 16)
        bb = int(hexcol[5:7], 16)
        rr = int(rr + (bg[0] - rr) * frac)
        gg = int(gg + (bg[1] - gg) * frac)
        bb = int(bb + (bg[2] - bb) * frac)
        return "#%02x%02x%02x" % (rr, gg, bb)

    # ---- drawing ----------------------------------------------------------
    def draw(self):
        self.canvas.delete("all")
        self.cell_meta.clear()
        if not self.struct:
            self.layer_lbl.configure(text="—")
            return
        cols, rows, mapfn = self._plane()
        cs = self.cell
        for c in range(cols):
            for r in range(rows):
                x, y, z = mapfn(c, r)
                name = self.struct.block_name(x, y, z)
                x0, y0 = c * cs, r * cs
                if name is None or name == "air":
                    fill = "#26262b" if (c + r) % 2 == 0 else "#222227"
                    it = self.canvas.create_rectangle(
                        x0, y0, x0 + cs, y0 + cs, fill=fill, width=0)
                    self.cell_meta[it] = ("air", x, y, z)
                else:
                    fill = self.colors.color(name)
                    outline = "#15151a" if cs >= 6 else fill
                    it = self.canvas.create_rectangle(
                        x0, y0, x0 + cs, y0 + cs, fill=fill,
                        outline=outline, width=1)
                    self.cell_meta[it] = (name, x, y, z)
        self.canvas.configure(scrollregion=(0, 0, cols * cs, rows * cs))
        self._draw_markers(cs)
        n = self._layer_count()
        self.slider.set(self.layer)
        self.layer_lbl.configure(text="%s=%d  (%d/%d)" %
                                 (self.axis, self.layer, self.layer + 1, n))

    def _draw_markers(self, cs):
        if self.cur is None:
            return
        # Collect every marker within the ghost window, then draw farthest
        # first so the on-layer markers always land on top.
        items = []
        for i, p in enumerate(self.cur.get('spawns', []) or []):
            col, row, off = self._project(p['x'], p['y'], p['z'])
            if not self._on_plane(col, row) or abs(off) > GHOST_RANGE:
                continue
            sel = self.sel_kind == 'spawn' and self.sel_idx == i
            prob = bool(validate_spawn(self.struct, p))
            items.append((abs(off), "#ff3b3b", "S", False, col, row, off,
                          sel, prob))
        for i, c in enumerate(self.cur.get('chests', []) or []):
            col, row, off = self._project(c['x'], c['y'], c['z'])
            if not self._on_plane(col, row) or abs(off) > GHOST_RANGE:
                continue
            sel = self.sel_kind == 'chest' and self.sel_idx == i
            prob = bool(validate_chest(self.struct, c))
            items.append((abs(off), "#ffcf3b", "C", True, col, row, off,
                          sel, prob))
        items.sort(key=lambda t: -t[0])
        for _, color, letter, square, col, row, off, sel, prob in items:
            self._marker((col, row), cs, color, letter, off, sel,
                         square=square, problem=prob)

    def _marker(self, cr, cs, color, letter, offset, selected,
                square=False, problem=False):
        c, r = cr
        x0, y0 = c * cs, r * cs
        x1, y1 = x0 + cs, y0 + cs
        on_layer = (offset == 0)
        if on_layer:
            fill = color
            pad = max(1, cs // 6)
            glyph = letter
            fs = max(6, cs // 2)
            txtcol = "#000000"
            thresh = 11
        else:
            # the farther away in depth, the more it fades into the background
            frac = min(0.78, 0.30 + 0.07 * abs(offset))
            fill = self._dim(color, frac)
            pad = max(2, cs // 4)            # smaller footprint than on-layer
            glyph = ("+%d" if offset > 0 else "%d") % offset
            fs = max(6, cs // 3)
            txtcol = "#e8e8e8"
            thresh = 9
        if selected:
            out = "#ffffff"
            w = 3 if on_layer else 2
        elif problem:
            out = "#d23a3a" if on_layer else self._dim("#d23a3a", 0.35)
            w = 2
        else:
            out = "#000000" if on_layer else self._dim("#000000", 0.40)
            w = 1
        if square:
            self.canvas.create_rectangle(x0 + pad, y0 + pad, x1 - pad, y1 - pad,
                                         fill=fill, outline=out, width=w)
        else:
            self.canvas.create_oval(x0 + pad, y0 + pad, x1 - pad, y1 - pad,
                                    fill=fill, outline=out, width=w)
        if cs >= thresh:
            self.canvas.create_text((x0 + x1) / 2, (y0 + y1) / 2, text=glyph,
                                    fill=txtcol,
                                    font=("TkDefaultFont", fs))

    # ---- navigation -------------------------------------------------------
    def step(self, d):
        self.goto(self.layer + d)

    def goto(self, idx):
        if not self.struct:
            return
        self.layer = max(0, min(self._layer_count() - 1, int(idx)))
        self.draw()

    def _on_slider(self, _v):
        if not self.struct:
            return
        idx = int(round(float(self.slider.get())))
        if idx != self.layer:
            self.layer = idx
            self.draw()

    def _on_axis(self, _e):
        self.axis = self.axis_var.get()
        self.layer = 0
        self.slider.configure(to=max(0, self._layer_count() - 1))
        self.draw()

    def zoom(self, d):
        self.cell = max(3, min(40, self.cell + d))
        self.draw()

    # ---- canvas interaction ----------------------------------------------
    def _cell_at(self, evt):
        if not self.struct:
            return None
        cx = self.canvas.canvasx(evt.x)
        cy = self.canvas.canvasy(evt.y)
        c, r = int(cx // self.cell), int(cy // self.cell)
        cols, rows, mapfn = self._plane()
        if 0 <= c < cols and 0 <= r < rows:
            return mapfn(c, r)
        return None

    def _on_hover(self, evt):
        if not self.struct:
            return
        cell = self._cell_at(evt)
        if cell is None:
            return
        x, y, z = cell
        name = self.struct.block_name(x, y, z) or "air"
        msg = "(%d, %d, %d)   %s" % (x, y, z, name)
        # which markers live in this column (any depth)? helps place in 3D.
        col, row, _ = self._project(x, y, z)
        here = []
        if self.cur is not None:
            for i, p in enumerate(self.cur.get('spawns', []) or []):
                pc, pr, po = self._project(p['x'], p['y'], p['z'])
                if pc == col and pr == row:
                    here.append("S#%d %s" % (i, "here" if po == 0
                                             else "%+d" % po))
            for i, c in enumerate(self.cur.get('chests', []) or []):
                pc, pr, po = self._project(c['x'], c['y'], c['z'])
                if pc == col and pr == row:
                    here.append("C#%d %s" % (i, "here" if po == 0
                                             else "%+d" % po))
        if here:
            msg += "   |   column: " + ", ".join(here)
        self.status.configure(text=msg)

    def _on_click(self, evt):
        cell = self._cell_at(evt)
        if cell is None or self.cur is None:
            return
        x, y, z = cell
        mode = self.mode.get()
        if mode == MODE_SPAWN:
            self.cur.setdefault('spawns', []).append({'x': x, 'y': y, 'z': z})
            self.dirty = True
            self.sel_kind, self.sel_idx = 'spawn', len(self.cur['spawns']) - 1
            self._refresh_spawn_list()
            self.spawn_list.selection_clear(0, "end")
            self.spawn_list.selection_set(self.sel_idx)
            self._on_pick_spawn(None)
            self.nb.select(1)
            self.draw()
        elif mode == MODE_CHEST:
            self.cur.setdefault('chests', []).append({'x': x, 'y': y, 'z': z})
            self.dirty = True
            self.sel_kind, self.sel_idx = 'chest', len(self.cur['chests']) - 1
            self._refresh_chest_list()
            self.chest_list.selection_clear(0, "end")
            self.chest_list.selection_set(self.sel_idx)
            self._on_pick_chest(None)
            self.nb.select(2)
            self.draw()
        else:  # select
            self._select_at(x, y, z)

    def _select_at(self, x, y, z):
        for i, p in enumerate(self.cur.get('spawns', []) or []):
            if p['x'] == x and p['y'] == y and p['z'] == z:
                self.sel_kind, self.sel_idx = 'spawn', i
                self.nb.select(1)
                self.spawn_list.selection_clear(0, "end")
                self.spawn_list.selection_set(i)
                self._on_pick_spawn(None)
                return
        for i, c in enumerate(self.cur.get('chests', []) or []):
            if c['x'] == x and c['y'] == y and c['z'] == z:
                self.sel_kind, self.sel_idx = 'chest', i
                self.nb.select(2)
                self.chest_list.selection_clear(0, "end")
                self.chest_list.selection_set(i)
                self._on_pick_chest(None)
                return

    # ---- view-only --------------------------------------------------------
    def view_only(self, path):
        try:
            self.struct = Structure(path)
        except Exception as e:
            messagebox.showerror("Load failed", str(e))
            return
        self.cur = None
        self.axis = self.axis_var.get()
        self.layer = 0
        self.slider.configure(to=max(0, self._layer_count() - 1))
        self.title("mcstructure viewer — %s" % os.path.basename(path))
        self.draw()

    def open_struct(self):
        p = filedialog.askopenfilename(
            title="Open .mcstructure", initialdir=os.getcwd(),
            filetypes=[("mcstructure", "*.mcstructure"), ("All files", "*.*")])
        if p:
            self.view_only(p)


def main():
    initial = sys.argv[1] if len(sys.argv) > 1 else None
    App(initial).mainloop()


if __name__ == "__main__":
    main()
