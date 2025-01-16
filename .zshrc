# load zsh profiler
# zmodload zsh/zprof

# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# Only check for new completion files once per day
autoload -Uz compinit
if [ $(date +'%j') != $(stat -f '%Sm' -t '%j' ~/.zcompdump 2>/dev/null) ]; then
  compinit
else
  compinit -C
fi

# set locale
export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

# source cargo installation (for uv)
. "$HOME/.local/bin/env"

# general functions and aliases ====================================================
alias reloadzsh="source ~/.zshrc"
alias ll="ls -la"
alias l="ls -lah"
alias cdt="cd ~/tmp"
cl() {
  cd "$1" && l
}
mcd() {
  mkdir -p "$1"
  cd "$1"
}
waw() {
  echo "  where :"
  where "$1"
  echo "  which :"
  which "$1"
  echo " version :"
  $(which "$1") --version
}
alias rmr="rm -r"
alias rmrf="rm -rf"
alias py="python3"
alias pdb="python3 -m pdb"
alias lg=lazygit
alias c='code'
alias z='zed'
alias nv=nvim
alias v=nvim
alias va='NVIM_APPNAME=nvim-astronvim nvim'
alias vk='NVIM_APPNAME=nvim-kickstart nvim'
alias vs='NVIM_APPNAME=nvim-from-scratch nvim'
vv() {
  # Assumes all configs exist in directories named ~/.config/nvim-*
  local config=$(fd --max-depth 1 --glob 'nvim*' ~/.config | fzf --prompt="Neovim Configs > " --height=~50% --layout=reverse --border --exit-0)

  # If I exit fzf without selecting a config, don't open Neovim
  [[ -z $config ]] && echo "No config selected" && return

  # Open Neovim with the selected config
  NVIM_APPNAME=$(basename $config) nvim $@
}
ccopy() {
    cat "$1" | pbcopy
}
alias dotf="cd ~/dotfiles && nvim"
alias fda='fd -u'
alias sizes='du -h -d 1 .'
submodule_rm() {
  git submodule deinit -f -- "$1"
  git rm -f "$1"
  rm -rf .git/modules/"$1"
}

# mamba aliases
alias ma=mamba
alias mact='mamba activate'
alias mde='mamba deactivate'
alias mls='mamba list'
alias mels='mamba env list'
alias mcen='mamba create -n'
alias mup='mamba update'
alias min='mamba install'
alias miny='mamba install -y'
alias mind='mamba install -d'
alias up='uv pip'

