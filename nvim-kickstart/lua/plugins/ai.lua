---@type LazySpec
return {
  {
    'yetone/avante.nvim',
    event = 'VeryLazy',
    enabled = true,
    lazy = true,
    version = '*',
    opts = {
      provider = 'claude',
      system_prompt = 'You are a helpful assistant programmer with extensive knowledge in all languages and frameworks. You will answer questions to the point with as much code as possible and only the required explanations.',
      claude = {
        model = 'claude-3-5-sonnet-latest',
      },
      openai = {
        model = 'gpt-4o',
      },
      mappings = {
        submit = {
          insert = '<C-CR>',
        },
      },
    },
    keys = {
      -- { "<leader>a", desc = "avante" },
    },
    -- if you want to build from source then do `make BUILD_FROM_SOURCE=true`
    build = 'make',
    -- build = "powershell -ExecutionPolicy Bypass -File Build.ps1 -BuildFromSource false" -- for windows
    dependencies = {
      'stevearc/dressing.nvim',
      'nvim-lua/plenary.nvim',
      'MunifTanjim/nui.nvim',
      --- The below dependencies are optional,
      'nvim-tree/nvim-web-devicons', -- or echasnovski/mini.icons
      {
        -- Make sure to set this up properly if you have lazy=true
        'MeanderingProgrammer/render-markdown.nvim',
        opts = {
          file_types = { 'markdown', 'Avante' },
        },
        ft = { 'markdown', 'Avante' },
      },
    },
  },
  {
    'supermaven-inc/supermaven-nvim',
    enabled = true,
    version = '*',
    opts = {
      keymaps = {
        accept_suggestion = '<C-l>',
        clear_suggestion = '<C-h>',
        accept_word = '<C-;>',
      },
      color = {
        suggestion_color = '#6571A0',
        cterm = 244,
      },
      log_level = 'off', -- set to "off" to disable logging completely
      disable_inline_completion = false, -- disables inline completion for use with cmp
      disable_keymaps = false, -- disables built in keymaps for more manual control
    },
  },
}
