#!/usr/bin/env python3
"""配置真源对账：yaml 叶子 / 锅巴 field / web form 绑定 / 代码标识符出现次数。"""
import os, re, json, sys
import yaml

ROOT = '/root/trss-agent-plugin'
yaml_path = os.path.join(ROOT, 'config/default_config/config.yaml')

def flatten(obj, prefix=''):
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f'{prefix}.{k}' if prefix else str(k)
            out.update(flatten(v, p))
    else:
        out[prefix] = obj
    return out

cfg = yaml.safe_load(open(yaml_path, encoding='utf-8'))
leaves = flatten(cfg)

# 1) guoba fields
guoba = open(os.path.join(ROOT, 'guoba.support.js'), encoding='utf-8').read()
gfields = set(re.findall(r"field:\s*'([^']+)'", guoba))
# 2) web form bindings
web = open(os.path.join(ROOT, 'web/assets/js/views/config.js'), encoding='utf-8').read()
wfields = set(re.findall(r'form\.([A-Za-z0-9_.]+)', web))
wv = set(re.findall(r'v-model(?::[a-z]+)?="form\.([A-Za-z0-9_.]+)"', web))
# 3) code corpus
code_files = []
for base in ['apps', 'model', 'utils', 'tools', 'scripts']:
    for dp, dn, fn in os.walk(os.path.join(ROOT, base)):
        if 'node_modules' in dp: continue
        for f in fn:
            if f.endswith('.js') or f.endswith('.mjs'):
                if '.test.' in f or f.endswith('.test.mjs'): continue
                code_files.append(os.path.join(dp, f))
for extra in ['index.js']:
    code_files.append(os.path.join(ROOT, extra))
corpus = ''
files_idx = {}
for f in code_files:
    try: t = open(f, encoding='utf-8').read()
    except Exception: continue
    files_idx[f] = t
    corpus += t

def refs(key):
    n = len(re.findall(r'\b' + re.escape(key) + r'\b', corpus))
    fs = [os.path.relpath(f, ROOT) for f, t in files_idx.items() if re.search(r'\b' + re.escape(key) + r'\b', t)]
    return n, fs

rows = []
for path, val in leaves.items():
    key = path.split('.')[-1]
    n, fs = refs(key)
    g = path if path in gfields else ('~' + path if any(x.endswith('.' + path) or x == path for x in []) else '')
    # guoba fields are full agent.* paths; yaml leaves are also full (agent.xxx)
    ing = path in gfields
    # web form paths are relative to agent.*
    rel = path[len('agent.'):] if path.startswith('agent.') else path
    inw = rel in wfields
    rows.append(dict(path=path, value=val, code_refs=n, files=fs[:4], guoba=ing, web=inw))

dead = [r for r in rows if r['code_refs'] == 0]
print(f'叶子总数 {len(rows)}; 代码零引用 {len(dead)}; 锅巴覆盖 {sum(r["guoba"] for r in rows)}; web 覆盖 {sum(r["web"] for r in rows)}')
print('\n== 代码零引用（可能是死配置，需人工复核）==')
for r in dead:
    print(f'{r["path"]} = {json.dumps(r["value"], ensure_ascii=False)[:60]}')
print('\n== yaml 有 / 锅巴没有 / web 没有 ==')
for r in rows:
    if not r['guoba'] and not r['web']:
        print(f'{r["path"]}')
print('\n== web 覆盖但 yaml 没有的 form 路径（前 80）==')
yaml_rel = {p[len('agent.'):] if p.startswith('agent.') else p for p in leaves}
extra_w = sorted(x for x in wfields if x not in yaml_rel)
print(len(extra_w))
for x in extra_w[:80]: print('  ', x)
print('\n== 锅巴 field 但 yaml 没有 ==')
extra_g = sorted(x for x in gfields if x not in leaves)
for x in extra_g: print('  ', x)
json.dump(rows, open(os.path.join(ROOT, 'audit/tools/inventory.json'), 'w'), ensure_ascii=False, indent=1)
