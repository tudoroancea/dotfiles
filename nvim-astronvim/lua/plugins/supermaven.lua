return {
  "supermaven-inc/supermaven-nvim",
  enabled = true,
  version = "*",
  config = function()
    require("supermaven-nvim").setup {
      keymaps = {
        accept_suggestion = "<C-l>", -- accept suggestion with <Tab> built
        clear_suggestion = "<C-h>",
        accept_word = "<C-;>",
      },
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
