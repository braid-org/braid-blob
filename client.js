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
            current_version = create_event(current_version)

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

    function create_event(current_event, max_entropy = 1000) {
        var new_event = '' + Date.now()

        var current_seq = get_event_seq(current_event)
        if (compare_seqs(new_event, current_seq) > 0) return new_event

        // Find smallest base-10 integer where compare_seqs(int, current_seq) >= 0
        var base = seq_to_int(current_seq)
        return '' + (base + 1 + Math.floor(Math.random() * max_entropy))
    }

    function get_event_seq(e) {
        if (!e) return ''

        for (let i = e.length - 1; i >= 0; i--)
            if (e[i] === '-') return i == 0 ? e : e.slice(i + 1)
        return e
    }

    function compare_seqs(a, b) {
        if (!a) a = ''
        if (!b) b = ''

        var a_neg = a[0] === '-'
        var b_neg = b[0] === '-'
        if (a_neg !== b_neg) return a_neg ? -1 : 1

        // Both negative: compare magnitudes (reversed)
        if (a_neg) {
            var swap = a.slice(1); a = b.slice(1); b = swap
        }

        if (a.length !== b.length) return a.length - b.length
        if (a < b) return -1
        if (a > b) return 1
        return 0
    }

    // Smallest base-10 integer n where compare_seqs(String(n), s) >= 0
    function seq_to_int(s) {
        if (!s || s[0] === '-') return 0

        var len = s.length
        var min_of_len = Math.pow(10, len - 1) // e.g., len=3 -> 100
        var max_of_len = Math.pow(10, len) - 1 // e.g., len=3 -> 999

        if (s < String(min_of_len)) return min_of_len
        if (s > String(max_of_len)) return max_of_len + 1

        // s is in the base-10 range for this length
        // scan for first non-digit > '9', increment prefix and pad zeros
        var n = 0
        for (var i = 0; i < len; i++) {
            var c = s.charCodeAt(i)
            if (c >= 48 && c <= 57) {
                n = n * 10 + (c - 48)
            } else if (c > 57) {
                // non-digit > '9': increment prefix, pad rest with zeros
                return (n + 1) * Math.pow(10, len - i)
            } else {
                // non-digit < '0': just pad rest with zeros
                return n * Math.pow(10, len - i)
            }
        }
        return n
    }
}
