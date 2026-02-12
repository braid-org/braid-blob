// Braid-Blob Live Images
// requires client.js

;(function() {

var live_images = new Map() // img -> ac

function sync(img) {
    var url = img.src
    if (!url) return

    // Find an unused query parameter name for cache-busting
    var param = 'img-live'
    var u = new URL(url)
    while (u.searchParams.has(param)) param = '-' + param
    function cache_bust() {
        u.searchParams.set(param, Math.random().toString(36).slice(2))
        return u.toString()
    }

    // Unsync first to handle attribute changes (e.g. droppable added/removed)
    unsync(img)

    var ac = new AbortController()
    var client_p = (async () => {
        var res = await braid_fetch(cache_bust(), {
            method: 'HEAD',
            headers: { "Merge-Type": "aww" },
            subscribe: true,
            retry: () => true,
            signal: ac.signal
        })
        return braid_blob_client(cache_bust(), {
            signal: ac.signal,
            parents: res.version,
            on_update: (body, content_type, version, from_local_update) => {
                if (from_local_update) {
                    var blob = new Blob([body], { type: content_type || 'image/png' })
                    img.src = URL.createObjectURL(blob)
                } else {
                    img.src = ''
                    img.src = cache_bust()
                }
            },
            on_delete: () => {
                img.src = ''
                img.src = cache_bust()
            },
            on_error: (error) => {
                console.error('Live image error for', url, error)
            }
        })
    })()
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
                await (await client_p).update(reader.result, file.type)
                img.src = cache_bust()
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
