// Braid-Blob Live Images
// requires client.js

;(function() {

var live_images = new Map() // img -> ac

function sync(img) {
    var url = img.src
    if (!url) return

    // Unsync first to handle attribute changes (e.g. droppable added/removed)
    unsync(img)

    var ac = new AbortController()
    var client = braid_blob_client(url, {
        signal: ac.signal,
        on_update: (body, content_type, version, from_local_update) => {
            if (from_local_update) {
                var blob = new Blob([body], { type: content_type || 'image/png' })
                img.src = URL.createObjectURL(blob)
            } else {
                img.src = ''
                img.src = url
            }
        },
        on_delete: () => {
            img.src = ''
            img.src = url
        },
        on_error: (error) => {
            console.error('Live image error for', url, error)
        }
    })
    live_images.set(img, ac)

    if (img.hasAttribute('droppable')) {
        img.addEventListener('dragenter', function() {
            img.style.outline = '3px dashed #007bff'
            img.style.outlineOffset = '3px'
        })

        img.addEventListener('dragleave', function() {
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

            var reader = new FileReader()
            reader.onload = async function() {
                await client.update(reader.result, file.type)
                img.src = ''
                img.src = url
            }
            reader.readAsArrayBuffer(file)
        })
    }
}

function unsync(img) {
    var ac = live_images.get(img)
    if (ac) {
        ac.abort()
        live_images.delete(img)
    }
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

})()
