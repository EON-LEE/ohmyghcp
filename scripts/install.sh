#!/bin/sh
# Installs oh-my-ghcp: oh-my-claudecode (OMC) running on GitHub Copilot CLI (Linux, macOS, WSL).
# Clones the OMC release pinned in upstream.json, verifies its commit, installs OMC's runtime dependencies, builds the
# Copilot plugin with adapter/build-overlay.cjs and installs the copilot-omc and omc commands, all under
# ${COPILOT_HOME:-~/.copilot}/oh-my-ghcp. OMC itself is not modified. Re-running updates the plugin in place and keeps
# OMC state (state/, claude/).
set -eu

usage() {
  cat <<'EOF'
usage: scripts/install.sh [options]
  --omc-ref <tag|branch>    install this OMC ref instead of the pinned release (commit not verified)
  --agent-model <model>     Copilot model id for OMC agent definitions (default: agents use the session model)
  --task-model <model>      pin every OMC subagent (task tool) to this Copilot model id
  --task-model-map <map>    e.g. opus=claude-opus-4.6,sonnet=claude-sonnet-4.6,haiku=gpt-5-mini
  --rebuild-cli             rebuild OMC's CLI bundle (only needed for OMC v5.6.0, which lacks "omc ralph")
  --force                   re-clone OMC and reinstall its dependencies
  --uninstall               remove ${COPILOT_HOME:-~/.copilot}/oh-my-ghcp (including OMC state kept there)
EOF
}

omc_ref= agent_model= task_model= task_model_map= rebuild_cli= force= uninstall=
while [ $# -gt 0 ]; do
  case $1 in
    --omc-ref) omc_ref=${2:?--omc-ref needs a value}; shift 2 ;;
    --agent-model) agent_model=${2:?--agent-model needs a value}; shift 2 ;;
    --task-model) task_model=${2:?--task-model needs a value}; shift 2 ;;
    --task-model-map) task_model_map=${2:?--task-model-map needs a value}; shift 2 ;;
    --rebuild-cli) rebuild_cli=1; shift ;;
    --force) force=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

step() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'oh-my-ghcp: %s\n' "$*" >&2; exit 1; }

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
root=${COPILOT_HOME:-$HOME/.copilot}/oh-my-ghcp
omc_dir=$root/omc
plugin_dir=$root/plugin
bin_dir=$root/bin
verified_copilot=1.0.91

if [ -n "$uninstall" ]; then
  step "removing $root"
  rm -rf -- "$root"
  echo "oh-my-ghcp removed. Copilot CLI and per-project .omc/ directories were left as they are."
  echo "Remove $bin_dir from PATH in your shell profile if you added it."
  exit 0
fi

step 'checking prerequisites'
for cmd in node npm git; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' was not found on PATH"
done
node_version=$(node -p 'process.versions.node')
[ "${node_version%%.*}" -ge 20 ] || die "Node.js 20 or newer is required (found $node_version)"
copilot_version=
if command -v copilot >/dev/null 2>&1; then
  copilot_version=$(copilot --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)
fi
if [ -z "$copilot_version" ]; then
  warn 'GitHub Copilot CLI (copilot) was not found; install it first: npm install -g @github/copilot'
elif ! printf '%s\n%s\n' "$verified_copilot" "$copilot_version" | sort -C -V; then
  warn "Copilot CLI $copilot_version is older than $verified_copilot, the version oh-my-ghcp was verified with; run: copilot update"
fi
echo "    node $node_version, Copilot CLI ${copilot_version:-missing}"

json() { node -e 'const v = require(process.argv[1])[process.argv[2]]; process.stdout.write(v == null ? "" : String(v))' "$1" "$2"; }
ref=$(json "$repo/upstream.json" tag)
want_commit=$(json "$repo/upstream.json" commit)
repository=$(json "$repo/upstream.json" repository)
if [ -n "$omc_ref" ]; then ref=$omc_ref; want_commit=; fi
have_commit=
if [ -d "$omc_dir/.git" ]; then have_commit=$(git -C "$omc_dir" rev-parse HEAD 2>/dev/null || true); fi
fresh=
if [ -n "$force" ] || [ -n "$omc_ref" ] || [ -z "$have_commit" ] || [ "$have_commit" != "$want_commit" ]; then fresh=1; fi

