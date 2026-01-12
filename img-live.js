// Braid-Blob Live Images
// requires client.js

var live_images = new Map() // url -> { blob, images: Set<img> }

function sync(img) {
    var url = img.src
    if (!url) return

    var entry = live_images.get(url)
    if (entry) {
        entry.images.add(img)
        // Apply current blob URL if we have one
        if (entry.objectUrl)
            img.src = entry.objectUrl
        return
    }

    // Create new subscription for this URL
    entry = { images: new Set([img]), objectUrl: null, blob: null }
    live_images.set(url, entry)

    entry.blob = braid_blob_client(url, {
        on_update: (body, content_type) => {
            // Revoke old object URL if exists
            if (entry.objectUrl)
                URL.revokeObjectURL(entry.objectUrl)

            // Create new blob and object URL
            var blob = new Blob([body], { type: content_type || 'image/png' })
            entry.objectUrl = URL.createObjectURL(blob)

            // Update all images subscribed to this URL
            entry.images.forEach(img => {
                img.src = entry.objectUrl
            })
        },
        on_delete: () => {
            if (entry.objectUrl) {
                URL.revokeObjectURL(entry.objectUrl)
                entry.objectUrl = null
            }
        },
        on_error: (error) => {
            console.error('Live image error for', url, error)
        }
    })
}

function unsync(img) {
    // Find which entry this image belongs to
    for (var [url, entry] of live_images) {
        if (entry.images.has(img)) {
            entry.images.delete(img)

            // If no more images using this URL, clean up
            if (entry.images.size === 0) {
                if (entry.objectUrl)
                    URL.revokeObjectURL(entry.objectUrl)
                // Note: braid_blob_client doesn't expose unsubscribe,
                // would need to pass AbortSignal in options to cancel
                live_images.delete(url)
            }
            break
        }
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
