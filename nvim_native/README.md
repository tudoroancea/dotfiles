# Zero-Plugin Neovim

A minimal, fast Neovim configuration with zero plugins. Built entirely on Neovim 0.11+ native features.

## Features

- **Native LSP** - Lua, TypeScript/JavaScript, Python (`ty` and Ruff), and Oxlint via `vim.lsp.enable()`
- **Fuzzy Find** - `findfunc` with built-in `matchfuzzy()`
- **Live Grep** - ripgrep integration with quickfix list
- **File Tree** - `netrw` with clean keymaps
- **Smart Statusline** - custom statusline with mode, git branch, diagnostics, and filetype
- **Auto Formatting** - Stylua, Ruff, and Oxfmt on save, with LSP fallback
- **Native Linting** - Ruff and Oxlint diagnostics through their language servers

Language server and formatter executables must be available on `$PATH`. Prettier-backed Oxfmt languages such as Markdown require the npm distribution of `oxfmt`.

## Preview
<img width="2285" height="1351" alt="image" src="https://github.com/user-attachments/assets/ae113832-b2b1-441b-8c3a-f6862a38104c" />


## Video

Built live in this video: [youtu.be/otRvw9neQkg](https://youtu.be/otRvw9neQkg)