if [ -n "$fresh" ]; then
  if [ -e "$omc_dir" ]; then
    [ -f "$omc_dir/.claude-plugin/plugin.json" ] || die "$omc_dir exists but is not an OMC checkout; move it away and run again"
    step 'removing the previous OMC checkout'
    rm -rf -- "$omc_dir"
  fi
  step "cloning oh-my-claudecode $ref"
  mkdir -p "$root"
  if ! clone_out=$(git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$ref" "$repository" "$omc_dir" 2>&1); then
    printf '%s\n' "$clone_out" >&2
    die "git clone of $repository ($ref) failed"
  fi
  have_commit=$(git -C "$omc_dir" rev-parse HEAD)
  if [ -n "$want_commit" ] && [ "$have_commit" != "$want_commit" ]; then
    rm -rf -- "$omc_dir"
    die "OMC $ref resolved to $have_commit, but upstream.json pins $want_commit; not installing it"
  fi
else
  step "oh-my-claudecode $ref ($(printf '%.12s' "$have_commit")) already installed"
fi

if [ -n "$fresh" ] || [ ! -f "$omc_dir/node_modules/commander/package.json" ]; then
  step 'installing OMC runtime dependencies (npm, production only)'
  if ! (cd "$omc_dir" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error); then
    echo '    npm ci failed; retrying with npm install'
    (cd "$omc_dir" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
  fi
  # Same as OMC's own plugin setup: lifecycle scripts stay off except for this one native module.
  (cd "$omc_dir" && npm rebuild better-sqlite3 --loglevel=error) ||
    warn 'better-sqlite3 was not built; OMC falls back to file locks for its state'
fi

step "building the Copilot plugin in $plugin_dir"
set -- "$repo/adapter/build-overlay.cjs" --omc "$omc_dir" --out "$plugin_dir" --force
[ -z "$agent_model" ] || set -- "$@" --agent-model "$agent_model"
[ -z "$task_model" ] || set -- "$@" --task-model "$task_model"
[ -z "$task_model_map" ] || set -- "$@" --task-model-map "$task_model_map"
if [ -n "$rebuild_cli" ]; then
  esbuild_version=$(node -e 'process.stdout.write((require(process.argv[1]).devDependencies || {}).esbuild || "")' "$omc_dir/package.json")
  [ -n "$esbuild_version" ] || die 'OMC package.json has no esbuild devDependency; --rebuild-cli is not supported for this OMC version'
  npm install --prefix "$root/tools" "esbuild@$esbuild_version" --no-audit --no-fund --loglevel=error
  set -- "$@" --rebuild-cli --esbuild "$root/tools/node_modules/esbuild"
fi
node "$@"

step "installing commands in $bin_dir"
mkdir -p "$bin_dir"
for f in copilot-omc omc; do
  cp "$repo/adapter/$f" "$bin_dir/$f"
  chmod 755 "$bin_dir/$f"
done

step 'smoke test: omc --version'
if omc_version=$("$bin_dir/omc" --version 2>/dev/null); then
  echo "    omc $omc_version"
else
  warn 'omc --version failed; OMC hooks and skills inside Copilot may still work, but the omc CLI does not'
fi
"$bin_dir/omc" ralph --help >/dev/null 2>&1 || warn 'this OMC build has no "omc ralph" command; reinstall with --rebuild-cli'

info_version=$(node -e 'const i = require(process.argv[1]); process.stdout.write(`${i.omc.version}${i.omc.commit ? ` (${i.omc.commit.slice(0, 12)})` : ""}`)' "$plugin_dir/oh-my-ghcp.json")
echo
echo "oh-my-ghcp is ready: oh-my-claudecode $info_version for GitHub Copilot CLI"
case ":$PATH:" in
  *":$bin_dir:"*) launcher=copilot-omc ;;
  *)
    launcher="$bin_dir/copilot-omc"
    echo "  add the commands to PATH (e.g. in ~/.bashrc or ~/.zshrc):  export PATH=\"$bin_dir:\$PATH\""
    ;;
esac
echo "  start Copilot with OMC:  $launcher            (any copilot options work, e.g. --model)"
echo "  one-shot:                $launcher -p \"ralph: make the failing tests pass\" --allow-all"
echo "  without the launcher:    copilot --plugin-dir \"$plugin_dir\""
echo '  in the session, start a prompt with ralph: / autopilot: / ralplan: / deep-interview ... ; stop with cancelomc'
