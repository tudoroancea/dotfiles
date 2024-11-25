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
---@class LazySpec
return {

    {
        "rose-pine/neovim",
        name = "rose-pine",
        lazy = false,
        config = function()
            require("rose-pine").setup()
            vim.cmd("colorscheme rose-pine")
        end
    },
    {
        "nvim-neo-tree/neo-tree.nvim",
        version = "*",
        dependencies = { "nvim-lua/plenary.nvim" },
        opts = {
            filesystem = {
                filtered_items = {
                    visible = true,
                    show_hidden_count = true,
                    hide_dotfiles = false,
                    hide_gitignored = true,
                    hide_by_name = {
                        ".git",
                        ".DS_Store",
                    },
                    never_show = {},
                },
            },
        },
        keys = {
            { "<leader>e", "<cmd>Neotree toggle<cr>", desc = "NeoTree" },
        }
    },
    --- Nice UI elements
    { "stevearc/dressing.nvim", opts = { input = { default_prompt = ">" } } },
    {
        "folke/noice.nvim",
        version = "*",
        opts = {
            lsp = {
                -- override markdown rendering so that **cmp** and other plugins use **Treesitter**
                override = {
                    ["vim.lsp.util.convert_input_to_markdown_lines"] = true,
                    ["vim.lsp.util.stylize_markdown"] = true,
                    -- ["cmp.entry.get_documentation"] = true, -- requires hrsh7th/nvim-cmp
                },
                signature = {
                    enabled = false,
                },
            },
            -- you can enable a preset for easier configuration
            presets = {
                bottom_search = true,         -- use a classic bottom cmdline for search
                command_palette = true,       -- position the cmdline and popupmenu together
                long_message_to_split = true, -- long messages will be sent to a split
                inc_rename = false,           -- enables an input dialog for inc-rename.nvim
                lsp_doc_border = false,       -- add a border to hover docs and signature help
            },
        },
    },
    {
        "folke/todo-comments.nvim",
        dependencies = { "nvim-lua/plenary.nvim" },
        opts = {
            -- your configuration comes here
            -- or leave it empty to use the default settings
            -- refer to the configuration section below
        }
    },
    --- Keymap hints
    {
        "folke/which-key.nvim",
        event = "VeryLazy",
        lazy = false,
        version = "*",
        opts = {
            delay = 0,
            spec = {
                {
                    mode = { "n", "v" },
                    { "<leader>G", group = "Git" },
                    { "<leader>R", group = "Replace" },
                    { "<leader>l", group = "LSP" },
                    { "<leader>t", group = "Test" },
                    { "<leader>s", group = "Search" },
                    { "<leader>x", group = "diagnostics/quickfix" },
                    { "<leader>n", group = "Gen Annotations" },
                    { "<leader>N", group = "Package Info" },
                    { "<leader>g", group = "Go" },
                    { "<leader>W", group = "Workspace" },
                    { "[",         group = "prev" },
                    { "]",         group = "next" },
                    { "g",         group = "goto" },
                },
                -- {
                -- 	mode = "a",
                -- 	{"<C-W>", "Go to pane above"},
                -- }
            },
        },
    },
    --- Mini
    {
        "echasnovski/mini.icons",
        version = "*",
        lazy = false,
        opts = {},
        specs = { { 'nvim-tree/nvim-web-devicons', enabled = false, optional = true } },
        init = function()                                     -- https://old.reddit.com/r/neovim/comments/1duf3w7/miniicons_general_icon_provider_several/lbgbc6a/
            package.preload['nvim-web-devicons'] = function() -- needed since it will be false when loading and mini will fail
                package.loaded['nvim-web-devicons'] = {}
                require('mini.icons').mock_nvim_web_devicons()
                return package.loaded['nvim-web-devicons']
            end
        end,
    },
    {
        "echasnovski/mini.nvim",
        version = "*",
        lazy = false,
        config = function()
            require('mini.statusline').setup({ set_vim_settings = false })
            require('mini.tabline').setup()
            require('mini.notify').setup()
            require('mini.files').setup()
            require('mini.starter').setup({ header = kwoht })
        end,
        keys = {
            { "<leader>h", "<cmd>MiniStarter<cr>", desc = "[H]elp" },
        }
    },
    --- dashboard
    {
        "folke/snacks.nvim",
        enabled = false,
        lazy = true,
        opts = {
            dashboard = {
                preset = {
                    header = kwoht,
                    -- stylua: ingore
                    ---@type snacks.dashboard.Item[]
                    keys = {
                        { icon = " ", key = "f", desc = "Find File", action = ":lua Snacks.dashboard.pick('files')" },
                        { icon = " ", key = "n", desc = "New File", action = ":ene | startinsert" },
                        { icon = " ", key = "g", desc = "Find Text", action = ":lua Snacks.dashboard.pick('live_grep')" },
                        { icon = " ", key = "r", desc = "Recent Files", action = ":lua Snacks.dashboard.pick('oldfiles')" },
                        { icon = " ", key = "c", desc = "Config", action = ":lua Snacks.dashboard.pick('files', {cwd = vim.fn.stdpath('config')})" },
                        { icon = " ", key = "s", desc = "Restore Session", section = "session" },
                        { icon = " ", key = "x", desc = "Lazy Extras", action = ":LazyExtras" },
                        { icon = "󰒲 ", key = "l", desc = "Lazy", action = ":Lazy" },
                        { icon = " ", key = "q", desc = "Quit", action = ":qa" },
                    },
                },
            },
        },
    },
    -- auto dark mode
    {
        "f-person/auto-dark-mode.nvim",
        opts = {
            update_interval = 1000,
            set_dark_mode = function()
                vim.api.nvim_set_option_value("background", "dark", {})
                vim.cmd("colorscheme gruvbox")
            end,
            set_light_mode = function()
                vim.api.nvim_set_option_value("background", "light", {})
                vim.cmd("colorscheme gruvbox")
            end,
        },
    }
}
