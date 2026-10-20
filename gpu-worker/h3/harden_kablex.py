#!/usr/bin/env python3
"""Apply reviewable experimental hardening to one exact upstream source file.

CUDA execution is not certified. Successful gate attachment still modifies shared
model modules; use a dedicated process and restart before changing configurations.
"""
import argparse
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def transform(source):
    marker = 'class Ref2VAVSAGatePatch:'
    before, after = source.split(marker, 1)
    guard = '''        # Modified for Backlot: fail before allocating or mutating the model.
        import os
        import comfy_kitchen as ck
        if os.environ.get("BACKLOT_DEDICATED_VSA_WORKER") != "1":
            raise RuntimeError("Backlot VSA requires a dedicated worker process; set BACKLOT_DEDICATED_VSA_WORKER=1 and restart before changing gate files or attention configuration")
        backend = ck.list_backends().get("cuda", {})
        if not torch.cuda.is_available() or not backend.get("available") or backend.get("disabled") or "sol_attn" not in backend.get("capabilities", []):
            raise RuntimeError("Backlot VSA requires a working CUDA sol_attn backend before gate attachment")

'''
    anchor = '        sparsity = float(sparsity)\n'
    if after.count(anchor) != 1:
        raise RuntimeError('Unexpected upstream method layout')
    after = after.replace(anchor, guard + anchor, 1)
    after = after.replace('                device=weight.device,', '                device="meta",', 1)
    # Preserve every existing gate, including its absence, if setup later fails.
    start = after.index('        for index, block in enumerate(blocks):')
    end = after.index('\n\n\nNODE_CLASS_MAPPINGS')
    body = after[start:end]
    clone_anchor = '        (patched,) = FastH3VSAPatch().patch(patched, sparsity=sparsity)'
    if body.count(clone_anchor) != 1:
        raise RuntimeError('Unexpected upstream clone location')
    body = body.replace(clone_anchor, '        patched.size = 0  # Gates add memory; invalidate the cached model-size estimate.\n' + clone_anchor)
    replacement = '''        previous_gates = [(block.attn, hasattr(block.attn, "to_gate_compress"),
                           getattr(block.attn, "to_gate_compress", None)) for block in blocks]
        try:
''' + '\n'.join('    ' + line if line else '' for line in body.splitlines()) + '''
        except Exception:
            for attn, existed, previous in previous_gates:
                if existed:
                    setattr(attn, "to_gate_compress", previous)
                elif hasattr(attn, "to_gate_compress"):
                    delattr(attn, "to_gate_compress")
            patched.size = 0
            raise
'''
    return before + marker + after[:start] + replacement + after[end:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('nodes_file', type=Path)
    args = parser.parse_args()
    lock = json.loads((HERE / 'models.lock.json').read_text())
    data = args.nodes_file.read_bytes()
    original_hash = lock['kablex_nodes_sha256']
    backup = args.nodes_file.with_suffix('.py.upstream')
    if backup.exists() and hashlib.sha256(backup.read_bytes()).hexdigest() == original_hash:
        expected = transform(backup.read_text()).encode()
        if data == expected:
            print('Exact Backlot hardening already applied')
            return
    if hashlib.sha256(data).hexdigest() != original_hash:
        raise RuntimeError('Refusing to patch an unknown or edited upstream nodes.py')
    changed = transform(data.decode())
    compile(changed, str(args.nodes_file), 'exec')
    backup.write_bytes(data)
    args.nodes_file.write_text(changed)
    print(json.dumps({'upstream_sha256': original_hash,
                      'modified_sha256': hashlib.sha256(changed.encode()).hexdigest(),
                      'gpu_validated': False}))


if __name__ == '__main__':
    main()