# function to create a light and dark wallpaper for macOS
ldwallpaper() {
	if [ $# -lt 3 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
		echo "Creates a light and dark wallpaper for macOS."
		echo "Usage: ldwallpaper [-h] [--help] light_image dark_image out_heic"
		echo ""
		return 129
	fi
	command -v "exiv2" >/dev/null 2>&1 || { echo "exiv2 is not installed." >&2; return 1; }
	command -v "heif-enc" >/dev/null 2>&1 || { echo "libheif is not installed." >&2; return 1; }
	test -s "$1" || { echo "Light image does not exist." >&2; return 1; }
	test -s "$2" || { echo "Dark image does not exist." >&2; return 1; }
	test ! -e "$3" || { echo "Output image already exists." >&2; return 1; }
	f="$(basename "$1")"; n="${f%.*}"; e="${f##*.}"
	tmp="$(mktemp -d)"
	cp "$1" "$tmp/$f"
	cat << EOF > "$tmp/$n.xmp"
<?xpacket?>
<x:xmpmeta xmlns:x="adobe:ns:meta">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns">
<rdf:Description xmlns:apple_desktop="http://ns.apple.com/namespace/1.0"
apple_desktop:apr=
"YnBsaXN0MDDSAQMCBFFsEAFRZBAACA0TEQ/REMOVE/8BAQAAAAAAAAAFAAAAAAAAAAAAAAAAAAAAFQ=="/>
</rdf:RDF>
</x:xmpmeta>
EOF
	exiv2 -i X in "$tmp/$f"
	{ test "$e" = "png" && heif-enc -L "$tmp/$f" "$2" -o "$3"; } || heif-enc "$tmp/$f" "$2" -o "$3"
	rm -r "$tmp"
}

# project specific aliases and configurations ===============================================

# export BRAINS_ROOT_DIR="$HOME/brains"
# export BRAINS_EXTERNAL_ROOT_DIR="$HOME/brains_external"
# source $BRAINS_ROOT_DIR/aliases.sh
# source $BRAINS_EXTERNAL_ROOT_DIR/aliases.sh
# export FSDS="$HOME/Formula-Student-Driverless-Simulator"

alias brains2='cd ~/Developer/brains2 && mamba activate brains2 && . install/setup.sh'
alias purge="./scripts/purge.sh"
alias build="./scripts/build.sh"
# alias test="./scripts/test.sh"
alias env_update="./scripts/env_update.sh"

tmux_pymanopt() {
  SESSION="pymanopt"
  SESSIONEXISTS=$(tmux list-sessions | grep $SESSION)
  # Only create tmux SESSION if it doesn't already exist
  if [ "$SESSIONEXISTS" = "" ]
  then
      tmux new-session -d -s $SESSION

      tmux rename-window -t 0 'nv'
      tmux send-keys -t 'nv' 'cd ~/Developer/pymanopt; nvim' C-m ' H' C-m

      tmux new-window -t $SESSION:1 -n 'term'
      tmux send-keys -t 'term' 'cd ~/Developer/pymanopt; source .venv/bin/activate' C-m

      tmux new-window -t $SESSION:2 -n 'btop'
      tmux send-keys -t 'btop' 'btop' C-m
  fi

  tmux attach-session -t $SESSION:0
}


# homebrew config =====================================================-==============
eval "$(/opt/homebrew/bin/brew shellenv)"
if type brew &>/dev/null
then
  FPATH="/opt/homebrew/share/zsh/site-functions:${FPATH}"
  autoload -Uz compinit
  compinit
fi
export PATH=/opt/homebrew:$PATH

# openssl (idk why we need it but I wouldn't remove it just in case sth breaks)
export OPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl@3

# >>> conda initialize >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
# !! Contents within this block are managed by 'conda init' !!
__conda_setup="$('/Users/tudoroancea/miniforge3/bin/conda' 'shell.zsh' 'hook' 2> /dev/null)"
if [ $? -eq 0 ]; then
    eval "$__conda_setup"
else
    if [ -f "/Users/tudoroancea/miniforge3/etc/profile.d/conda.sh" ]; then
        . "/Users/tudoroancea/miniforge3/etc/profile.d/conda.sh"
    else
        export PATH="/Users/tudoroancea/miniforge3/bin:$PATH"
    fi
fi
unset __conda_setup

if [ -f "/Users/tudoroancea/miniforge3/etc/profile.d/mamba.sh" ]; then
    . "/Users/tudoroancea/miniforge3/etc/profile.d/mamba.sh"
fi
# <<< conda initialize <<<

# general tools configuration =====================================================

# uv configuration
eval "$(uv generate-shell-completion zsh)"
export UV_PYTHON_PREFERENCE=only-managed
export UV_PYTHON=3.12


# bun completions
[ -s "/Users/tudoroancea/.bun/_bun" ] && source "/Users/tudoroancea/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# fzf 
source <(fzf --zsh)

# API keys for OpenAI and Anthropic 
. "$HOME/api_keys.sh"

# (oh my) zsh customization ==========================================================
export EDITOR="nvim"
export ZSH="/Users/tudoroancea/.oh-my-zsh"
ENABLE_CORRECTION="false"
COMPLETION_WAITING_DOTS="true"
VSCODE=code # vscode flavor used by oh my zsh plugin
export PYTHON_VENV_NAME=".venv" # customize the default venv name used by vrun

# 0, 1 - Blinking block
# 2 - Solid block
# 3 - Blinking underline
# 4 - Solid underline
# 5 - Blinking line
# 6 - Solid line
VI_MODE_SET_CURSOR=true
VI_MODE_CURSOR_NORMAL=1
VI_MODE_CURSOR_VISUAL=1
VI_MODE_CURSOR_INSERT=5
VI_MODE_CURSOR_OPPEND=0
MODE_INDICATOR="%F{white}+%f"
INSERT_MODE_INDICATOR="%F{yellow}+%f"
ZSH_THEME="powerlevel10k/powerlevel10k"
# oh my zsh plugins
plugins=(
  git  # for gst, gc, etc.
  brew  # for bubu, etc.
  vscode  # for vsc, vscd, etc.
  python
  tmux
  zsh-interactive-cd
  zsh-autosuggestions
  zsh-syntax-highlighting
  zsh-fzf-history-search
)
source $ZSH/oh-my-zsh.sh

# starship prompt
# eval "$(starship init zsh)"

# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# run zsh profiling
# zprof
