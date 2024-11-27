---@class LazySpec
return {
  { -- Automatically add closing quotes, parenthesis, brackets, etc.
    'windwp/nvim-autopairs',
    event = 'InsertEnter',
    -- Optional dependency
    dependencies = { 'hrsh7th/nvim-cmp' },
    config = function()
      local autopairs = require 'nvim-autopairs'
      autopairs.setup {
        check_ts = true,
        ts_config = { java = false },
        fast_wrap = {
          map = '<M-e>',
          chars = { '{', '[', '(', '"', "'" },
          pattern = ([[ [%'%"%)%>%]%)%}%,] ]]):gsub('%s+', ''),
          offset = 0,
          end_key = '$',
          keys = 'qwertyuiopzxcvbnmasdfghjkl',
          check_comma = true,
          highlight = 'PmenuSel',
          highlight_grey = 'LineNr',
        },
      }
      -- If you want to automatically add `(` after selecting a function or method
      local cmp_autopairs = require 'nvim-autopairs.completion.cmp'
      local cmp = require 'cmp'
      cmp.event:on('confirm_done', cmp_autopairs.on_confirm_done())
      -- add more custom autopairs configuration such as custom rules
      local Rule = require 'nvim-autopairs.rule'
      local cond = require 'nvim-autopairs.conds'
      autopairs.add_rules(
        {
          Rule('$', '$', { 'tex', 'latex', 'typ', 'typst', 'markdown' })
            -- don't add a pair if the next character is %
            :with_pair(cond.not_after_regex '%%')
            -- don't add a pair if  the previous character is xxx
            :with_pair(cond.not_before_regex('xxx', 3))
            -- don't move right when repeat character
            :with_move(cond.none())
            -- don't delete if the next character is xx
            :with_del(cond.not_after_regex 'xx')
            -- disable adding a newline when you press <cr>
            :with_cr(cond.none()),
        },
        -- disable for .vim files, but it work for another filetypes
        Rule('a', 'a', '-vim')
      )
    end,
  },
  -- Detect tabstop and shiftwidth automatically
  'tpope/vim-sleuth',
  -- Collection of various small independent plugins/modules
  { 'echasnovski/mini.nvim', lazy = false },
  { 'echasnovski/mini.ai', lazy = false, opts = { n_lines = 500 } },
  { 'echasnovski/mini.surround', lazy = false },
  { 'echasnovski/mini.pairs', lazy = false },
  { 'echasnovski/mini.comment', lazy = false },
  { 'echasnovski/mini.bufremove', lazy = false },
  { -- Autoformat
    'stevearc/conform.nvim',
    event = { 'BufWritePre' },
    cmd = { 'ConformInfo' },
    keys = {
      {
        '<leader>lf',
        function()
          require('conform').format { async = true, lsp_format = 'fallback' }
        end,
        mode = '',
        desc = '[F]ormat buffer',
      },
    },
    opts = {
      notify_on_error = false,
      format_on_save = function(bufnr)
        -- Disable "format_on_save lsp_fallback" for languages that don't
        -- have a well standardized coding style. You can add additional
        -- languages here or re-enable it for the disabled ones.
        local disable_filetypes = { c = true, cpp = true }
        local lsp_format_opt
        if disable_filetypes[vim.bo[bufnr].filetype] then
          lsp_format_opt = 'never'
        else
          lsp_format_opt = 'fallback'
        end
        return {
          timeout_ms = 500,
          lsp_format = lsp_format_opt,
        }
      end,
      formatters_by_ft = {
        lua = { 'stylua' },
        python = { 'ruff_format', 'ruff_organize_imports' },
        cpp = { 'clang_format' },
        -- markdown = { 'prettier' },
      },
    },
  },
  { -- Autocompletion
    'hrsh7th/nvim-cmp',
    event = 'InsertEnter',
    dependencies = {
      -- Adds other completion capabilities.
      --  nvim-cmp does not ship with all sources by default. They are split
      --  into multiple repos for maintenance purposes.
      'hrsh7th/cmp-nvim-lsp',
      'hrsh7th/cmp-path',
    },
    config = function()
      -- See `:help cmp`
      local cmp = require 'cmp'

      cmp.setup {
        completion = { completeopt = 'menu,menuone,noinsert' },

        -- For an understanding of why these mappings were
        -- chosen, you will need to read `:help ins-completion`
        --
        -- No, but seriously. Please read `:help ins-completion`, it is really good!
        mapping = cmp.mapping.preset.insert {
          -- Select the [n]ext item
          ['<C-j>'] = cmp.mapping.select_next_item(),
          -- Select the [p]revious item
          ['<C-k>'] = cmp.mapping.select_prev_item(),

          -- Scroll the documentation window [b]ack / [f]orward
          ['<C-b>'] = cmp.mapping.scroll_docs(-4),
          ['<C-f>'] = cmp.mapping.scroll_docs(4),

          -- Accept ([y]es) the completion.
          --  This will auto-import if your LSP supports it.
          --  This will expand snippets if the LSP sent a snippet.
          ['<C-y>'] = cmp.mapping.confirm { select = true },

          -- If you prefer more traditional completion keymaps,
          -- you can uncomment the following lines
          --['<CR>'] = cmp.mapping.confirm { select = true },
          --['<Tab>'] = cmp.mapping.select_next_item(),
          --['<S-Tab>'] = cmp.mapping.select_prev_item(),

          -- Manually trigger a completion from nvim-cmp.
          --  Generally you don't need this, because nvim-cmp will display
          --  completions whenever it has completion options available.
          ['<C-Space>'] = cmp.mapping.complete {},
        },
        sources = {
          {
            name = 'lazydev',
            -- set group index to 0 to skip loading LuaLS completions as lazydev recommends it
            group_index = 0,
          },
          { name = 'nvim_lsp' },
          { name = 'path' },
          -- { name = 'supermaven' },
        },
      }
    end,
  },
}
