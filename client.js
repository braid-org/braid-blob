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
        parents: () => current_version,
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
            var version = update.version
            if (compare_events(version?.[0], current_version?.[0]) > 0) {
                current_version = version
                params.on_update?.(update.body,
                    update.extra_headers?.['content-type'],
                    current_version)
            }
        }, e => params.on_error?.(e))
    }).catch(e => params.on_error?.(e))

    return {
        update: async (body, content_type) => {
            current_version = [create_event(current_version?.[0])]

            params.on_update?.(body, content_type, current_version)

            await braid_fetch(url, {
                method: 'PUT',
                version: current_version,
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

        // Check if values match wallclockish format
        var re = compare_events.re || (compare_events.re = /^-?[0-9]*\.[0-9]*$/)
        var a_match = re.test(a)
        var b_match = re.test(b)

        // If only one matches, it wins
        if (a_match && !b_match) return 1
        if (b_match && !a_match) return -1

        // If neither matches, compare lexicographically
        if (!a_match && !b_match) {
            if (a < b) return -1
            if (a > b) return 1
            return 0
        }

        // Both match - compare as decimals using BigInt
        // Add decimal point if missing
        if (a.indexOf('.') === -1) a += '.'
        if (b.indexOf('.') === -1) b += '.'

        // Pad the shorter fractional part with zeros
        var diff = (a.length - a.indexOf('.')) - (b.length - b.indexOf('.'))
        if (diff < 0) a += '0'.repeat(-diff)
        else if (diff > 0) b += '0'.repeat(diff)

        // Remove decimal and parse as BigInt
        var a_big = BigInt(a.replace('.', ''))
        var b_big = BigInt(b.replace('.', ''))

        if (a_big < b_big) return -1
        if (a_big > b_big) return 1
        return 0
    }

    function create_event(current_event, decimal_places=3, entropy_digits=4) {
        var now = '' + Date.now() / 1000
        if (compare_events(now, current_event) > 0)
            return now

        // Add smallest increment to current_event using BigInt
        var e = current_event || '0'
        if (e.indexOf('.') === -1) e += '.'

        // Truncate or pad to exactly decimal_places decimal places
        var dot = e.indexOf('.')
        var frac = e.slice(dot + 1)
        if (frac.length > decimal_places) e = e.slice(0, dot + 1 + decimal_places)
        else if (frac.length < decimal_places) e += '0'.repeat(decimal_places - frac.length)

        var big = BigInt(e.replace('.', '')) + 1n
        var str = String(big)

        // Reinsert decimal point
        var result = str.slice(0, -decimal_places) + '.' + str.slice(-decimal_places)

        return result + random_digits(entropy_digits)
    }

    function random_digits(n) {
        if (!n) return ''
        var s = ''
        for (var i = 0; i < n; i++) s += Math.floor(Math.random() * 10)
        return s
    }
}
