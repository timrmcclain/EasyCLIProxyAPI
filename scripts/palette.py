"""Generate the hub's colour palette from OKLCH ramps and snap stray literals to it.

  python scripts/palette.py generate   # writes src/styles/palette.css
  python scripts/palette.py snap       # rewrites hex literals in src/**/*.css to palette vars
  python scripts/palette.py check      # lists hex literals outside palette.css; prints contrast table

Ramps are defined by perceived lightness, so the same step looks equally light in every hue and
light/dark pairs line up. Chroma is reduced until each colour fits in sRGB.
"""
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PALETTE_CSS = ROOT / 'src' / 'styles' / 'palette.css'

STEPS = {50: .975, 100: .945, 200: .89, 300: .82, 400: .72, 500: .63, 600: .545, 700: .475, 800: .40, 900: .33, 950: .26}
HUES = {
    # name: (hue, peak chroma)
    'teal': (183, .11),
    'red': (27, .19),
    'amber': (72, .16),
    'green': (152, .15),
    'blue': (252, .16),
    'violet': (295, .18),
    'orange': (48, .17),
}
NEUTRAL_HUE = 215
NEUTRAL_STEPS = {0: 1.0, 25: .985, 50: .97, 75: .955, 100: .935, 150: .905, 200: .875, 300: .80, 350: .75, 400: .70,
                 500: .60, 600: .51, 700: .43, 800: .355, 850: .31, 875: .285, 900: .26, 925: .237, 950: .215,
                 975: .195, 1000: .17}


def oklch_to_srgb(L, C, h):
    a, b = C * math.cos(math.radians(h)), C * math.sin(math.radians(h))
    l_ = (L + .3963377774 * a + .2158037573 * b) ** 3
    m_ = (L - .1055613458 * a - .0638541728 * b) ** 3
    s_ = (L - .0894841775 * a - 1.2914855480 * b) ** 3
    rgb = (4.0767416621 * l_ - 3.3077115913 * m_ + .2309699292 * s_,
           -1.2684380046 * l_ + 2.6097574011 * m_ - .3413193965 * s_,
           -.0041960863 * l_ - .7034186147 * m_ + 1.7076147010 * s_)

    def enc(x):
        return 12.92 * x if x <= .0031308 else 1.055 * x ** (1 / 2.4) - .055
    return tuple(enc(x) for x in rgb)


def in_gamut(rgb):
    return all(-1e-4 <= c <= 1 + 1e-4 for c in rgb)


def fit(L, C, h):
    while C > 0 and not in_gamut(oklch_to_srgb(L, C, h)):
        C -= .002
    rgb = oklch_to_srgb(L, max(C, 0), h)
    return '#' + ''.join(f'{round(min(1, max(0, c)) * 255):02x}' for c in rgb)


def hex_to_rgb(value):
    value = value.lstrip('#')
    if len(value) in (3, 4):
        value = ''.join(c * 2 for c in value[:3])
    return tuple(int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))


def srgb_to_oklab(rgb):
    def dec(c):
        return c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4
    r, g, b = (dec(c) for c in rgb)
    l = (.4122214708 * r + .5363325363 * g + .0514459929 * b) ** (1 / 3)
    m = (.2119034982 * r + .6806995451 * g + .1073969566 * b) ** (1 / 3)
    s = (.0883024619 * r + .2817188376 * g + .6299787005 * b) ** (1 / 3)
    return (.2104542553 * l + .7936177850 * m - .0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + .4505937099 * s,
            .0259040371 * l + .7827717662 * m - .8086757660 * s)


def luminance(rgb):
    def dec(c):
        return c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4
    r, g, b = (dec(c) for c in rgb)
    return .2126 * r + .7152 * g + .0722 * b


def contrast(a, b):
    la, lb = sorted((luminance(hex_to_rgb(a)), luminance(hex_to_rgb(b))), reverse=True)
    return (la + .05) / (lb + .05)


