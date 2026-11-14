#!/usr/bin/env python3
"""Re-record released ahwp 2.0.0 refusals from controlled, disposable inputs."""
import argparse
import copy
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from zipfile import ZipFile

HERE = Path(__file__).resolve().parent


def record(binary, destination):
    manifest = json.loads((HERE / 'manifest.json').read_text())
    version = subprocess.run([str(binary), '--version'], check=True, capture_output=True, text=True).stdout.strip()
    if version != 'ahwp 2.0.0':
        raise RuntimeError(f'Expected released ahwp 2.0.0; got {version!r}')
    # Same controlled protection fixture method as the engine's cli_surface.rs.
    # olefile writes an existing FileHeader stream without changing its size.
    import olefile

    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ahwp-refusal-reports-') as temporary:
        work = Path(temporary)

        def run(*args):
            return subprocess.run([str(binary), *args], cwd=work, capture_output=True, text=True)

        def create(*args):
            result = run(*args)
            if result.returncode:
                raise RuntimeError(result.stderr)

        def save(name, value):
            (work / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

        spec = {'version': '1.0', 'styles': {'body': {'font_size_pt': 10}}, 'sections': [{'blocks': [
            {'type': 'paragraph', 'style': 'body', 'runs': [{'type': 'text', 'text': 'Body anchor.'}]},
            {'type': 'paragraph', 'style': 'body', 'runs': [{'type': 'text', 'text': 'Second line.'}]},
        ]}]}
        save('base.spec.json', spec)
        create('compose', 'base.spec.json', '-o', 'base.hwpx')
        create('convert', 'base.hwpx', '-o', 'base.ir.json')
        base = json.loads((work / 'base.ir.json').read_text())

        def from_ir(name, document, extension='hwpx'):
            save(name + '.ir.json', document)
            create('new', '--from', name + '.ir.json', '-o', name + '.' + extension)

        tagged = copy.deepcopy(base)
        tagged['sections'][0]['paragraphs'][1]['extras'] = [
            {'tag': 70, 'data': b'opaque range sentinel'.hex(), 'children': []},
        ]
        from_ir('tagged', tagged, 'hwp')

        duplicate = copy.deepcopy(base)
        duplicate['header']['styles'].append(copy.deepcopy(duplicate['header']['styles'][0]))
        from_ir('duplicate-style', duplicate)

        character = copy.deepcopy(base)
        character['header']['styles'][1]['attr'] = 1
        from_ir('character-style-not-base', character)

        overflow = copy.deepcopy(base)
        while len(overflow['header']['styles']) < 257:
            index = len(overflow['header']['styles'])
            style = copy.deepcopy(overflow['header']['styles'][0])
            style['name'] = style['english_name'] = f'overflow-{index}'
            overflow['header']['styles'].append(style)
        from_ir('style-overflow', overflow)

        def alter_zip(source, target, transform):
            with ZipFile(work / source) as original, ZipFile(work / target, 'w') as changed:
                for info in original.infolist():
                    data = original.read(info.filename)
                    if info.filename == 'Contents/header.xml':
                        data = transform(data.decode()).encode()
                    changed.writestr(info, data)

        create('new', '-o', 'font-base.hwpx')
        def add_font_type_info(header):
            original = 'face="함초롬바탕" type="TTF" isEmbedded="0"/>'
            replacement = 'face="함초롬바탕" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font>'
            assert original in header
            return header.replace(original, replacement, 1)
        alter_zip('font-base.hwpx', 'font-type-info.hwpx', add_font_type_info)

        def break_style_reference(header):
            body = next(style for style in re.findall(r'<hh:style\b[^>]*?/>', header) if 'name="body"' in style)
            assert 'charPrIDRef="0"' in body
            return header.replace(body, body.replace('charPrIDRef="0"', 'charPrIDRef="9999"'), 1)
        alter_zip('base.hwpx', 'broken-style.hwpx', break_style_reference)

        create('convert', 'base.hwpx', '-o', 'protection-base.hwp')
        flags = {'encrypted': 2, 'drm': 16, 'cert-encrypted': 256, 'cert-drm': 1024, 'signed': 128}
        for label, bits in flags.items():
            protected = work / f'protected-{label}.hwp'
            shutil.copyfile(work / 'protection-base.hwp', protected)
            with olefile.OleFileIO(protected, write_mode=True) as container:
                header = bytearray(container.openstream('FileHeader').read())
                attrs = int.from_bytes(header[36:40], 'little')
                header[36:40] = (attrs | bits).to_bytes(4, 'little')
                container.write_stream('FileHeader', bytes(header))

        for case in manifest['cases']:
            if 'ops' in case:
                shutil.copyfile(HERE / case['ops'], work / case['ops'])
            args = case['command'][1:]
            result = run(*args)
            if result.returncode != case['exit']:
                raise RuntimeError(f"{case['name']}: exit {result.returncode}: {result.stderr}")
            report_file = work / args[args.index('--report') + 1]
            report = json.loads(report_file.read_text())
            assert report['refusal']['code'] == case['code'], case['name']
            assert report['schema_version'] == '1.1', case['name']
            output = work / args[args.index('-o') + 1]
            assert not output.exists(), f"{case['name']}: refused run published output"
            shutil.copyfile(report_file, destination / case['report'])
            (destination / case['stderr']).write_text(result.stderr)
    print(f"Recorded {len(manifest['cases'])} real refused-run reports with {version}.")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin', required=True, type=Path, help='Checksum-verified released ahwp 2.0.0 executable')
    parser.add_argument('--output-dir', required=True, type=Path, help='Destination for re-recorded reports and stderr')
    args = parser.parse_args()
    record(args.bin.resolve(), args.output_dir.resolve())
