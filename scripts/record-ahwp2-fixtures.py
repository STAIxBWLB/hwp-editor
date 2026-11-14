#!/usr/bin/env python3
"""Record #171 fixtures with a released ahwp binary, never a source build.

Usage: python3 scripts/record-ahwp2-fixtures.py /path/to/ahwp /path/to/scratch
Optional third argument: the original hwp-cli-plan-template.hwpx from the host.
Writes captures to scratch only, so older schema fixtures are not overwritten.
"""
import json
import subprocess
import sys
import zipfile
from pathlib import Path

binary = str(Path(sys.argv[1]).resolve())
work = Path(sys.argv[2]).resolve()
work.mkdir(parents=True, exist_ok=True)
assert subprocess.check_output([binary, '--version'], text=True).strip() == 'ahwp 2.0.0'


def run(*args):
    return subprocess.check_output([binary, *map(str, args)], cwd=work, text=True)


def save(name, value):
    (work / name).write_text(value)


def capture(file, name, fmt='markdown', v2=True):
    args = ['cat', file, '--format', fmt, '--with-segments']
    if v2:
        args += ['--segments', 'v2']
    save(name, run(*args))


def spec(name, paragraphs):
    save(name, json.dumps({'version': '2.0', 'document': {'version': '1.0', 'sections': [
        {'blocks': [{'type': 'paragraph', 'runs': runs} for runs in paragraphs]}
    ]}}, ensure_ascii=False))


def text(value, **props):
    return {'type': 'text', 'text': value, **props}


spec('runs.spec.json', [[text('앞 '), text('굵게', bold=True), text(' 뒤')]])
run('compose', 'runs.spec.json', '-o', 'runs.hwpx')
capture('runs.hwpx', 'runs-v2.json')
# The release's HWPX reader imports <hp:tab/> as the stored eight-unit TAB.
with zipfile.ZipFile(work / 'runs.hwpx') as src, zipfile.ZipFile(work / 'controls.hwpx', 'w') as dst:
    for info in src.infolist():
        data = src.read(info.filename)
        if info.filename == 'Contents/section0.xml':
            xml = data.decode()
            assert '>앞 </hp:t>' in xml
            data = xml.replace('>앞 </hp:t>', '>앞<hp:tab/>가나다뒤</hp:t>').encode()
        dst.writestr(info, data)
capture('controls.hwpx', 'controls-v2.json')

spec('ranges.spec.json', [
    [text('동일문 안내')], [text(' 동일문 안내')], [text(' / ', bold=True)],
    [text(' ', bold=True), text('ab')], [text(' '), text('x', bold=True), text('y')],
    [text('a\\b a&b a<b')],
    [text(' ', bold=True, font_size_pt=12), text(' ', bold=True), text('x')],
])
for ext in ['hwpx', 'hwp']:
    run('compose', 'ranges.spec.json', '-o', f'ranges.{ext}')
    capture(f'ranges.{ext}', f'ranges-{ext}.json')

if len(sys.argv) > 3:
    original = Path(sys.argv[3]).resolve()
    capture(original, 'plan-v1.json', v2=False)
    capture(original, 'plan-v2.json')
    run('render', original, '-o', 'plan.svg', '--layout-json', 'all-layout.json')
    ops = [{'op': 'replace', 'address': {'at': {'section': 0, 'paragraph': n}}, 'from': a, 'to': b}
           for n, a, b in [(0, '{{사업명}} 사업계획서', '1. lit'),
                           (3, 'Ⅰ. 사업 개요', '- dash * star'), (4, '사업명: {{사업명}}', 'abc')]]
    save('literal.ops.json', json.dumps(ops, ensure_ascii=False))
    run('edit', original, '-o', 'literal.hwpx', '--ops', 'literal.ops.json')
    capture('literal.hwpx', 'literal-v1.json', v2=False)
    capture('literal.hwpx', 'literal-v2.json', fmt='json')
    run('render', 'literal.hwpx', '-o', 'literal.svg', '--layout-json', 'literal-layout.json')
print(f'Recorded ahwp 2.0.0 captures in {work}')