def palette():
    tokens = {}
    for step, L in NEUTRAL_STEPS.items():
        # A whisper of tint on the light end, a little more in the dark greys where it reads as depth.
        chroma = 0 if step == 0 else .003 if L >= .9 else .007 if L >= .5 else .011
        tokens[f'neutral-{step}'] = fit(L, chroma, NEUTRAL_HUE)
    for name, (hue, peak) in HUES.items():
        for step, L in STEPS.items():
            curve = max(.25, 1 - ((L - .6) / .42) ** 2)
            tokens[f'{name}-{step}'] = fit(L, peak * curve, hue)
    return tokens


# Semantic roles: (light value, dark value). Text roles are checked for contrast on their surface.
ROLES = {
    'canvas': ('neutral-75', 'neutral-975'),
    'surface': ('neutral-0', 'neutral-925'),
    'surface-raised': ('neutral-25', 'neutral-900'),
    'border': ('neutral-150', 'neutral-850'),
    'border-strong': ('neutral-200', 'neutral-800'),
    'text': ('neutral-900', 'neutral-50'),
    'text-muted': ('neutral-700', 'neutral-300'),
    'text-subtle': ('neutral-600', 'neutral-400'),
    'accent': ('teal-700', 'teal-300'),
    'accent-strong': ('teal-800', 'teal-200'),
    'accent-solid': ('teal-700', 'teal-600'),
    'accent-soft': ('teal-50', 'teal-950'),
    'on-accent': ('neutral-0', 'neutral-0'),
    'danger': ('red-700', 'red-300'),
    'danger-solid': ('red-600', 'red-500'),
    'danger-soft': ('red-50', 'red-950'),
    'danger-border': ('red-200', 'red-800'),
    'warning': ('amber-800', 'amber-300'),
    'warning-solid': ('amber-400', 'amber-400'),
    'warning-soft': ('amber-50', 'amber-950'),
    'warning-border': ('amber-200', 'amber-800'),
    'success': ('green-700', 'green-300'),
    'success-solid': ('green-600', 'green-500'),
    'success-soft': ('green-50', 'green-950'),
    'success-border': ('green-200', 'green-800'),
    'info': ('blue-700', 'blue-300'),
    'info-solid': ('blue-600', 'blue-500'),
    'info-soft': ('blue-50', 'blue-950'),
    'info-border': ('blue-200', 'blue-800'),
    # One step per status that works both as text and as a fill (bars, dots, borders).
    'status-danger': ('red-600', 'red-400'),
    'status-warning': ('amber-700', 'amber-400'),
    'status-success': ('green-700', 'green-400'),
    'status-info': ('blue-700', 'blue-400'),
    'chart': ('teal-500', 'teal-400'),
    'chart-muted': ('teal-200', 'teal-800'),
}
TEXT_CHECKS = [
    # (foreground role, background roles)
    ('text', ['canvas', 'surface', 'surface-raised']),
    ('text-muted', ['canvas', 'surface', 'surface-raised']),
    ('text-subtle', ['surface']),
    ('accent', ['surface', 'canvas', 'accent-soft']),
    ('on-accent', ['accent-solid']),
    ('danger', ['surface', 'danger-soft']),
    ('warning', ['surface', 'warning-soft']),
    ('success', ['surface', 'success-soft']),
    ('info', ['surface', 'info-soft']),
    ('status-danger', ['surface', 'canvas']),
    ('status-warning', ['surface', 'canvas']),
    ('status-success', ['surface', 'canvas']),
    ('status-info', ['surface', 'canvas']),
]
# Provider identity colours (step chosen to read on both themes).
PROVIDERS = {
    'claude': 'orange-500', 'codex': 'violet-500', 'antigravity': 'blue-500', 'gemini': 'blue-400',
    'xai': 'neutral-500', 'kimi': 'neutral-700', 'devin': 'teal-500', 'meta': 'blue-600',
    'other': 'neutral-400',
}


