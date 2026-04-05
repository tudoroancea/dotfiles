-- Set <space> as the leader key
-- See `:help mapleader`
--  NOTE: Must happen before plugins are loaded (otherwise wrong leader will be used)
vim.g.mapleader = ' '
vim.g.maplocalleader = ' '

-- Set to true if you have a Nerd Font installed and selected in the terminal
vim.g.have_nerd_font = true

-- Make line numbers default
vim.opt.number = true
-- You can also add relative line numbers, to help with jumping.
--  Experiment for yourself to see if you like it!
vim.opt.relativenumber = true
-- Do not wrap lines
vim.opt.wrap = false

-- Enable mouse mode, can be useful for resizing splits for example!
vim.opt.mouse = 'a'

-- Don't show the mode, since it's already in the status line
vim.opt.showmode = false

-- Sync clipboard between OS and Neovim.
--  Schedule the setting after `UiEnter` because it can increase startup-time.
--  Remove this option if you want your OS clipboard to remain independent.
--  See `:help 'clipboard'`
vim.schedule(function()
  vim.opt.clipboard = 'unnamedplus'
end)

-- Enable break indent
vim.opt.breakindent = false
vim.opt.autoindent = true
vim.opt.smartindent = true

-- Save undo history
vim.opt.undofile = true

-- Case-insensitive searching UNLESS \C or one or more capital letters in the search term
vim.opt.ignorecase = true
vim.opt.smartcase = true

-- Keep signcolumn on by default
vim.opt.signcolumn = 'yes'

-- Decrease update time
vim.opt.updatetime = 250

-- Decrease mapped sequence wait time
-- Displays which-key popup sooner
vim.opt.timeoutlen = 300

-- Configure how new splits should be opened
vim.opt.splitright = true
vim.opt.splitbelow = true

-- Sets how neovim will display certain whitespace characters in the editor.
--  See `:help 'list'`
--  and `:help 'listchars'`
vim.opt.list = true
vim.opt.listchars = { tab = '» ', trail = '·', nbsp = '␣' }

-- Preview substitutions live, as you type!
vim.opt.inccommand = 'split'

-- Show which line your cursor is on
vim.opt.cursorline = true

-- Minimal number of screen lines to keep above and below the cursor.
vim.opt.scrolloff = 1

-- [[ Basic Keymaps ]]
--  See `:help vim.keymap.set()`

-- Clear highlights on search when pressing <Esc> in normal mode
--  See `:help hlsearch`
vim.keymap.set('n', '<Esc>', '<cmd>nohlsearch<CR>')

-- Save and quit
vim.keymap.set('n', '<leader>w', ':w<cr>', { desc = 'Save file', silent = true })
vim.keymap.set('n', '<leader>q', ':confirm q<cr>', { desc = 'Quit window', silent = true })
vim.keymap.set('n', '<leader>Q', ':confirm qall<cr>', { desc = 'Quit Nvim', silent = true })

-- Diagnostic keymaps
-- vim.keymap.set('n', '<leader>q', vim.diagnostic.setloclist, { desc = 'Open diagnostic [Q]uickfix list' })

-- Exit terminal mode in the builtin terminal with a shortcut that is a bit easier
-- for people to discover. Otherwise, you normally need to press <C-\><C-n>, which
-- is not what someone will guess without a bit more experience.
--
-- NOTE: This won't work in all terminal emulators/tmux/etc. Try your own mapping
-- or just use <C-\><C-n> to exit terminal mode
vim.keymap.set('t', '<Esc><Esc>', '<C-\\><C-n>', { desc = 'Exit terminal mode' })
-- Move between tabs
vim.keymap.set('n', '<A-h>', ':BufferPrevious<cr>', { desc = 'Previous buffer', silent = true })
vim.keymap.set('n', '<D-h>', ':BufferPrevious<cr>', { desc = 'Previous buffer', silent = true })
vim.keymap.set('n', '<A-l>', ':BufferNext<cr>', { desc = 'Next buffer', silent = true })
vim.keymap.set('n', '<D-l>', ':BufferNext<cr>', { desc = 'Next buffer', silent = true })

