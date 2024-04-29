# setup
You can clone this repo with 
```bash
git clone https://github.com/tudoroancea/dotfiles ~/dotfiles
```
and then follow the following steps to install the different components:

## zsh
```bash
ln -s ~/dotfiles/.zshrc ~/.zshrc
```

## tmux
```bash
ln -s ~/dotfiles/.tmux.conf ~/.tmux.conf
```

## nvim
```bash
ln -s ~/dotfiles/nvim ~/.config/nvim
```

## vscode
On Linux:
```bash
ln -s ~/dotfiles/vscode/settings.json ~/.config/Code/User/settings.json
ln -s ~/dotfiles/vscode/keybindings.json ~/.config/Code/User/keybindings.json
```

On macOS:
```bash
ln -s ~/dotfiles/vscode/settings.json ~/Library/Application\ Support/Code/User/settings.json
ln -s ~/dotfiles/vscode/keybindings.json ~/Library/Application\ Support/Code/User/keybindings.json
```
