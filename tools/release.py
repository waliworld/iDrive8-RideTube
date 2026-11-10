#!/usr/bin/env python3
"""Lays out the MGU Store catalog of this repository in dist/release/: catalog.json, the app's OAP package
(without node_modules/oap-sdk: the head unit makes it from an app already on the car), the service's tool kit
and the app icon. jap-node22 (required by jap-ridetube-d) comes from the JustAnotherPU/mgu-apps source. Upload every file of dist/release/ as an asset of a GitHub release tagged `catalog`.

Build first:  python3 kit/tools/build.py jap_ridetube                      (dist/jap_ridetube@<v>.tgz, iDrive 7)
              python3 kit/tools/build.py --hmi ID8 jap_ridetube            (dist/jap_ridetube8@<v>.tgz, iDrive 8)
              (cd native/ytdec && make target)
              (cd native/jap-ridetube-d && MGU_STORE=... ./build.sh)      (its dist/)
Then:         python3 tools/release.py [--base URL] [--repo owner/name] [--hmi ID7|ID8|both] [--tool <kit.tgz> ...]
--base: where the car downloads the assets from; default the public release download of the `catalog`
release. For a private repository, list the assets' API URLs instead (docs/PUBLISHING.md of the Store).
--repo: the GitHub repository whose `catalog` release holds the assets (default this one, waliworld/iDrive8-RideTube).
--hmi: the head units this release is for (default ID8: this repository is RideTube for iDrive 8); its tools are
listed for those head units only.
--tool: another tool kit to list beside the service (jap-node22, so that the release is whole on its own).
tools/release_id8.sh does all of it for this repository's release.
"""
import argparse, gzip, hashlib, io, json, os, shutil, sys, tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = 'waliworld/iDrive8-RideTube'     # (upstream: JustAnotherPU/ridetube)
APP = 'jap_ridetube'
# one Store entry per head unit, built from the same app (an entry's requirements hold for every car it installs on: the
# controller gate is iDrive 7's only)
APPS = (
    (APP, ['ID7'], lambda d: {'jap-ridetube-d': d, 'mgu-render': '0.6.11', 'mgu-inputgate': '1.0.0'}),
    # iDrive 8: mgu-render 0.6.10+ shows layer apps there (yield surfaces); mgu-deploy 0.7.16+ keeps the tile once the
    # car has synced its apps with BMW's backend (the provisioning fallback)
    (APP + '8', ['ID8'], lambda d: {'jap-ridetube-d': d, 'mgu-render': '0.6.11', 'mgu-deploy': '0.7.16'}),
)
TOOLS = ('jap-ridetube-d',)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def strip_sdk(src, dst, mtime):
    """The OAP package again, without node_modules/oap-sdk, sorted, owner 0:0, one mtime."""
    with tarfile.open(src, 'r:gz') as t:
        members = [(m, t.extractfile(m).read() if m.isfile() else None) for m in t.getmembers()]
    keep = [(m, d) for m, d in members if 'node_modules/oap-sdk' not in m.name]
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w', format=tarfile.USTAR_FORMAT) as out:
        for m, d in sorted(keep, key=lambda x: x[0].name):
            m.uid = m.gid = 0
            m.uname = m.gname = ''
            m.mtime = mtime
            out.addfile(m, io.BytesIO(d) if d is not None else None)
    with open(dst, 'wb') as f, gzip.GzipFile(fileobj=f, mode='wb', mtime=mtime, filename='') as g:
        g.write(buf.getvalue())
    with tarfile.open(dst, 'r:gz') as t:
        assert not any('oap-sdk' in n for n in t.getnames()), 'oap-sdk left in the package'


