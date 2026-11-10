# jap-node22

From [JustAnotherPU/mgu-apps](https://github.com/JustAnotherPU/mgu-apps) `tools/jap-node22` (MIT,
`LICENSE.mgu-apps`; `set-loader.js` GPL-3.0-or-later), here marked for iDrive 8 too so that this repository's release
is whole on its own. `tools/release_id8.sh` packs it with the binary of mgu-apps' release (sha256 checked).

Node.js 22 LTS for the background services of Moonride (`jap-moonride`) and RideTube (`jap-ridetube-d`) on the
iDrive 7 and iDrive 8 head units (iDrive 8: offered since RideTube runs there; not yet run on an iDrive 8 car).
BMW's apps and MainApp keep the system Node 8; nothing here changes them.

## Why

The unit has glibc 2.27. The official Node 22 Linux binaries need glibc 2.28
or newer and do not start there. nodejs.org's
[unofficial-builds](https://unofficial-builds.nodejs.org/) `linux-x64-glibc-217`
flavour is built against glibc 2.17 (highest symbol needed: `GLIBC_2.17`) with
libstdc++ linked in. It needs only libc, libm, libdl and libpthread.

The pinned build is `node-v22.23.4-linux-x64-glibc-217.tar.xz`, sha256
`021b9ef3861926d32d0323c24a554c29f26d95895bfc56f5fdc3c2be7d062aa5`, from
`https://unofficial-builds.nodejs.org/download/release/v22.23.4/`. The hash is
the one in that release's `SHASUMS256.txt`. The site publishes no signature.

## On the unit

| Path | |
|---|---|
| `/var/opt/jap-node22/current/bin/node` | the binary, unchanged except its loader is set to `/lib/ld-linux-x86-64.so.2` (the unit has no `/lib64`, same as mgu-python) |
| `/var/opt/jap-node22/current/LICENSE` | Node.js licence and the licences of its bundled dependencies |
| `/var/opt/jap-node22/current/check.sh` | the mgu-deploy `check`: node starts and reports v22.23.4. It runs offline. If it fails, the install rolls back. |

The component has no units, no PATH change and nothing in `/usr`. It is binary
only, with no npm. The binary is 137 MB because upstream ships it unstripped
with debug info. Stripping it would save 27 MB, but that needs cross binutils,
so it is left alone. The artifact is about 49 MB.

## How a service uses it

Call it by absolute path through `current/`:

```ini
ExecStart=/var/opt/jap-node22/current/bin/node --max-http-header-size=65536 /var/opt/<tool>/current/main.js
```

- HTTPS works without system CA files because Node uses its bundled Mozilla roots.
- A tool that needs it declares `"requires": {"jap-node22": "22.23.4"}`.
- Internet access is still granted per tool (`internet` and `uids` in that tool's
  own component.json).
- Start from `current/`, not `versions/<v>/`. A second update in one boot prunes
  older versions. A process already running keeps its open binary, but new
  starts must find it under `current/`.

## Build

```sh
MGU_STORE=<a clone of the MGU Store> ./build.sh      # download (cached in build/download/, re-checked by sha256), patch loader, pack
                # -> dist/jap-node22@22.23.4.tgz
```

It needs curl, tar with xz, shasum and node. It packs with the MGU Store's
`deploy/hu artifact`.

`test/smoke.js` is the glibc 2.27 smoke test. Run it as root with internet:
`node --max-http-header-size=65536 test/smoke.js`. It checks the version, the
header-size flag (a 40 KB header), a TLS GET to youtube.com, a spawn with
uid/gid, and `dns.Resolver`.

## Install and roll back

```sh
mgu-deploy.sh install --artifact jap-node22@22.23.4.tgz
mgu-deploy.sh rollback jap-node22 --yes      # back to the other kept version
```

From a computer, the Store's `deploy/hu rollback jap-node22 --yes` does the same rollback.
To update, change `NODE_VERSION`, `SHA256` and `version` in component.json,
then rebuild.
