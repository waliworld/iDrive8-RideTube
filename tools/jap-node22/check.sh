#!/bin/sh
# mgu-deploy "check": the installed node starts (loader, glibc) and has its crypto; offline on purpose.
exec "$(dirname "$0")/bin/node" -e 'require("crypto").createHash("sha256");process.exit(process.version==="v22.23.4"?0:1)'
