#!/usr/bin/env bash
set -euo pipefail

# Build one ABI on a Linux x64 host whose glibc is <= 2.28.
# Usage: rebuild-linux-sqlcipher-native.sh <node> <package-dir> <archive-path>
node_bin=${1:?node binary is required}
package_dir=${2:?better-sqlite3-multiple-ciphers package directory is required}
archive_path=${3:?output tar.gz path is required}
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
node_gyp_bin=${NODE_GYP_BIN:-$(dirname "$node_bin")/../lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js}

glibc=$(getconf GNU_LIBC_VERSION)
case "$glibc" in
  glibc\ 2.[0-9]|glibc\ 2.1[0-9]|glibc\ 2.2[0-8]) ;;
  *) echo "Refusing incompatible build host: $glibc; require glibc <= 2.28" >&2; exit 1 ;;
esac

package_dir=$(cd "$package_dir" && pwd)
archive_path=$(realpath -m "$archive_path")
cd "$package_dir"
env npm_config_build_from_source=true npm_config_prebuild_install=false \
  "$node_bin" "$node_gyp_bin" rebuild --release
native="$package_dir/build/Release/better_sqlite3.node"
test -s "$native"
"$node_bin" "$repo_root/tools/release/linux-native-symbols.cjs" "$native"
mkdir -p "$(dirname "$archive_path")"
tar -czf "$archive_path" -C "$package_dir" build/Release/better_sqlite3.node
echo "SQLCIPHER_ARCHIVE=$archive_path"
