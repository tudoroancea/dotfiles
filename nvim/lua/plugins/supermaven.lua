return {
  "supermaven-inc/supermaven-nvim",
  enabled = true,
  config = function()
    require("supermaven-nvim").setup {
      keymaps = {
        accept_suggestion = "<C-l>", -- accept suggestion with <Tab> built
        clear_suggestion = "<C-j>",
        accept_word = "<C-k>",
      },
      -- ignore_filetypes = { cpp = true }, -- ignore filetypes
      color = {
        suggestion_color = "#6571A0",
        cterm = 244,
      },
      log_level = "off", -- set to "off" to disable logging completely
      disable_inline_completion = false, -- disables inline completion for use with cmp
      disable_keymaps = false, -- disables built in keymaps for more manual control
    }
  end,
}