def artifact(path, base):
    name = os.path.basename(path)
    return {'name': name, 'size': os.path.getsize(path), 'sha256': sha256(path), 'url': base + name}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default=REPO)
    ap.add_argument('--base', default=None)
    ap.add_argument('--hmi', choices=['ID7', 'ID8', 'both'], default='ID8')
    ap.add_argument('--tool', action='append', default=[], help='another tool kit (.tgz) to list')
    a = ap.parse_args()
    a.base = a.base or 'https://github.com/%s/releases/download/catalog/' % a.repo
    hmis = ['ID7', 'ID8'] if a.hmi == 'both' else [a.hmi]
    apps = [x for x in APPS if set(x[1]) <= set(hmis)]
    mtime = int(os.environ.get('SOURCE_DATE_EPOCH', '0'))
    out = os.path.join(ROOT, 'dist', 'release')
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)

    app = json.load(open(os.path.join(ROOT, 'apps', APP, 'app.json')))
    tools = {t: json.load(open(os.path.join(ROOT, 'native', t, 'component.json'))) for t in TOOLS}
    pkgs = {}
    for aid, hmi, _ in apps:
        pkg = os.path.join(ROOT, 'dist', '%s@%s.tgz' % (aid, app['version']))
        if not os.path.isfile(pkg):
            sys.exit('release.py: %s missing (python3 kit/tools/build.py%s %s)' % (pkg, ' --hmi ID8' if hmi == ['ID8'] else '', APP))
        strip_sdk(pkg, os.path.join(out, os.path.basename(pkg)), mtime)
        pkgs[aid] = os.path.basename(pkg)
        # the local build's packages hold BMW's oap-sdk: only dist/release/ is ever uploaded, so they go
        for f in (pkg, pkg[:-4] + '.mgu'):
            if os.path.exists(f):
                os.remove(f)
    for t, c in tools.items():
        kit = os.path.join(ROOT, 'native', t, 'dist', '%s@%s.tgz' % (t, c['version']))
        if not os.path.isfile(kit):
            sys.exit('release.py: %s missing (cd native/%s && ./build.sh)' % (kit, t))
        shutil.copy(kit, out)
    icon = APP + '.png'
    shutil.copy(os.path.join(ROOT, 'apps', APP, 'icon.png'), os.path.join(out, icon))
    assert os.path.getsize(os.path.join(out, icon)) <= 128 * 1024

    comps = [{
        'id': aid, 'kind': 'app', 'title': app['title'],
        'description': app['description'] if hmi == ['ID7'] else app['id8'].get('description', app['description']),
        'version': app['version'], 'artifact': artifact(os.path.join(out, pkgs[aid]), a.base),
        'requires': req(tools['jap-ridetube-d']['version']),
        'uninstallable': True, 'mguHmi': hmi, 'icon': icon, 'iconSha256': sha256(os.path.join(out, icon)),
    } for aid, hmi, req in apps]
    # the tools: listed for this release's head units only (each kit itself may say more)
    for kit in a.tool:
        with tarfile.open(kit, 'r:gz') as t:
            c = json.load(t.extractfile('component.json'))
        if os.path.basename(kit) != '%s@%s.tgz' % (c['id'], c['version']):
            sys.exit('release.py: %s is not named <id>@<version>.tgz of its component.json' % kit)
        shutil.copy(kit, out)
        # requirements and uninstallable are catalog fields: from the tool's own component.json in this repository
        for d in ('tools', 'native'):
            src = os.path.join(ROOT, d, c['id'], 'component.json')
            if os.path.isfile(src):
                s = json.load(open(src))
                c = dict(c, requires=s.get('requires', {}), uninstallable=s.get('uninstallable', False))
                break
        tools[c['id']] = c
    for t, c in tools.items():
        hu = [h for h in c.get('mguHmi', ['ID7']) if h in hmis]
        if not hu:
            sys.exit('release.py: %s is not for %s' % (t, ' or '.join(hmis)))
        e = {'id': t, 'kind': 'tool', 'title': c['title'], 'description': c['description'], 'version': c['version'],
             'artifact': artifact(os.path.join(out, '%s@%s.tgz' % (t, c['version'])), a.base),
             'requires': c.get('requires', {}), 'uninstallable': bool(c.get('uninstallable')), 'mguHmi': hu}
        if t != 'jap-ridetube-d':
            e['optional'] = True       # (installed as a requirement, never offered on its own as an update)
        comps.append(e)
    with open(os.path.join(out, 'catalog.json'), 'w') as f:
        json.dump({'schema': 2, 'components': comps}, f, indent=2)
        f.write('\n')
    for n in sorted(os.listdir(out)):
        print('%10d  %s' % (os.path.getsize(os.path.join(out, n)), n))


if __name__ == '__main__':
    main()
