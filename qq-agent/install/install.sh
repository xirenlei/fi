#!/usr/bin/env bash
# QQ Agent 一键安装(Ubuntu/Debian,x86_64 或 arm64)
#
#   从仓库安装:  curl -fsSL https://raw.githubusercontent.com/xirenlei/fi/main/qq-agent/install/install.sh | bash
#   从本地目录:  ./install/install.sh
#
# 可用环境变量:
#   QQA_SKIP_DEPS=1    不用 apt 安装系统依赖(依赖已装好,或没有 root/sudo)
#   QQA_BRANCH=main    指定分支
#   QQA_APP_DIR=...    安装目录,默认 ~/.local/share/qq-agent
#   QQ_AGENT_HOME=...  配置和数据目录,默认 ~/.config/qq-agent
set -euo pipefail

REPO_URL="${QQA_REPO:-https://github.com/xirenlei/fi.git}"
BRANCH="${QQA_BRANCH:-main}"
APP_DIR="${QQA_APP_DIR:-$HOME/.local/share/qq-agent}"
DATA_DIR="${QQ_AGENT_HOME:-$HOME/.config/qq-agent}"
NAPCAT_INSTALLER_URL="https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh"
BIN_DIR="$HOME/.local/bin"
QQ_BIN="$HOME/Napcat/opt/QQ/qq"
NAPCAT_CONFIG_DIR="$HOME/Napcat/opt/QQ/resources/app/app_launcher/napcat/config"
WORKDIR="$DATA_DIR/workspace"

c_ok=$'\033[1;32m'; c_warn=$'\033[1;33m'; c_err=$'\033[1;31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
step() { echo; echo "${c_ok}==>${c_off} $*"; }
warn() { echo "${c_warn}警告:${c_off} $*" >&2; }
die()  { echo "${c_err}错误:${c_off} $*" >&2; exit 1; }

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else return 1
  fi
}

# 安装失败时打印的系统诊断信息
diagnose_system() {
  echo "${c_dim}--- 诊断信息 ---${c_off}"
  echo "系统: $( . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-未知}" )  架构: $(uname -m)  用户: $(id -un)"
  echo "磁盘:"; df -h / "$HOME" 2>/dev/null | sed 's/^/  /'
  local d
  for d in /etc /var/lib/dpkg "$HOME"; do
    if touch "$d/.qqa-write-test" 2>/dev/null; then rm -f "$d/.qqa-write-test"; echo "$d 可写"; else echo "$d 不可写(只读或无权限)"; fi
  done
  echo "dpkg 状态异常的包:"; dpkg --audit 2>&1 | head -8 | sed 's/^/  /'
  echo "${c_dim}----------------${c_off}"
}

# ---------- 0. 环境检查 ----------
step "检查环境"
[ "$(uname -s)" = Linux ] || die "只支持 Linux"
case "$(uname -m)" in x86_64|aarch64) ;; *) die "不支持的架构 $(uname -m)" ;; esac
command -v apt-get >/dev/null 2>&1 || warn "没有 apt-get,系统依赖需要你手动安装(xvfb、ffmpeg、jq、unzip 等)"
[ "$(id -u)" -ne 0 ] || warn "正在以 root 运行,建议用普通用户安装(QQ 和 NapCat 会装在当前用户的目录里)"
mkdir -p "$DATA_DIR/logs" "$BIN_DIR"
# 全部输出同时写进日志文件,出问题时把它发给开发者
exec > >(tee -a "$DATA_DIR/logs/install.log") 2>&1
echo "安装日志: $DATA_DIR/logs/install.log"

# ---------- 1. 系统依赖 ----------
step "安装系统依赖"
if [ "${QQA_SKIP_DEPS:-0}" = 1 ]; then
  echo "已按 QQA_SKIP_DEPS=1 跳过"
elif command -v apt-get >/dev/null 2>&1; then
  if as_root apt-get update -y -qq && as_root apt-get install -y -qq git curl unzip jq ffmpeg xvfb xauth ca-certificates; then
    echo "完成"
  else
    warn "apt 安装失败(没有权限、系统目录只读,或 dpkg 状态异常)。先继续往下装,稍后会检查缺了什么。"
    diagnose_system
    QQA_SKIP_DEPS=1   # NapCat 官方脚本也会用 apt,同样会失败,所以让它跳过
  fi
fi
for t in curl unzip jq git; do command -v "$t" >/dev/null 2>&1 || die "缺少 $t,请先安装"; done
command -v ffmpeg >/dev/null 2>&1 || warn "没有 ffmpeg:动图/视频抽帧识别不可用,静态图不受影响"
command -v xvfb-run >/dev/null 2>&1 || warn "没有 xvfb-run:NapCat 无法在无显示环境启动"

# ---------- 2. Bun ----------
step "准备 Bun(Agent 的运行环境)"
if command -v bun >/dev/null 2>&1; then BUN="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"
else
  curl -fsSL https://bun.sh/install | bash
  BUN="$HOME/.bun/bin/bun"
