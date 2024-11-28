---@class LazySpec
return {
  {
    'rose-pine/neovim',
    name = 'rose-pine',
    priority = 1000,
    lazy = false,
    init = function()
      vim.cmd.colorscheme 'rose-pine'
      -- You can configure highlights by doing something like:
      -- vim.cmd.hi 'Comment gui=none'
    end,
  },
  { -- Make sure to set this up properly if you have lazy=true
    'MeanderingProgrammer/render-markdown.nvim',
    opts = {
      file_types = { 'markdown' },
    },
    ft = { 'markdown' },
  },
  { -- Neo-tree
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
          -- ['<C-J>'] = 'move_cursor_down',
          -- ['<C-K>'] = 'move_cursor_up',
          ['<C-H>'] = 'toggle_dotfiles',
          ['l'] = 'open',
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
      { '<leader>f', ':Neotree toggle<cr>', desc = 'NeoTree toggle', silent = true },
      { '<leader>o', ':Neotree focus<cr>', desc = 'NeoTree focus', silent = true },
    },
  },
  --- Nice UI elements
  { 'stevearc/dressing.nvim', opts = { input = { default_prompt = '>' } } },
  {
    'folke/noice.nvim',
    version = '*',
    dependencies = { 'hrsh7th/nvim-cmp' },
    opts = {
      notify = {
        enabled = false,
      },
      lsp = {
        -- override markdown rendering so that **cmp** and other plugins use **Treesitter**
        override = {
          ['vim.lsp.util.convert_input_to_markdown_lines'] = true,
          ['vim.lsp.util.stylize_markdown'] = true,
          ['cmp.entry.get_documentation'] = true, -- requires hrsh7th/nvim-cmp
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
      -- NOTE
      signs = true,
    },
  },
  { -- Keymap hints
    'folke/which-key.nvim',
    event = 'VimEnter',
    -- enabled = false,
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
        { '<leader>l', group = '[L]SP' },
        { '<leader>s', group = '[S]earch' },
        { '<leader>g', group = '[G]it' },
        { '<leader>p', group = '[P]lugins' },
      },
    },
  },
  {
    'echasnovski/mini.hipatterns',
    lazy = false,
    opts = {
      highlighters = {
        -- Highlight standalone 'FIXME', 'HACK', 'TODO', 'NOTE'
        fixme = { pattern = '%f[%w]()FIXME()%f[%W]', group = 'MiniHipatternsFixme' },
        hack = { pattern = '%f[%w]()HACK()%f[%W]', group = 'MiniHipatternsHack' },
        todo = { pattern = '%f[%w]()TODO()%f[%W]', group = 'MiniHipatternsTodo' },
        note = { pattern = '%f[%w]()NOTE()%f[%W]', group = 'MiniHipatternsNote' },

        -- Highlight hex color strings (`#rrggbb`) using that color
        hex_color = require('mini.hipatterns').gen_highlighter.hex_color(),
      },
    },
  },
  { -- notifications for errors, warnings, info, debug, and lsp
    'echasnovski/mini.notify',
    event = 'VeryLazy',
    lazy = true,
    config = function()
      require('mini.notify').setup()
      vim.notify = require('mini.notify').make_notify()
    end,
    keys = {
      { '<leader>nh', require('mini.notify').show_history, desc = '[N]otifications' },
    },
  },
  { -- indent scope hints
    'echasnovski/mini.indentscope',
    event = 'VeryLazy',
    lazy = true,
    config = function()
      local indentscope = require 'mini.indentscope'
      indentscope.setup { draw = { delay = 0, animation = indentscope.gen_animation.none() } }
    end,
  },
  { -- mini.files
    'echasnovski/mini.files',
    enabled = false,
    event = 'VeryLazy',
    lazy = true,
    opts = { windows = { preview = true }, mappings = { close = '<esc>' } },
    keys = {
      { '<leader>f', require('mini.files').open, desc = '[F}ile explorer' },
    },
  },
  { -- mini.clue
    'echasnovski/mini.clue',
    enabled = false,
    lazy = false,
    config = function()
      local miniclue = require 'mini.clue'
      miniclue.setup {
        window = {
          delay = 100,
        },
        triggers = {
          -- Leader triggers
          { mode = 'n', keys = '<Leader>' },
          { mode = 'x', keys = '<Leader>' },

          -- Built-in completion
          -- { mode = 'i', keys = '<C-x>' },

          -- `g` key
          { mode = 'n', keys = 'g' },
          { mode = 'x', keys = 'g' },

          -- Marks
          { mode = 'n', keys = "'" },
          { mode = 'n', keys = '`' },
          { mode = 'x', keys = "'" },
          { mode = 'x', keys = '`' },

          -- Registers
          { mode = 'n', keys = '"' },
          { mode = 'x', keys = '"' },
          { mode = 'i', keys = '<C-r>' },
          { mode = 'c', keys = '<C-r>' },

          -- Window commands
          { mode = 'n', keys = '<C-w>' },

          -- `z` key
          { mode = 'n', keys = 'z' },
          { mode = 'x', keys = 'z' },
        },

        clues = {
          -- Enhance this by adding descriptions for <Leader> mapping groups
          miniclue.gen_clues.builtin_completion(),
          miniclue.gen_clues.g(),
          miniclue.gen_clues.marks(),
          miniclue.gen_clues.registers(),
          miniclue.gen_clues.windows(),
          miniclue.gen_clues.z(),
          { mode = { 'n', 'x' }, key = '<leader>h', action = 'MiniClue' },
          { mode = { 'n', 'x' }, keys = '<leader>a', desc = '[A]vante' },
          { mode = { 'n', 'x' }, keys = '<leader>l', desc = '[L]SP' },
          { mode = { 'n', 'x' }, keys = '<leader>s', desc = '[S]earch' },
          { mode = { 'n', 'x' }, keys = '<leader>g', desc = '[G]it' },
          { mode = { 'n', 'x' }, keys = '<leader>p', desc = '[P]lugins' },
        },
      }
    end,
  },
  { -- mini.starter
    'echasnovski/mini.starter',
    lazy = false,
    config = function()
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
      require('mini.starter').setup { header = kwoht }
    end,
    keys = {
      { '<leader>h', require('mini.starter').open, desc = '[H]ome' },
    },
  },
  { -- tab line
    'echasnovski/mini.tabline',
    lazy = false,
    opts = {
      use_icons = vim.g.have_nerd_font,
    },
  },
  { -- status line
    'echasnovski/mini.statusline',
    lazy = false,
    config = function()
      local statusline = require 'mini.statusline'
      statusline.setup { use_icons = vim.g.have_nerd_font }

      -- You can configure sections in the statusline by overriding their
      -- default behavior. For example, here we set the section for
      -- cursor location to LINE:COLUMN
      ---@diagnostic disable-next-line: duplicate-set-field
      statusline.section_location = function()
        return '%2l:%-2v'
      end
    end,
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
