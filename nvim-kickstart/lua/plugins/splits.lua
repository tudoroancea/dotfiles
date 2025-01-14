return {
  'mrjones2014/smart-splits.nvim',
  lazy = false,
  config = function()
    require('smart-splits').setup()
    vim.keymap.set('n', '<C-h>', require('smart-splits').move_cursor_left)
    vim.keymap.set('n', '<C-j>', require('smart-splits').move_cursor_down)
    vim.keymap.set('n', '<C-k>', require('smart-splits').move_cursor_up)
    vim.keymap.set('n', '<C-l>', require('smart-splits').move_cursor_right)
    vim.keymap.set('n', '<C-\\>', require('smart-splits').move_cursor_previous)
  end,
  -- opts = {},
  -- keys = {
  --   { 'n', '<C-h>', require('smart-splits').move_cursor_left, desc = 'Move to left pane' },
  --   { 'n', '<C-j>', require('smart-splits').move_cursor_down, desc = 'Move to bottom pane' },
  --   { 'n', '<C-k>', require('smart-splits').move_cursor_up, desc = 'Move to top pane' },
  --   { 'n', '<C-l>', require('smart-splits').move_cursor_right, desc = 'Move to right pane' },
  -- },
}
