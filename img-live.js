// Braid-Blob Live Images
// requires client.js

;(function() {

var subscriptions = new Map() // base_url -> sub

function sync(img) {
    if (!img._img_live_base_url) img._img_live_base_url = img.src
    var base_url = img._img_live_base_url

    var sub = subscriptions.get(base_url)
    if (sub) {
        // Cancel any pending teardown
        clearTimeout(sub.teardown_timer)
        sub.teardown_timer = null
    } else {
        // Create cache-bust helper for this base URL
        var param = 'img-live'
        var u = new URL(base_url)
        while (u.searchParams.has(param)) param = '-' + param
        function cache_bust() {
            u.searchParams.set(param, Math.random().toString(36).slice(2))
            return u.toString()
        }

        subscriptions.set(base_url, sub = {
            imgs: new Set(),
            ac: new AbortController(),
            current_src: null,
            teardown_timer: null
        })

        function set_src(src) {
            sub.current_src = src
            sub.imgs.forEach(img => img.src = sub.current_src)
        }

        var client_p = (async () => {
            var res = await braid_fetch(cache_bust(), {
                method: 'HEAD',
                headers: { "Merge-Type": "aww" },
                subscribe: true,
                retry: () => true,
                signal: sub.ac.signal
            })
            return braid_blob_client(cache_bust(), {
                signal: sub.ac.signal,
                parents: res.version,
                on_update: (body, content_type, version, from_local_update) =>
                    set_src(!from_local_update ? cache_bust() :
                        URL.createObjectURL(new Blob(
                            [body], { type: content_type || 'image/png' }))),
                on_delete: () => set_src(cache_bust()),
                on_error: (error) =>
                    console.error('Live image error for', base_url, error)
            })
        })()

        sub.update = async (body, content_type) => {
            await (await client_p).update(body, content_type)
            set_src(cache_bust())
        }
    }

    sub.imgs.add(img)

    // Immediately set to the most recent known src
    if (sub.current_src) img.src = sub.current_src

    if (img.hasAttribute('droppable')) {
        if (!img.hasAttribute('tabindex')) img.setAttribute('tabindex', '0')

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
            reader.onload = () => sub.update(reader.result, file.type)
            reader.readAsArrayBuffer(file)
        })

        img.addEventListener('click', function() {
            img.focus()
        })

        img.addEventListener('focus', function() {
            img.style.outline = '3px dashed #007bff'
            img.style.outlineOffset = '3px'

            document.addEventListener('paste', on_paste)
        })

        img.addEventListener('blur', function() {
            img.style.outline = ''
            img.style.outlineOffset = ''

            document.removeEventListener('paste', on_paste)
        })

        function on_paste(e) {
            var items = e.clipboardData.items
            for (var i = 0; i < items.length; i++) {
                if (items[i].type.startsWith('image/')) {
                    e.preventDefault()
                    var file = items[i].getAsFile()
                    var reader = new FileReader()
                    reader.onload = () => sub.update(reader.result, file.type)
                    reader.readAsArrayBuffer(file)
                    break
                }
            }
        }
    }
}

function unsync(img) {
    var base_url = img._img_live_base_url
    var sub = subscriptions.get(base_url)
    if (sub?.imgs.delete(img) && !sub.imgs.size) {
        sub.teardown_timer = setTimeout(() => {
            sub.ac.abort()
            subscriptions.delete(base_url)
        }, 5000)
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
