// Braid-Blob Live Images
// requires client.js

var live_images = new Map() // img -> ac

function sync(img) {
    var url = img.src
    if (!url) return
    if (live_images.has(img)) return

    var ac = new AbortController()
    live_images.set(img, ac)

    braid_blob_client(url, {
        signal: ac.signal,
        on_update: (body, content_type) => {
            var blob = new Blob([body], { type: content_type || 'image/png' })
            img.src = URL.createObjectURL(blob)
        },
        on_error: (error) => {
            console.error('Live image error for', url, error)
        }
    })
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
        if (mutation.type === 'attributes' && mutation.attributeName === 'live' && mutation.target.tagName === 'IMG') {
            if (mutation.target.hasAttribute('live'))
                sync(mutation.target)
            else
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
        attributeFilter: ['live']
    })

    document.querySelectorAll('img[live]').forEach(sync)
}
