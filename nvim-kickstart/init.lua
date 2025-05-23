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

-- TIP: Disable arrow keys in normal mode
vim.keymap.set('n', '<left>', '<cmd>echo "Use h to move!!"<CR>')
vim.keymap.set('n', '<right>', '<cmd>echo "Use l to move!!"<CR>')
vim.keymap.set('n', '<up>', '<cmd>echo "Use k to move!!"<CR>')
vim.keymap.set('n', '<down>', '<cmd>echo "Use j to move!!"<CR>')

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

-- [[ Install `lazy.nvim` plugin manager ]]
--    See `:help lazy.nvim.txt` or https://github.com/folke/lazy.nvim for more info
local lazypath = vim.fn.stdpath 'data' .. '/lazy/lazy.nvim'
if not (vim.uv or vim.loop).fs_stat(lazypath) then
  local lazyrepo = 'https://github.com/folke/lazy.nvim.git'
  local out = vim.fn.system { 'git', 'clone', '--filter=blob:none', '--branch=stable', lazyrepo, lazypath }
  if vim.v.shell_error ~= 0 then
    error('Error cloning lazy.nvim:\n' .. out)
  end
end
---@diagnostic disable-next-line: undefined-field
vim.opt.rtp:prepend(lazypath)

-- [[ Configure and install plugins ]]
require('lazy').setup({
  { import = 'plugins' },
}, {
  ui = {
    -- If you are using a Nerd Font: set icons to an empty table which will use the
    -- default lazy.nvim defined Nerd Font icons, otherwise define a unicode icons table
    icons = vim.g.have_nerd_font and {} or {
      cmd = '⌘',
      config = '🛠',
      event = '📅',
      ft = '📂',
      init = '⚙',
      keys = '🗝',
      plugin = '🔌',
      runtime = '💻',
      require = '🌙',
      source = '📄',
      start = '🚀',
      task = '📌',
      lazy = '💤 ',
    },
  },
})

-- Lazy keymaps
vim.keymap.set('n', '<leader>ps', ':Lazy<cr>', { desc = 'Lazy status', silent = true })
vim.keymap.set('n', '<leader>pS', ':Lazy sync<cr>', { desc = 'Lazy sync', silent = true })
vim.keymap.set('n', '<leader>pu', ':Lazy update<cr>', { desc = 'Lazy update', silent = true })
vim.keymap.set('n', '<leader>pi', ':Lazy install<cr>', { desc = 'Lazy install', silent = true })
vim.keymap.set('n', '<leader>pm', ':Mason<cr>', { desc = 'Mason', silent = true })

-- Close buffer
vim.keymap.set('n', '<leader>c', ':BufferClose<cr>', { desc = '[C]lose buffer', silent = true })
vim.keymap.set('n', '<leader>bc', ':BufferClose<cr>', { desc = '[C]lose buffer', silent = true })
vim.keymap.set('n', '<leader>bC', ':BufferCloseAllButCurrent<cr>', { desc = '[C]lose all but current buffer', silent = true })
