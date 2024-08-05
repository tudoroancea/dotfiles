return {
  "melbaldove/llm.nvim",
  dependencies = { "nvim-neotest/nvim-nio" },
  enabled = false,
  config = function()
    require("llm").setup {
      -- How long to wait for the request to start returning data.
      timeout_ms = 10000,
      services = {
        -- Supported services configured by default
        groq = {
          url = "https://api.groq.com/openai/v1/chat/completions",
          model = "llama3-70b-8192",
          api_key_name = "GROQ_API_KEY",
        },
        openai = {
          url = "https://api.openai.com/v1/chat/completions",
          model = "gpt-4o-mini",
          api_key_name = "OPENAI_API_KEY",
        },
        -- anthropic = {
        --     url = "https://api.anthropic.com/v1/messages",
        --     model = "claude-3-5-sonnet-20240620",
        --     api_key_name = "ANTHROPIC_API_KEY",
        -- },

        -- Extra OpenAI-compatible services to add (optional)
        -- other_provider = {
        --   url = "https://example.com/other-provider/v1/chat/completions",
        --   model = "llama3",
        --   api_key_name = "OTHER_PROVIDER_API_KEY",
        -- },
      },
    }

    vim.keymap.set("n", "<leader>m", function() require("llm").create_llm_md() end, { desc = "Create llm.md" })

    -- keybinds for prompting with groq
    vim.keymap.set(
      { "n", "v" },
      "<leader>,",
      function() require("llm").prompt { replace = false, service = "groq" } end,
      { desc = "Prompt with groq" }
    )
    vim.keymap.set(
      "v",
      "<leader>.",
      function() require("llm").prompt { replace = true, service = "groq" } end,
      { desc = "Prompt while replacing with groq" }
    )

    -- keybinds for prompting with openai
    vim.keymap.set(
      { "n", "v" },
      "<leader>g,",
      function() require("llm").prompt { replace = false, service = "openai" } end,
      { desc = "Prompt with openai" }
    )
    vim.keymap.set(
      "v",
      "<leader>g.",
      function() require("llm").prompt { replace = true, service = "openai" } end,
      { desc = "Prompt while replacing with openai" }
    )
    -- Write some poetry

    -- keybinds to support vim motions
    vim.keymap.set(
      "n",
      "g,",
      function() require("llm").prompt_operatorfunc { replace = false, service = "groq" } end,
      { desc = "Prompt with groq" }
    )
    vim.keymap.set(
      "n",
      "g.",
      function() require("llm").prompt_operatorfunc { replace = true, service = "groq" } end,
      { desc = "Prompt while replacing with groq" }
    )
  end,
}
