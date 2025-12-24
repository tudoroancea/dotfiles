vim.cmd.colorscheme 'rose-pine'

require('transparent').setup()

require('render-markdown').setup({
    file_types = { 'markdown' },
})

require('mini.files').setup({
    windows = {
        preview = true,
        width_focus = 40,
        width_nofocus = 20,
        width_preview = 50,
    },
    mappings = { close = '<esc>' },
})
vim.keymap.set('n', '<leader>fm', require('mini.files').open, { desc = '[F]ile explorer: [m]ini' })

require('noice').setup({
    lsp = {
        override = {
            ['vim.lsp.util.convert_input_to_markdown_lines'] = true,
            ['vim.lsp.util.stylize_markdown'] = true,
            ['cmp.entry.get_documentation'] = true,
        },
    },
    views = {
        cmdline_popup = {
            position = { row = 5, col = '50%' },
            size = { width = 60, height = 'auto' },
        },
        popupmenu = {
            relative = 'editor',
            position = { row = 8, col = '50%' },
            size = { width = 60, height = 10 },
            border = { style = 'rounded', padding = { 0, 1 } },
            win_options = {
                winhighlight = { Normal = 'Normal', FloatBorder = 'DiagnosticInfo' },
            },
        },
    },
})

require('todo-comments').setup({ signs = true })

local hipatterns = require('mini.hipatterns')
hipatterns.setup({
    highlighters = {
        fixme = { pattern = '%f[%w]()FIXME()%f[%W]', group = 'MiniHipatternsFixme' },
        hack = { pattern = '%f[%w]()HACK()%f[%W]', group = 'MiniHipatternsHack' },
        todo = { pattern = '%f[%w]()TODO()%f[%W]', group = 'MiniHipatternsTodo' },
        note = { pattern = '%f[%w]()NOTE()%f[%W]', group = 'MiniHipatternsNote' },
        hex_color = hipatterns.gen_highlighter.hex_color(),
    },
})

require('which-key').setup({
    icons = {
        mappings = vim.g.have_nerd_font,
        keys = vim.g.have_nerd_font and {} or {
          Up = '<Up> ', Down = '<Down> ', Left = '<Left> ', Right = '<Right> ',
          C = '<C-…> ', M = '<M-…> ', D = '<D-…> ', S = '<S-…> ',
          CR = '<CR> ', Esc = '<Esc> ', ScrollWheelDown = '<ScrollWheelDown> ',
          ScrollWheelUp = '<ScrollWheelUp> ', NL = '<NL> ', BS = '<BS> ',
          Space = '<Space> ', Tab = '<Tab> ', F1 = '<F1>', F2 = '<F2>',
          F3 = '<F3>', F4 = '<F4>', F5 = '<F5>', F6 = '<F6>', F7 = '<F7>',
          F8 = '<F8>', F9 = '<F9>', F10 = '<F10>', F11 = '<F11>', F12 = '<F12>',
        },
    },
    spec = {
        { '<leader>f', group = '[F]ile explorer' },
        { '<leader>l', group = '[L]SP' },
        { '<leader>s', group = '[S]earch' },
        { '<leader>g', group = '[G]it' },
        { '<leader>p', group = '[P]lugins' },
        { '<leader>b', group = '[B]uffers' },
    },
})

require('mini.indentscope').setup({
    draw = { delay = 0, animation = require('mini.indentscope').gen_animation.none() }
})

local headercontent = "Neovim"
local headerfile = vim.fn.stdpath("config") .. "/header.txt"
if vim.fn.filereadable(headerfile) == 1 then
    headercontent = table.concat(vim.fn.readfile(headerfile), "\n")
end

require('snacks').setup({
    dashboard = {
        enabled = true,
        formats = { header = { '%s', align = 'left' } },
        preset = { header = headercontent },
        sections = {
            { section = 'header', indent = 0, padding = 0 },
            { icon = ' ', title = 'Keymaps', section = 'keys', indent = 2, padding = 1 },
            { icon = ' ', title = 'Recent Files', section = 'recent_files', indent = 2, padding = 1 },
            { icon = ' ', title = 'Projects', section = 'projects', indent = 2, padding = 1 },
            { section = 'startup' },
        },
    },
})
vim.keymap.set('n', '<leader>h', function() require('snacks').dashboard() end, { desc = 'Dashboard' })

vim.g.barbar_auto_setup = false
require('barbar').setup({
    animation = false,
    auto_hide = true,
    icons = {},
})

require('mini.statusline').setup({
    use_icons = vim.g.have_nerd_font,
    content = {
          active = function()
            local mode, mode_hl = MiniStatusline.section_mode { trunc_width = 120 }
            local git = MiniStatusline.section_git { trunc_width = 40 }
            local diff = MiniStatusline.section_diff { trunc_width = 75 }
            local diagnostics = MiniStatusline.section_diagnostics { trunc_width = 75 }
            local lsp = MiniStatusline.section_lsp { trunc_width = 75 }
            local location = MiniStatusline.section_location { trunc_width = 75 }
            local search = MiniStatusline.section_searchcount { trunc_width = 75 }

            return MiniStatusline.combine_groups {
              { hl = mode_hl,                 strings = { mode } },
              { hl = 'MiniStatuslineDevinfo', strings = { git, diff, diagnostics, lsp } },
              '%<', 
              '%=', 
              { hl = mode_hl,                     strings = { search, location } },
            }
          end,
          inactive = function() return '' end,
    },
})

if os.getenv('SSH_TTY') == nil then
    require('auto-dark-mode').setup({
        update_interval = 1000,
        set_dark_mode = function()
            vim.notify 'dark mode'
            vim.api.nvim_set_option_value('background', 'dark', {})
        end,
        set_light_mode = function()
            vim.notify 'light mode'
            vim.api.nvim_set_option_value('background', 'light', {})
        end,
    })
end
