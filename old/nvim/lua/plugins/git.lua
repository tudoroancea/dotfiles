require('mini.git').setup()
require('mini.diff').setup({
    view = {
        style = 'sign',
        signs = { add = '✚', change = '', delete = '✖' },
    },
})
vim.keymap.set('n', '<leader>gg', ':LazyGit<cr>', { desc = 'LazyGit' })
