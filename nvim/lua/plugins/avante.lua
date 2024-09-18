---@type LazySpec
return {
  "yetone/avante.nvim",
  event = "VeryLazy",
  enabled = true,
  lazy = false,
  version = false, -- set this if you want to always pull the latest change
  opts = {
    provider = "openai",
    system_prompt = "You are a helpful assistant programmer with extensive knowledge in all languages and frameworks. You will answer questions to the point with as much code as possible and only the required explanations.",
    openai = {
      endpoint = "https://api.openai.com/v1",
      model = "gpt-4o",
      timeout = 30000, -- Timeout in milliseconds
      temperature = 0,
      max_tokens = 4096,
      ["local"] = false,
    },
    mappings = {
      submit = {
        insert = "<C-CR>",
      },
    },
  },
  -- if you want to build from source then do `make BUILD_FROM_SOURCE=true`
  build = "make",
  -- build = "powershell -ExecutionPolicy Bypass -File Build.ps1 -BuildFromSource false" -- for windows
  dependencies = {
    "stevearc/dressing.nvim",
    "nvim-lua/plenary.nvim",
    "MunifTanjim/nui.nvim",
    --- The below dependencies are optional,
    "nvim-tree/nvim-web-devicons", -- or echasnovski/mini.icons
    {
      -- Make sure to set this up properly if you have lazy=true
      "MeanderingProgrammer/render-markdown.nvim",
      opts = {
        file_types = { "markdown", "Avante" },
      },
      ft = { "markdown", "Avante" },
    },
  },
}
