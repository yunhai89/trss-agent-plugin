#!/usr/bin/env python3
"""配置真源对账 v2：yaml 叶子 / 锅巴 field / web 表单 / 代码读取 token（去注释）。"""
import os, re, json
import yaml

ROOT = '/root/trss-agent-plugin'

def flatten(obj, prefix=''):
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f'{prefix}.{k}' if prefix else str(k)
            out.update(flatten(v, p))
    else:
        out[prefix] = obj
    return out

cfg = yaml.safe_load(open(os.path.join(ROOT, 'config/default_config/config.yaml'), encoding='utf-8'))
leaves = flatten(cfg)

def strip_comments(src):
    src = re.sub(r'/\*[\s\S]*?\*/', ' ', src)
    src = re.sub(r'(?m)^\s*//.*$', ' ', src)
    src = re.sub(r'(?m)//.*$', ' ', src)
    return src

code_files = []
for base in ['apps', 'model', 'utils', 'tools', 'scripts']:
    for dp, dn, fn in os.walk(os.path.join(ROOT, base)):
        for f in fn:
            if (f.endswith('.js') or f.endswith('.mjs')) and '.test.' not in f:
                code_files.append(os.path.join(dp, f))
code_files.append(os.path.join(ROOT, 'index.js'))

files_idx = {}
for f in code_files:
    try: files_idx[f] = strip_comments(open(f, encoding='utf-8').read())
    except Exception: pass

# property access tokens .foo / ?.foo / ['foo'] / {foo: / foo, 等
prop = {}
for f, t in files_idx.items():
    for m in re.finditer(r'(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)', t):
        prop.setdefault(m.group(1), set()).add(f)

guoba = open(os.path.join(ROOT, 'guoba.support.js'), encoding='utf-8').read()
gfields = set(re.findall(r"field:\s*'([^']+)'", guoba))
webfiles = [os.path.join(ROOT, 'web/assets/js/views', x) for x in os.listdir(os.path.join(ROOT, 'web/assets/js/views'))]
web = ''
for f in webfiles: web += open(f, encoding='utf-8').read()
wfields = set(re.findall(r'form\.([A-Za-z0-9_.]+)', web))

rows = []
for path, val in leaves.items():
    key = path.split('.')[-1]
    hits = sorted(os.path.relpath(f, ROOT) for f in prop.get(key, ()))
    rows.append(dict(path=path, value=val, prop_files=hits, prop_count=len(hits), guoba=path in gfields,
                     web=(path[len('agent.'):] if path.startswith('agent.') else path) in wfields))

print(f'叶子 {len(rows)} | 无属性读取 {sum(1 for r in rows if r["prop_count"]==0)} | 锅巴 {sum(r["guoba"] for r in rows)} | web {sum(r["web"] for r in rows)}')
print('\n== 无任何 .key 读取（死配置候选）==')
for r in rows:
    if r['prop_count'] == 0:
        print(f'{r["path"]} = {json.dumps(r["value"], ensure_ascii=False)[:70]}')
print('\n== 仅 1 处读取（低接线候选）==')
for r in rows:
    if r['prop_count'] == 1:
        print(f'{r["path"]} -> {r["prop_files"][0]}')
print('\n== 锅巴有、yaml 无 ==')
for x in sorted(gfields - set(leaves)): print('  ', x)
print('\n== web 有、yaml 无（相对 agent 根，前 120）==')
rel = {p[len('agent.'):] if p.startswith('agent.') else p for p in leaves}
extra = sorted(x for x in wfields if x not in rel)
print('总数', len(extra))
for x in extra[:120]: print('  ', x)
json.dump(rows, open(os.path.join(ROOT, 'audit/tools/inventory.json'), 'w'), ensure_ascii=False, indent=1)