fi
[ -x "$BUN" ] || die "Bun 安装失败"
echo "bun $("$BUN" --version)"

# ---------- 3. Agent 代码 ----------
step "获取 Agent 代码"
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/../src/index.ts" ]; then
  SRC_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
  if [ "$SRC_ROOT" != "$APP_DIR" ]; then
    mkdir -p "$APP_DIR"
    rm -rf "$APP_DIR/qq-agent.new" && mkdir -p "$APP_DIR/qq-agent.new"
    (cd "$SRC_ROOT/qq-agent" && tar --exclude=node_modules -cf - .) | tar -xf - -C "$APP_DIR/qq-agent.new"
    rm -rf "$APP_DIR/qq-agent" && mv "$APP_DIR/qq-agent.new" "$APP_DIR/qq-agent"
  fi
  echo "使用本地代码: $SRC_ROOT"
else
  if [ -d "$APP_DIR/repo/.git" ]; then
    git -C "$APP_DIR/repo" fetch -q --depth 100 origin "$BRANCH" && git -C "$APP_DIR/repo" reset -q --hard FETCH_HEAD
  else
    rm -rf "$APP_DIR/repo"; mkdir -p "$APP_DIR"
    git clone -q --depth 100 --branch "$BRANCH" "$REPO_URL" "$APP_DIR/repo"
  fi
  rm -rf "$APP_DIR/qq-agent" && cp -r "$APP_DIR/repo/qq-agent" "$APP_DIR/qq-agent"
  echo "已更新到 $(git -C "$APP_DIR/repo" rev-parse --short HEAD)"
fi
[ -f "$APP_DIR/qq-agent/src/index.ts" ] || die "代码目录不完整: $APP_DIR/qq-agent"

# ---------- 4. OpenCode ----------
step "安装 OpenCode"
OC_DIR="$APP_DIR/opencode"
mkdir -p "$OC_DIR"
OPENCODE_BIN="$OC_DIR/node_modules/.bin/opencode"
if [ -x "$OPENCODE_BIN" ] && [ "${QQA_UPDATE_OPENCODE:-0}" != 1 ]; then
  echo "已安装,不升级(要升级请设置 QQA_UPDATE_OPENCODE=1)"
else
  [ -f "$OC_DIR/package.json" ] || echo '{"name":"oc","private":true}' > "$OC_DIR/package.json"
  if command -v npm >/dev/null 2>&1; then
    npm install --prefix "$OC_DIR" --no-audit --no-fund --loglevel=error opencode-ai@latest
  else
    (cd "$OC_DIR" && "$BUN" add opencode-ai@latest)
  fi
fi
[ -x "$OPENCODE_BIN" ] || die "OpenCode 安装失败"
echo "opencode $("$OPENCODE_BIN" --version 2>/dev/null | head -1)"

# ---------- 5. QQ + NapCat ----------
step "安装 QQ 与 NapCat(使用 NapCat 官方安装脚本,免 root 安装到 ~/Napcat)"
if [ -x "$QQ_BIN" ] && [ -f "$HOME/Napcat/opt/QQ/resources/app/app_launcher/napcat/napcat.mjs" ] && [ "${QQA_REINSTALL_NAPCAT:-0}" != 1 ]; then
  echo "已安装,跳过(要重装请设置 QQA_REINSTALL_NAPCAT=1)"
else
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "$NAPCAT_INSTALLER_URL" -o "$TMP/napcat.sh"
  NC_ARGS=(--docker n --cli n --force)
  [ "${QQA_SKIP_DEPS:-0}" = 1 ] && NC_ARGS+=(--skip-deps)
  if ! (cd "$TMP" && TERM="${TERM:-xterm}" bash napcat.sh "${NC_ARGS[@]}"); then
    diagnose_system
    die "NapCat 官方安装脚本失败。看上面的报错;如果是 apt/dpkg 的问题,先手动装好依赖(xvfb xauth libnss3 libgbm1 libgtk-3-0 libasound2 等)再用 QQA_SKIP_DEPS=1 重新运行。日志: $DATA_DIR/logs/install.log"
  fi
fi
[ -x "$QQ_BIN" ] || die "QQ 安装失败: 找不到 $QQ_BIN"
MISSING_LIBS="$(ldd "$QQ_BIN" 2>/dev/null | awk '/not found/ {print $1}' | sort -u | tr '\n' ' ')"
if [ -n "$MISSING_LIBS" ]; then
  warn "QQ 缺少这些系统库,启动会失败: $MISSING_LIBS"
  warn "请安装对应的包(Ubuntu 一般是 libnss3 libgbm1 libgtk-3-0 libasound2 libxss1 libatk-bridge2.0-0 等),装好后运行 qq-agent restart napcat"
fi

# ---------- 6. 配置 ----------
step "写入配置"
DATA_DIR="$DATA_DIR" WORKDIR="$WORKDIR" OPENCODE_BIN="$OPENCODE_BIN" NAPCAT_CONFIG_DIR="$NAPCAT_CONFIG_DIR" \
  "$BUN" run "$APP_DIR/qq-agent/install/setup.ts"
