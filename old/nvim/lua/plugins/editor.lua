require('nvim-autopairs').setup({
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
})
local cmp_autopairs = require 'nvim-autopairs.completion.cmp'
local cmp = require 'cmp'
cmp.event:on('confirm_done', cmp_autopairs.on_confirm_done())

require('mini.ai').setup({ n_lines = 500 })
require('mini.surround').setup()
require('mini.pairs').setup()
require('mini.comment').setup()
require('mini.bufremove').setup()

require('conform').setup({
    notify_on_error = false,
    format_on_save = function(bufnr)
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
    },
})
vim.keymap.set('', '<leader>lf', function()
    require('conform').format { async = true, lsp_format = 'fallback' }
end, { desc = '[F]ormat buffer' })
