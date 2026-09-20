# setup

## new macbook

```bash 
# install Command Line Tools (for git)
xcode-select -p || xcode-select --install
git --version

# Install mise and expose it 
curl -fsSL https://mise.run | sh
export PATH="$HOME/.local/bin:$PATH"
mise --version

# configure github credentials
mise use -g gh
mise x gh -- gh auth login --hostname github.com --git-protocol ssh --web
mise x gh -- gh auth setup-git --hostname github.com

# run bootstrap
mise bootstrap --adopt git@github.com:tudoroancea/dotfiles.git --dry-run
mise bootstrap --adopt git@github.com:tudoroancea/dotfiles.git
```

## new remote linux server

```bash
mise bootstrap remote \
  --host user@server \
  --install-mise \
  --adopt git@github.com:tudoroancea/dotfiles.git \
  --update \
  --env linux,... # edit here the exact overlay list
```

# old stuff

## Pi

Pi configuration is owned by the private [`tudoroancea/pi-setup`](https://github.com/tudoroancea/pi-setup) repository, cloned directly as a real `~/.pi` directory. Do not create a `~/.pi` symlink into this dotfiles checkout.

```bash
git clone git@github.com:tudoroancea/pi-setup.git ~/.pi
cd ~/.pi
nub install
nub run check
```

`setup.sh` performs the clone and install when `~/.pi` is absent. Set `PI_SETUP_REPOSITORY_URL` only to override the default SSH URL.

## tmux

```bash
ln -s ~/dotfiles/.tmux.conf ~/.tmux.conf
```

## ghostty

on macOS:
```bash
ln -s ~/dotfiles/ghostty ~/Library/Application\ Support/com.mitchellh.ghostty
```
on Linux:
```bash
ln -s ~/dotfiles/ghostty ~/.config/ghostty
```

## alacritty

```bash
ln -s ~/dotfiles/alacritty ~/.config/alacritty
```

## zed

```bash
ln -s ~/dotfiles/zed ~/.config/zed
```

## nvim

Install `nvim` with either

```bash
sudo apt update && sudo apt install neovim
```

on linux or

```bash
brew install neovim
```

on macOS and then install the config with

```bash
ln -s ~/dotfiles/nvim ~/.config/nvim
```

## vscode

Once you have installed your vscode of choice, you can do the following:

- on Linux:

```bash
ln -s ~/dotfiles/vscode/settings.json ~/.config/Code/User/settings.json
ln -s ~/dotfiles/vscode/keybindings.json ~/.config/Code/User/keybindings.json
```

- on macOS:

```bash
ln -s ~/dotfiles/vscode/settings.json ~/Library/Application\ Support/Code/User/settings.json
ln -s ~/dotfiles/vscode/keybindings.json ~/Library/Application\ Support/Code/User/keybindings.json
```

## lazygit

on macOS:

```shell
ln -s ~/dotfiles/lazygit/config.yml ~/Library/Application\ Support/lazygit/config.yml
```

and on Linux:

```shell
ln -s ~/dotfiles/lazygit/config.yml ~/.config/lazygit/config.yml
```

# SSH configuration on Linux
see the following [tutorial](https://hostman.com/tutorials/how-to-install-and-configure-ssh-on-ubuntu-22-04/)

## Global gitignore

```bash
git config --global core.excludesfile ~/dotfiles/.gitignore
```