mkdir -p "$WORKDIR"
cat > "$DATA_DIR/install.env" <<ENV
APP_DIR='$APP_DIR'
BUN='$BUN'
OPENCODE_BIN='$OPENCODE_BIN'
QQ_BIN='$QQ_BIN'
WORKDIR='$WORKDIR'
REPO_URL='$REPO_URL'
BRANCH='$BRANCH'
ENV
if [ -d "$APP_DIR/repo/.git" ]; then git -C "$APP_DIR/repo" rev-parse --short HEAD > "$APP_DIR/VERSION"; else echo local > "$APP_DIR/VERSION"; fi
# 按已安装的 NapCat 版本重新生成接口目录,Agent 才知道它真正支持哪些接口
NAPCAT_MJS="$HOME/Napcat/opt/QQ/resources/app/app_launcher/napcat/napcat.mjs"
if [ -f "$NAPCAT_MJS" ]; then
  "$BUN" run "$APP_DIR/qq-agent/scripts/gen-napcat-catalog.ts" "$NAPCAT_MJS" "$DATA_DIR/napcat-catalog.json" || warn "生成接口目录失败,将使用随程序打包的版本"
fi
install -m 0755 "$APP_DIR/qq-agent/install/qq-agent" "$BIN_DIR/qq-agent"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR 不在 PATH 里,新开终端后若找不到 qq-agent 命令,请把它加入 PATH" ;; esac

# ---------- 7. 服务 ----------
step "注册服务"
if systemctl --user show-environment >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  mk_unit() { # 名称 描述 依赖
    cat > "$UNIT_DIR/qq-agent-$1.service" <<UNIT
[Unit]
Description=QQ Agent - $2
${3:+After=$3
Wants=$3}

[Service]
Environment=QQ_AGENT_HOME=$DATA_DIR
Environment=QQ_AGENT_CTL=$BIN_DIR/qq-agent
Environment=PATH=$(dirname "$BUN"):$OC_DIR/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$BIN_DIR/qq-agent run $1
Restart=always
RestartSec=3
StandardOutput=append:$DATA_DIR/logs/$1.log
StandardError=append:$DATA_DIR/logs/$1.log

[Install]
WantedBy=default.target
UNIT
  }
  mk_unit napcat "NapCat (QQ)"
  mk_unit opencode "OpenCode"
  mk_unit agent "Agent" "qq-agent-napcat.service qq-agent-opencode.service"
  systemctl --user daemon-reload
  systemctl --user enable qq-agent-napcat.service qq-agent-opencode.service qq-agent-agent.service >/dev/null 2>&1
  loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "无法开启 linger:退出登录后服务可能停止(可手动执行 sudo loginctl enable-linger $USER)"
  echo "已注册 systemd 用户服务"
else
  warn "没有可用的用户级 systemd,改用简易守护方式(qq-agent 命令管理)。开机自启需要自行配置。"
fi

# ---------- 8. 桌面图标 ----------
step "创建桌面图标"
APPS="$HOME/.local/share/applications"
mkdir -p "$APPS"
cat > "$APPS/qq-agent.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=QQ Agent
Comment=QQ Agent 控制台
Exec=$BIN_DIR/qq-agent open
Icon=utilities-terminal
Terminal=false
Categories=Utility;
DESKTOP
DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
if [ -d "$DESK" ]; then
  cp "$APPS/qq-agent.desktop" "$DESK/qq-agent.desktop" && chmod +x "$DESK/qq-agent.desktop"
  gio set "$DESK/qq-agent.desktop" metadata::trusted true >/dev/null 2>&1 || true
fi

# ---------- 9. 启动 ----------
step "启动服务"
QQ_AGENT_HOME="$DATA_DIR" "$BIN_DIR/qq-agent" restart "${QQA_RESTART:-all}" || warn "部分服务启动失败,用 qq-agent status / qq-agent logs <服务> 查看"
sleep 3
QQ_AGENT_HOME="$DATA_DIR" "$BIN_DIR/qq-agent" status || true

WEBUI_URL="$(jq -r '.napcat.webuiUrl' "$DATA_DIR/config.json")"
CONSOLE_PORT="$(jq -r '.web.port' "$DATA_DIR/config.json")"
cat <<DONE

${c_ok}安装完成。${c_off} 接下来三步:
  1. 扫码登录 QQ 小号:打开  ${WEBUI_URL}
     (也可以在控制台「概览」页点按钮)
  2. 打开控制台  http://127.0.0.1:${CONSOLE_PORT}  (桌面上的「QQ Agent」图标,或运行 qq-agent open)
     在「设置」里填入 DeepSeek API Key,并把你自己的 QQ 号填进「管理员」
  3. 用另一个 QQ 号给小号发消息试试

常用命令: qq-agent status | restart | logs agent | logs napcat | logs opencode
配置文件: $DATA_DIR/config.json  (含密钥,不要提交或分享)
DONE
