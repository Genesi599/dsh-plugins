#!/usr/bin/env bash
# 部署 hub-desktop-ui 客户端插件到 DSH（out-of-tree：只写 $DSH_HOME，不碰安装目录）
#
# 用法：
#   bash deploy.sh <profile>        # 复制包 + 给该 profile 的 cordis.patch.yml 追加插件行
#   bash deploy.sh <profile> --pkg-only   # 只复制包
#
# 回退：从 cordis.patch.yml 删掉 `hub-desktop-ui` 行（或整段 insert），重启 DSH 即可。
set -euo pipefail

PROFILE="${1:-}"
PKG_ONLY="${2:-}"
if [ -z "$PROFILE" ]; then echo "usage: bash deploy.sh <profile> [--pkg-only]"; exit 2; fi

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME="${DSH_HOME:-$USERPROFILE/.dsh}"
DEST="$DSH_HOME/profiles/node_modules/@ai-agent-hub/dsh-client-ui-hub-desktop"
PATCH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"

[ -d "$DSH_HOME/profiles/$PROFILE" ] || { echo "profile not found: $PROFILE"; exit 1; }

mkdir -p "$DEST/lib"
cp "$SRC_DIR/package.json" "$DEST/package.json"
cp "$SRC_DIR/lib/index.js" "$DEST/lib/index.js"
cp "$SRC_DIR/lib/client.js" "$DEST/lib/client.js"
echo "package deployed -> $DEST"

if [ "$PKG_ONLY" = "--pkg-only" ]; then exit 0; fi

if grep -q "hub-desktop-ui" "$PATCH"; then
  echo "patch already contains hub-desktop-ui row; left unchanged"
  exit 0
fi

cp "$PATCH" "$PATCH.bak-hub-desktop-ui"
cat >> "$PATCH" <<'YAML'

# AI-Agent-Hub: DSH Desktop 前端定制（out-of-tree 客户端插件）
- insert:
    - id: hub-desktop-ui
      name: '@ai-agent-hub/dsh-client-ui-hub-desktop'
YAML
echo "row appended -> $PATCH (backup: $PATCH.bak-hub-desktop-ui)"