def generate():
    tokens = palette()
    lines = ['/* Generated by scripts/palette.py - edit the script, not this file. */',
             '/* Raw ramps (the same in both themes) and semantic roles (switch per theme). */', ':root {']
    lines += [f'  --p-{name}: {value};' for name, value in tokens.items()]
    lines += [f'  --provider-{name}: var(--p-{token});' for name, token in PROVIDERS.items()]
    lines += [f'  --c-{role}: var(--p-{light});' for role, (light, _) in ROLES.items()]
    lines += ['}', ":root[data-theme='dark'] {"]
    lines += [f'  --c-{role}: var(--p-{dark});' for role, (_, dark) in ROLES.items()]
    lines += ['}', '']
    PALETTE_CSS.write_text('\n'.join(lines), encoding='utf-8')
    print(f'wrote {PALETTE_CSS.relative_to(ROOT)} ({len(tokens)} colours)')
    return tokens


def contrast_report(tokens):
    failures = 0
    for theme_index, theme in enumerate(('light', 'dark')):
        for fg, bgs in TEXT_CHECKS:
            for bg in bgs:
                a = tokens[ROLES[fg][theme_index]]
                b = tokens[ROLES[bg][theme_index]]
                ratio = contrast(a, b)
                ok = ratio >= 4.5
                failures += not ok
                print(f'{theme:5} {fg:12} on {bg:15} {ratio:5.2f} {"ok" if ok else "FAIL"}')
    return failures


HEX = re.compile(r'(?<![\w-])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b')
COMMENT = re.compile(r'/\*.*?\*/', re.S)


def outside_comments(text, fn):
    """Apply fn to the code between comments, leaving comment text as written."""
    parts, last = [], 0
    for match in COMMENT.finditer(text):
        parts += [fn(text[last:match.start()]), match.group(0)]
        last = match.end()
    return ''.join(parts + [fn(text[last:])])


def css_files():
    return [p for p in (ROOT / 'src').rglob('*.css') if p != PALETTE_CSS and 'mocks' not in p.parts]


def nearest(value, tokens, labs):
    lab = srgb_to_oklab(hex_to_rgb(value))
    chroma = math.hypot(lab[1], lab[2])
    pool = [n for n in tokens if (n.startswith('neutral') if chroma < .05 else not n.startswith('neutral'))]
    best = min(pool, key=lambda n: sum((x - y) ** 2 for x, y in zip(lab, labs[n])))
    return best, math.dist(lab, labs[best])


def snap():
    tokens = palette()
    labs = {n: srgb_to_oklab(hex_to_rgb(v)) for n, v in tokens.items()}
    changed, shifts = 0, []
    for path in css_files():
        text = path.read_text(encoding='utf-8')

        def repl(match):
            nonlocal changed
            raw = match.group(1)
            alpha = None
            if len(raw) in (4, 8):
                alpha = int(raw[-2:] if len(raw) == 8 else raw[-1] * 2, 16) / 255
            name, distance = nearest('#' + raw, tokens, labs)
            shifts.append((distance, '#' + raw, name, path.name))
            changed += 1
            if alpha is None or alpha >= .999:
                return f'var(--p-{name})'
            return f'color-mix(in srgb, var(--p-{name}) {round(alpha * 100)}%, transparent)'
        new = outside_comments(text, lambda code: HEX.sub(repl, code))
        if new != text:
            path.write_text(new, encoding='utf-8', newline='')
    shifts.sort(reverse=True)
    print(f'snapped {changed} literals; largest shifts:')
    for distance, raw, name, file in shifts[:15]:
        print(f'  {distance:.3f} {raw} -> {name} ({file})')


def check():
    tokens = palette()
    left = []
    for path in css_files():
        # Blank out comments (keeping line numbers) so colours quoted in them aren't reported.
        code = COMMENT.sub(lambda m: '\n' * m.group(0).count('\n'), path.read_text(encoding='utf-8'))
        for number, line in enumerate(code.splitlines(), 1):
            if HEX.search(line):
                left.append(f'{path.relative_to(ROOT)}:{number}: {line.strip()}')
    print(f'{len(left)} hex literals outside palette.css')
    for item in left[:20]:
        print('  ' + item)
    failures = contrast_report(tokens)
    print(f'{failures} contrast failures')
    return 1 if left or failures else 0


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else 'check'
    if command == 'generate':
        contrast_report(generate())
    elif command == 'snap':
        snap()
    else:
        sys.exit(check())
