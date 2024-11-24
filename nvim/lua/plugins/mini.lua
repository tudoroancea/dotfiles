---@type LazySpec
return {
  "echasnovski/mini.nvim",
  version = "*",
  enabled = false,
  config = function()
    require("mini.ai").setup { n_lines = 500 }
    require("mini.surround").setup()
    require("mini.pairs").setup()
    -- require("mini.tabline").setup { set_vim_settings = false }
    local statusline = require "mini.statusline"
    statusline.setup {
      use_icons = vim.g.have_nerd_font,
    }
    ---@diagnostic disable-next-line: duplicate-set-field
    statusline.section_location = function() return "%2l:%-2v" end
  end,
}
