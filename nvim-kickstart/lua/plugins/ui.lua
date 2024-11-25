---@class LazySpec
return {
  -- { -- You can easily change to a different colorscheme.
  --     -- Change the name of the colorscheme plugin below, and then
  --     -- change the command in the config to whatever the name of that colorscheme is.
  --     --
  --     -- If you want to see what colorschemes are already installed, you can use `:Telescope colorscheme`.
  --     'folke/tokyonight.nvim',
  --     priority = 1000, -- Make sure to load this before all the other start plugins.
  --     init = function()
  --         -- Load the colorscheme here.
  --         -- Like many other themes, this one has different styles, and you could load
  --         -- any other, such as 'tokyonight-storm', 'tokyonight-moon', or 'tokyonight-day'.
  --         vim.cmd.colorscheme 'tokyonight-night'

  --         -- You can configure highlights by doing something like:
  --         vim.cmd.hi 'Comment gui=none'
  --     end,
  -- },
  {
    'rose-pine/neovim',
    name = 'rose-pine',
    priority = 1000,
    lazy = false,
    init = function()
      vim.cmd.colorscheme 'rose-pine'
      -- You can configure highlights by doing something like:
      vim.cmd.hi 'Comment gui=none'
    end,
  },
  { -- Make sure to set this up properly if you have lazy=true
    'MeanderingProgrammer/render-markdown.nvim',
    opts = {
      file_types = { 'markdown' },
    },
    ft = { 'markdown' },
  },
  {
    'nvim-neo-tree/neo-tree.nvim',
    version = '*',
    dependencies = {
      'nvim-lua/plenary.nvim',
      'MunifTanjim/nui.nvim',
      { 'nvim-tree/nvim-web-devicons', enabled = vim.g.have_nerd_font },
    },
    opts = {
      window = {
        mappings = {
          ['\\'] = 'close_window',
        },
      },
      filesystem = {
        filtered_items = {
          visible = true,
          show_hidden_count = true,
          hide_dotfiles = false,
          hide_gitignored = true,
          hide_by_name = {
            '.git',
            '.DS_Store',
          },
          never_show = {},
        },
      },
    },
    keys = {
      { '<leader>e', ':Neotree reveal<cr>', desc = 'NeoTree reveal', silent = true },
      -- { '<leader>o', ':Neotree reveal<cr>', desc = 'NeoTree reveal' },
    },
  },
  {
    'nvim-neo-tree/neo-tree.nvim',
    version = '*',
    dependencies = { 'nvim-lua/plenary.nvim' },
    opts = {
      filesystem = {
        filtered_items = {
          visible = true,
          show_hidden_count = true,
          hide_dotfiles = false,
          hide_gitignored = true,
          hide_by_name = {
            '.git',
            '.DS_Store',
          },
          never_show = {},
        },
      },
    },
    keys = {
      { '<leader>e', '<cmd>Neotree toggle<cr>', desc = 'NeoTree' },
    },
  },
  --- Nice UI elements
  { 'stevearc/dressing.nvim', opts = { input = { default_prompt = '>' } } },
  {
    'folke/noice.nvim',
    version = '*',
    opts = {
      lsp = {
        -- override markdown rendering so that **cmp** and other plugins use **Treesitter**
        override = {
          ['vim.lsp.util.convert_input_to_markdown_lines'] = true,
          ['vim.lsp.util.stylize_markdown'] = true,
          -- ["cmp.entry.get_documentation"] = true, -- requires hrsh7th/nvim-cmp
        },
        signature = {
          enabled = false,
        },
      },
      -- you can enable a preset for easier configuration
      presets = {
        bottom_search = true, -- use a classic bottom cmdline for search
        command_palette = true, -- position the cmdline and popupmenu together
        long_message_to_split = true, -- long messages will be sent to a split
        inc_rename = false, -- enables an input dialog for inc-rename.nvim
        lsp_doc_border = false, -- add a border to hover docs and signature help
      },
    },
  },
  -- Highlight todo, notes, etc in comments
  {
    'folke/todo-comments.nvim',
    event = 'VimEnter',
    dependencies = { 'nvim-lua/plenary.nvim' },
    opts = {
      -- your configuration comes here
      -- or leave it empty to use the default settings
      -- refer to the configuration section below
      signs = false,
    },
  },
  { -- Keymap hints
    'folke/which-key.nvim',
    event = 'VimEnter',
    lazy = false,
    version = '*',
    opts = {
      -- delay = 0,
      icons = {
        -- set icon mappings to true if you have a Nerd Font
        mappings = vim.g.have_nerd_font,
        -- If you are using a Nerd Font: set icons.keys to an empty table which will use the
        -- default which-key.nvim defined Nerd Font icons, otherwise define a string table
        keys = vim.g.have_nerd_font and {} or {
          Up = '<Up> ',
          Down = '<Down> ',
          Left = '<Left> ',
          Right = '<Right> ',
          C = '<C-…> ',
          M = '<M-…> ',
          D = '<D-…> ',
          S = '<S-…> ',
          CR = '<CR> ',
          Esc = '<Esc> ',
          ScrollWheelDown = '<ScrollWheelDown> ',
          ScrollWheelUp = '<ScrollWheelUp> ',
          NL = '<NL> ',
          BS = '<BS> ',
          Space = '<Space> ',
          Tab = '<Tab> ',
          F1 = '<F1>',
          F2 = '<F2>',
          F3 = '<F3>',
          F4 = '<F4>',
          F5 = '<F5>',
          F6 = '<F6>',
          F7 = '<F7>',
          F8 = '<F8>',
          F9 = '<F9>',
          F10 = '<F10>',
          F11 = '<F11>',
          F12 = '<F12>',
        },
      },
      spec = {
        { '<leader>a', group = '[A]vante' },
        { '<leader>d', group = '[D]ocument' },
        { '<leader>r', group = '[R]ename' },
        { '<leader>s', group = '[S]earch' },
        { '<leader>w', group = '[W]orkspace' },
        { '<leader>t', group = '[T]oggle' },
        { '<leader>g', group = '[G]it' },
      },
    },
  },
  { -- mini.nvim
    'echasnovski/mini.nvim',
    version = '*',
    lazy = false,
    config = function()
      require('mini.notify').setup() -- notifications
      require('mini.files').setup() -- neo-tree equivalent
      local kwoht = [[
    █████                                                                        █████       ███
   ░░███                                                                        ░░███       ░░░
    ░███ █████  ██████   ██████  ████████     █████ ███ █████  ██████  ████████  ░███ █████ ████  ████████    ███████
    ░███░░███  ███░░███ ███░░███░░███░░███   ░░███ ░███░░███  ███░░███░░███░░███ ░███░░███ ░░███ ░░███░░███  ███░░███
    ░██████░  ░███████ ░███████  ░███ ░███    ░███ ░███ ░███ ░███ ░███ ░███ ░░░  ░██████░   ░███  ░███ ░███ ░███ ░███
    ░███░░███ ░███░░░  ░███░░░   ░███ ░███    ░░███████████  ░███ ░███ ░███      ░███░░███  ░███  ░███ ░███ ░███ ░███
    ████ █████░░██████ ░░██████  ░███████      ░░████░████   ░░██████  █████     ████ █████ █████ ████ █████░░███████
   ░░░░ ░░░░░  ░░░░░░   ░░░░░░   ░███░░░        ░░░░ ░░░░     ░░░░░░  ░░░░░     ░░░░ ░░░░░ ░░░░░ ░░░░ ░░░░░  ░░░░░███
                                 ░███                                                                        ███ ░███
                        █████    █████                     █████     █████    █████       ███               ░░██████
                       ░░███    ░░░░░                     ░░███     ░░███    ░░███       ░░░                 ░░░░░░
  ██████  ████████      ░███████    ██████   ████████   ███████     ███████   ░███████   ████  ████████    ███████  █████
 ███░░███░░███░░███     ░███░░███  ░░░░░███ ░░███░░███ ███░░███    ░░░███░    ░███░░███ ░░███ ░░███░░███  ███░░███ ███░░
░███ ░███ ░███ ░███     ░███ ░███   ███████  ░███ ░░░ ░███ ░███      ░███     ░███ ░███  ░███  ░███ ░███ ░███ ░███░░█████
░███ ░███ ░███ ░███     ░███ ░███  ███░░███  ░███     ░███ ░███      ░███ ███ ░███ ░███  ░███  ░███ ░███ ░███ ░███ ░░░░███
░░██████  ████ █████    ████ █████░░████████ █████    ░░████████     ░░█████  ████ █████ █████ ████ █████░░███████ ██████
░░░░░░  ░░░░ ░░░░░    ░░░░ ░░░░░  ░░░░░░░░ ░░░░░      ░░░░░░░░       ░░░░░  ░░░░ ░░░░░ ░░░░░ ░░░░ ░░░░░  ░░░░░███░░░░░░
                                                                                                         ███ ░███
                                                                                                        ░░██████
                                                                                                         ░░░░░░
                                           ]]
      require('mini.starter').setup { header = kwoht } -- dashboard
      require('mini.tabline').setup() -- tabline
      -- Simple and easy statusline.
      --  You could remove this setup call if you don't like it,
      --  and try some other statusline plugin
      local statusline = require 'mini.statusline'
      -- set use_icons to true if you have a Nerd Font
      statusline.setup { use_icons = vim.g.have_nerd_font }

      -- You can configure sections in the statusline by overriding their
      -- default behavior. For example, here we set the section for
      -- cursor location to LINE:COLUMN
      ---@diagnostic disable-next-line: duplicate-set-field
      statusline.section_location = function()
        return '%2l:%-2v'
      end
    end,
    keys = {
      { '<leader>h', '<cmd>MiniStarter<cr>', desc = '[H]elp' },
    },
  },
  { -- auto dark mode
    'f-person/auto-dark-mode.nvim',
    opts = {
      update_interval = 1000,
      set_dark_mode = function()
        vim.api.nvim_set_option_value('background', 'dark', {})
        vim.cmd 'colorscheme gruvbox'
      end,
      set_light_mode = function()
        vim.api.nvim_set_option_value('background', 'light', {})
        vim.cmd 'colorscheme gruvbox'
      end,
    },
  },
  { -- Adds git related signs to the gutter, as well as utilities for managing changes
    'lewis6991/gitsigns.nvim',
    opts = {
      signs = {
        add = { text = '+' },
        change = { text = '~' },
        delete = { text = '_' },
        topdelete = { text = '‾' },
        changedelete = { text = '~' },
      },
      on_attach = function(bufnr)
        local gitsigns = require 'gitsigns'

        local function map(mode, l, r, opts)
          opts = opts or {}
          opts.buffer = bufnr
          vim.keymap.set(mode, l, r, opts)
        end

        -- Navigation
        map('n', ']c', function()
          if vim.wo.diff then
            vim.cmd.normal { ']c', bang = true }
          else
            gitsigns.nav_hunk 'next'
          end
        end, { desc = 'Jump to next git [c]hange' })

        map('n', '[c', function()
          if vim.wo.diff then
            vim.cmd.normal { '[c', bang = true }
          else
            gitsigns.nav_hunk 'prev'
          end
        end, { desc = 'Jump to previous git [c]hange' })

        -- Actions
        -- visual mode
        map('v', '<leader>hs', function()
          gitsigns.stage_hunk { vim.fn.line '.', vim.fn.line 'v' }
        end, { desc = 'stage git hunk' })
        map('v', '<leader>hr', function()
          gitsigns.reset_hunk { vim.fn.line '.', vim.fn.line 'v' }
        end, { desc = 'reset git hunk' })
        -- normal mode
        map('n', '<leader>hs', gitsigns.stage_hunk, { desc = 'git [s]tage hunk' })
        map('n', '<leader>hr', gitsigns.reset_hunk, { desc = 'git [r]eset hunk' })
        map('n', '<leader>hS', gitsigns.stage_buffer, { desc = 'git [S]tage buffer' })
        map('n', '<leader>hu', gitsigns.undo_stage_hunk, { desc = 'git [u]ndo stage hunk' })
        map('n', '<leader>hR', gitsigns.reset_buffer, { desc = 'git [R]eset buffer' })
        map('n', '<leader>hp', gitsigns.preview_hunk, { desc = 'git [p]review hunk' })
        map('n', '<leader>hb', gitsigns.blame_line, { desc = 'git [b]lame line' })
        map('n', '<leader>hd', gitsigns.diffthis, { desc = 'git [d]iff against index' })
        map('n', '<leader>hD', function()
          gitsigns.diffthis '@'
        end, { desc = 'git [D]iff against last commit' })
        -- Toggles
        map('n', '<leader>tb', gitsigns.toggle_current_line_blame, { desc = '[T]oggle git show [b]lame line' })
        map('n', '<leader>tD', gitsigns.toggle_deleted, { desc = '[T]oggle git show [D]eleted' })
      end,
    },
  },
}
