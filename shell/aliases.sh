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
ccopy() {
    cat "$1" | pbcopy
}
alias dotf="cd ~/dotfiles && nvim"
alias zrc="cd ~/dotfiles && nvim .zshrc"
alias fda='fd -u'
alias sizes='du -h -d 1 .'
submodule_rm() {
  git submodule deinit -f -- "$1"
  git rm -f "$1"
  rm -rf .git/modules/"$1"
}
alias oc="opencode"

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

# other python aliases
alias upip='uv pip'
alias py='python'
alias urun='uv run'
alias upy='uv run python'
alias updb='uv run python -m pdb'
alias uscript='uv run --script'

create_worktree() {
    local new_branch="$1"
    local base_branch="${2:-$(git config --get init.defaultBranch || echo main)}"

    # Validate inputs
    if [ -z "$new_branch" ]; then
        echo "Usage: create_worktree <new_branch> [base_branch]" >&2
        return 1
    fi

    # Check if base branch exists (local or remote)
    if ! git show-ref --verify --quiet "refs/heads/$base_branch" && \
       ! git show-ref --verify --quiet "refs/remotes/origin/$base_branch"; then
        echo "Error: Base branch '$base_branch' does not exist" >&2
        return 1
    fi

    # Check if worktree path already exists
    if [ -d ".worktrees/$new_branch" ]; then
        echo "Error: Worktree path '.worktrees/$new_branch' already exists" >&2
        return 1
    fi

    # Create worktree with new branch based on base branch
    git worktree add ".worktrees/$new_branch" -b "$new_branch" "$base_branch"
}
pi-usage() {
   local days="${1:-1}"
   local since
   since="$(date -v-"$days"d +%Y-%m-%d)"
   ccusage-pi daily --since "$since"
 }
alias pirc="cd ~/.pi && pi --provider opencode-go --model minimax-m2.5 --thinking medium"
