// Braid-Blob Client
// requires braid-http@~1.3/braid-http-client.js
//
// Usage:
//   var blob = braid_blob_client(url, {
//       peer: 'my-peer-id', // optional, random if not set
//       on_update: (body, content_type, version) => {
//           // Called whenever there's a new version of the blob
//           console.log('New blob:', body, content_type, version)
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
//   // Update the blob with new data
//   await blob.update(body, 'text/plain')
//
function braid_blob_client(url, params = {}) {
    var peer = params.peer || Math.random().toString(36).slice(2)
    var current_version = null

    braid_fetch(url, {
        headers: { "Merge-Type": "aww" },
        subscribe: true,
        parents: () => [current_version],
        peer,
        retry: () => true,
        signal: params.signal
    }).then(res => {
        res.subscribe(async update => {
            if (update.status == 404) {
                current_version = null
                return params.on_delete?.()
            }

            // Only update if version is newer
            var version = update.version?.[0]
            if (compare_events(version, current_version) > 0) {
                current_version = version
                params.on_update?.(update.body,
                    update.extra_headers?.['content-type'],
                    current_version)
            }
        }, e => params.on_error?.(e))
    }).catch(e => params.on_error?.(e))

    return {
        update: async (body, content_type) => {
            var seq = max_seq('' + Date.now(),
                increment_seq(get_event_seq(current_version)))
            current_version = `${peer}-${seq}`

            params.on_update?.(body, content_type, current_version)

            await braid_fetch(url, {
                method: 'PUT',
                version: [current_version],
                headers: { 'Content-Type': content_type },
                peer,
                retry: () => true,
                body
            })
        }
    }

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
        if (!e) return ''

        for (let i = e.length - 1; i >= 0; i--)
            if (e[i] === '-') return e.slice(i + 1)
        return e
    }

    function increment_seq(s) {
        if (!s) return '1'

        let last = s[s.length - 1]
        let rest = s.slice(0, -1)

        if (last >= '0' && last <= '8')
            return rest + String.fromCharCode(last.charCodeAt(0) + 1)
        else
            return increment_seq(rest) + '0'
    }

    function max_seq(a, b) {
        if (!a) a = ''
        if (!b) b = ''

        if (compare_seqs(a, b) > 0) return a
        return b
    }

    function compare_seqs(a, b) {
        if (!a) a = ''
        if (!b) b = ''

        if (a.length !== b.length) return a.length - b.length
        if (a < b) return -1
        if (a > b) return 1
        return 0
    }
}