-- Go to first occurence of paranthesis, bracket, brace, etc.
vim.keymap.set('n', 'g(', '0t(', { desc = '[G]o to first [(]' })
vim.keymap.set('n', 'g[', '0t[', { desc = '[G]o to first [[]' })
vim.keymap.set('n', 'g{', '0t{', { desc = '[G]o to first [{]' })
vim.keymap.set('n', 'ga', '0%%h', { desc = '[G]o to first [{([]' })

-- Comments
vim.keymap.set('n', '<leader>/', 'gcc', { remap = true, desc = '[C]omment line' })
vim.keymap.set('x', '<leader>/', 'gc', { remap = true, desc = '[C]omment' })

-- [[ Basic Autocommands ]]
--  See `:help lua-guide-autocommands`

-- Highlight when yanking (copying) text
--  Try it with `yap` in normal mode
--  See `:help vim.highlight.on_yank()`
vim.api.nvim_create_autocmd('TextYankPost', {
  desc = 'Highlight when yanking (copying) text',
  group = vim.api.nvim_create_augroup('kickstart-highlight-yank', { clear = true }),
  callback = function()
    vim.highlight.on_yank()
  end,
})
-- Always open help window on the right
vim.api.nvim_create_autocmd('BufWinEnter', {
  group = vim.api.nvim_create_augroup('help_window_right', {}),
  pattern = { '*.txt' },
  callback = function()
    if vim.o.filetype == 'help' then
      vim.cmd.wincmd 'L'
    end
  end,
})
-- Set commentstring for typst files
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'typst',
  callback = function()
    vim.bo.commentstring = '// %s'
  end,
})

local pack_dir = vim.fn.stdpath('data') .. '/site/pack/vendor/opt'
local function ensure_plugin(repo)
  local name = repo:match(".*/(.*)")
  local dir = pack_dir .. '/' .. name
  if vim.fn.isdirectory(dir) == 0 then
    print("Installing " .. repo .. "...")
    vim.fn.system({ 'git', 'clone', '--depth=1', 'https://github.com/' .. repo .. '.git', dir })
  end
  vim.cmd('packadd! ' .. name)
end

local plugins = {
  'rose-pine/neovim',
  'echasnovski/mini.nvim',
  'nvim-lua/plenary.nvim',
  'folke/which-key.nvim',
  'folke/snacks.nvim',
  'nvim-treesitter/nvim-treesitter',
  'nvim-telescope/telescope.nvim',
  'nvim-telescope/telescope-fzf-native.nvim',
  'nvim-telescope/telescope-ui-select.nvim',
  'nvim-tree/nvim-web-devicons',
  'hrsh7th/nvim-cmp',
  'hrsh7th/cmp-nvim-lsp',
  'hrsh7th/cmp-path',
  'saadparwaiz1/cmp_luasnip',
  'L3MON4D3/LuaSnip',
  'folke/lazydev.nvim',
  'Bilal2453/luvit-meta',
  'windwp/nvim-autopairs',
  'tpope/vim-sleuth',
  'folke/todo-comments.nvim',
  'xiyaowong/transparent.nvim',
  'f-person/auto-dark-mode.nvim',
  'MeanderingProgrammer/render-markdown.nvim',
  'MunifTanjim/nui.nvim',
  'stevearc/conform.nvim',
  'kdheepak/lazygit.nvim',
  'romgrk/barbar.nvim',
  'aserowy/tmux.nvim',
  'mrjones2014/smart-splits.nvim',
  'folke/persistence.nvim',
  'folke/noice.nvim',
}

for _, repo in ipairs(plugins) do
  ensure_plugin(repo)
end

local fzf_dir = pack_dir .. '/telescope-fzf-native.nvim'
if vim.fn.isdirectory(fzf_dir) == 1 and vim.fn.executable('make') == 1 and vim.fn.filereadable(fzf_dir .. '/build/libfzf.so') == 0 then
  print("Building telescope-fzf-native...")
  vim.fn.system({ 'make', '-C', fzf_dir })
end

require('plugins.ui')
require('plugins.editor')
require('plugins.treesitter')
require('plugins.telescope')
require('plugins.lsp')
require('plugins.git')
require('plugins.tmux')
require('plugins.session')
require('plugins.splits')
