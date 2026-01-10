// Braid-Blob Client
// requires braid-http@~1.3/braid-http-client.js
//
// Usage:
//   braid_blob_client(url, {
//       on_update: (blob, content_type, version) => {
//           // Called whenever there's a new version of the blob
//           console.log('New blob:', blob, content_type, version)
//       },
//       on_delete: () => {
//           // Called when the blob is deleted (404 status)
//       },
//       on_error: (error) => {
//           // Called on connection or subscription errors
//       },
//       signal: ac.signal // optional AbortSignal to unsubscribe
//   })
//
function braid_blob_client(url, options = {}) {
    var current_version = null

    braid_fetch(url, {
        headers: { "Merge-Type": "aww" },
        subscribe: true,
        retry: () => true,
        signal: options.signal
    }).then(res => {
        res.subscribe(async update => {
            if (update.status == 404) {
                current_version = null
                if (options.on_delete) options.on_delete()
                return
            }

            var content_type = update.extra_headers?.['content-type']
            var version = update.version?.[0]

            // Only update if version is newer
            if (compare_events(version, current_version) > 0) {
                current_version = version
                if (options.on_update) options.on_update(update.body, content_type, update.version)
            }
        }, e => options.on_error?.(e))
    }).catch(e => options.on_error?.(e))

    function compare_events(a, b) {
        if (!a) a = ''
        if (!b) b = ''

        var c = compare_seqs(get_event_seq(a), get_event_seq(b))
        if (c) return c

        if (a < b) return -1
        if (a > b) return 1
        return 0
    }

    function get_event_seq(e) {
        for (let i = e.length - 1; i >= 0; i--)
            if (e[i] === '-') return e.slice(i + 1)
        return e
    }

    function compare_seqs(a, b) {
        if (a.length !== b.length) return a.length - b.length
        if (a < b) return -1
        if (a > b) return 1
        return 0
    }
}
