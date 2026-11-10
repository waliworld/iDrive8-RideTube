#!/bin/sh
# Vendors jpeg-js's decoder (BSD-3-Clause) into vendor/jpeg-js/ from the npm registry tarball,
# checked against the pinned sha512 (the registry's dist.integrity for this version).
set -eu
VERSION=0.4.4
SHA512=WZzeDOEtTOBK4Mdsar0IqEU5sMr3vSV2RqkAIzUEV2BHnUfKGyswWFPFwK5EeDo93K3FohSHbLAjj0s1Wzd+dg==
here=$(cd "$(dirname "$0")/.." && pwd)
dl=$(mktemp -d)  # downloads in their own empty dir
trap 'rm -rf "$dl"' EXIT
curl -fsSL -o "$dl/jpeg-js.tgz" "https://registry.npmjs.org/jpeg-js/-/jpeg-js-$VERSION.tgz"
got=$(openssl dgst -sha512 -binary "$dl/jpeg-js.tgz" | openssl base64 -A)
[ "$got" = "$SHA512" ] || { echo "vendor_jpeg.sh: sha512 mismatch for jpeg-js $VERSION ($got)" >&2; exit 1; }
mkdir "$dl/x"
tar -xzf "$dl/jpeg-js.tgz" -C "$dl/x" package/lib/decoder.js package/LICENSE package/package.json
grep -q "\"version\": \"$VERSION\"" "$dl/x/package/package.json"
rm -rf "$here/vendor/jpeg-js"
mkdir -p "$here/vendor/jpeg-js"
cp "$dl/x/package/lib/decoder.js" "$dl/x/package/LICENSE" "$here/vendor/jpeg-js/"
echo "jpeg-js $VERSION sha512-$SHA512" > "$here/vendor/jpeg-js/VERSION"
