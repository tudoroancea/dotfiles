require('nvim-treesitter.configs').setup({
    ensure_installed = { 'bash', 'c', 'cpp', 'python', 'gitignore', 'html', 'lua', 'luadoc', 'markdown', 'markdown_inline', 'query', 'vim', 'vimdoc', 'json', 'javascript', 'typescript' },
    auto_install = true,
    highlight = {
        enable = true,
        additional_vim_regex_highlighting = { 'ruby' },
    },
    indent = { enable = true, disable = { 'ruby' } },
})
