-- Built-in Neovim behavior

-- stylua: ignore start

-- General ====================================================================
vim.g.mapleader = ' '

vim.o.mouse       = 'a'
vim.o.mousescroll = 'ver:25,hor:6'
vim.o.switchbuf   = 'usetab'
vim.o.undofile    = true
vim.o.clipboard   = 'unnamedplus'
vim.o.shada       = "'100,<50,s10,:1000,/100,@100,h"

vim.cmd('filetype plugin indent on')
if vim.fn.exists('syntax_on') ~= 1 then vim.cmd('syntax enable') end

-- UI =========================================================================
vim.o.breakindent    = true
vim.o.breakindentopt = 'list:-1'
vim.o.colorcolumn    = '+1'
vim.o.cursorline     = true
vim.o.linebreak      = true
vim.o.list           = false
vim.o.number         = true
vim.o.relativenumber = true
vim.o.pumheight      = 10
vim.o.ruler          = false
vim.o.shortmess      = 'CFOSWaco'
vim.o.showmode       = false
vim.o.signcolumn     = 'yes'
vim.o.splitbelow     = true
vim.o.splitkeep      = 'screen'
vim.o.splitright     = true
vim.o.winborder      = 'single'
vim.o.wrap           = false
vim.o.cursorlineopt  = 'screenline,number'
vim.o.fillchars      = 'eob: ,fold:╌'

-- Folds
vim.o.foldlevel   = 10
vim.o.foldmethod  = 'indent'
vim.o.foldnestmax = 10
vim.o.foldtext    = ''

-- Editing ====================================================================
vim.o.autoindent    = true
vim.o.expandtab     = true
vim.o.formatoptions = 'rqnl1j'
vim.o.ignorecase    = true
vim.o.incsearch     = true
vim.o.infercase     = true
vim.o.shiftwidth    = 2
vim.o.smartcase     = true
vim.o.smartindent   = true
vim.o.spelloptions  = 'camel'
vim.o.tabstop       = 2
vim.o.virtualedit   = 'block'
vim.o.iskeyword     = '@,48-57,_,192-255,-'

vim.o.formatlistpat = [[^\s*[0-9\-\+\*]\+[\.\)]*\s\+]]

-- Built-in completion
vim.o.complete    = '.,w,b,kspell'
vim.o.completeopt = 'menuone,noselect,fuzzy,nosort'

-- Autocommands ===============================================================

-- Don't auto-wrap comments and don't insert comment leader after hitting 'o'
local f = function() vim.cmd('setlocal formatoptions-=c formatoptions-=o') end
_G.Config.new_autocmd('FileType', nil, f, "Proper 'formatoptions'")

-- Restore cursor position on file open
vim.api.nvim_create_autocmd('BufReadPost', {
  group = vim.api.nvim_create_augroup('restore-cursor', {}),
  callback = function()
    local mark = vim.api.nvim_buf_get_mark(0, '"')
    if mark[1] > 0 and mark[1] <= vim.api.nvim_buf_line_count(0) then
      pcall(vim.api.nvim_win_set_cursor, 0, mark)
    end
  end,
})

-- Auto root: set cwd based on .git or Makefile
vim.api.nvim_create_autocmd('BufReadPost', {
  group = vim.api.nvim_create_augroup('auto-root', {}),
  callback = function()
    local root = vim.fs.root(0, { '.git', 'Makefile' })
    if root then vim.fn.chdir(root) end
  end,
})

-- Treesitter (builtin) =======================================================
-- Automatically start treesitter highlighting when a parser is available
vim.api.nvim_create_autocmd('FileType', {
  group = vim.api.nvim_create_augroup('treesitter-start', {}),
  callback = function(ev)
    pcall(vim.treesitter.start, ev.buf)
  end,
})

-- LSP (builtin) ==============================================================
-- Configure servers in after/lsp/*.lua, then enable them here.
-- Uncomment and add your servers:
-- vim.lsp.enable({ 'lua_ls' })

-- Enable LSP completion on attach
vim.api.nvim_create_autocmd('LspAttach', {
  group = vim.api.nvim_create_augroup('lsp-completion', {}),
  callback = function(ev)
    vim.lsp.completion.enable(true, ev.data.client_id, ev.buf, { autotrigger = true })
  end,
})

-- Diagnostics ================================================================
local diagnostic_opts = {
  signs = { priority = 9999, severity = { min = 'WARN', max = 'ERROR' } },
  underline = { severity = { min = 'HINT', max = 'ERROR' } },
  virtual_lines = false,
  virtual_text = {
    current_line = true,
    severity = { min = 'ERROR', max = 'ERROR' },
  },
  update_in_insert = false,
}
vim.diagnostic.config(diagnostic_opts)
-- stylua: ignore end
