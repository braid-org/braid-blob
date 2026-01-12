// Braid-Blob Live Images
// requires client.js

var live_images = new Map() // img -> { ac, client }

function sync(img) {
    var url = img.src
    if (!url) return

    // Unsync first to handle attribute changes (e.g. droppable added/removed)
    unsync(img)

    var ac = new AbortController()
    var client = braid_blob_client(url, {
        signal: ac.signal,
        on_update: (body, content_type) => {
            var blob = new Blob([body], { type: content_type || 'image/png' })
            img.src = URL.createObjectURL(blob)
        },
        on_delete: () => {
            img.src = ''
        },
        on_error: (error) => {
            console.error('Live image error for', url, error)
        }
    })
    live_images.set(img, { ac, client })

    if (img.hasAttribute('droppable'))
        make_droppable(img)
}

function unsync(img) {
    var entry = live_images.get(img)
    if (entry) {
        entry.ac.abort()
        live_images.delete(img)
    }
}

function make_droppable(img) {
    img.addEventListener('dragenter', function(e) {
        img.style.outline = '3px dashed #007bff'
        img.style.outlineOffset = '3px'
    })

    img.addEventListener('dragleave', function(e) {
        img.style.outline = ''
        img.style.outlineOffset = ''
    })

    img.addEventListener('dragover', function(e) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
    })

    img.addEventListener('drop', function(e) {
        e.preventDefault()
        img.style.outline = ''
        img.style.outlineOffset = ''

        var file = e.dataTransfer.files[0]
        if (!file || !file.type.startsWith('image/')) return

        var entry = live_images.get(img)
        if (!entry) return

        var reader = new FileReader()
        reader.onload = function() {
            entry.client.update(reader.result, file.type)
        }
        reader.readAsArrayBuffer(file)
    })
}

var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
        mutation.addedNodes.forEach(function(node) {
            if (node.nodeType === 1) {
                if (node.tagName === 'IMG' && node.hasAttribute('live'))
                    sync(node)
                node.querySelectorAll('img[live]').forEach(sync)
            }
        })
        mutation.removedNodes.forEach(function(node) {
            if (node.nodeType === 1) {
                if (node.tagName === 'IMG' && node.hasAttribute('live'))
                    unsync(node)
                node.querySelectorAll('img[live]').forEach(unsync)
            }
        })
        if (mutation.type === 'attributes' && mutation.target.tagName === 'IMG') {
            if (mutation.target.hasAttribute('live'))
                sync(mutation.target)
            else if (mutation.attributeName === 'live')
                unsync(mutation.target)
        }
    })
})

if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init)
else
    init()

function init() {
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['live', 'droppable']
    })

    document.querySelectorAll('img[live]').forEach(sync)
}
