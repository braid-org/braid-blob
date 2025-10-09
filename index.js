
var {http_server: braidify, free_cors} = require('braid-http'),
    fs = require('fs'),
    path = require('path')

var braid_blob = {
    db_folder: './braid-blob-db',
    cache: {}
}

var key_to_subs = {}

braid_blob.serve = async (req, res, options = {}) => {
    if (!options.key) options.key = decodeURIComponent(req.url.split('?')[0])


    braidify(req, res)
    if (res.is_multiplexer) return

    // Handle OPTIONS request
    if (req.method === 'OPTIONS') return res.end();

    // consume PUT body
    var body = req.method === 'PUT' && await slurp(req)

    await within_fiber(options.key, async () => {
        const filename = `${braid_blob.db_folder}/${encode_filename(options.key)}`
        
        try {
            var our_v = Math.round((await fs.promises.stat(filename)).mtimeMs)
        } catch (e) {
            var our_v = 0
        }

        if (req.method === 'GET') {
            // Handle GET request for binary files
            res.setHeader('Current-Version', `"${our_v}"`)

            if (!req.subscribe)
                return res.end(!our_v ? '' : await fs.promises.readFile(filename))

            // Start a subscription for future updates.
            if (!key_to_subs[options.key]) key_to_subs[options.key] = new Map()
            var peer = req.peer || Math.random().toString(36).slice(2)
            key_to_subs[options.key].set(peer, res)

            res.startSubscription({ onClose: () => {
                key_to_subs[options.key].delete(peer)
                if (!key_to_subs[options.key].size)
                    delete key_to_subs[options.key]
            }})

            if (!req.parents || 1*req.parents[0] < our_v)
                return res.sendUpdate({
                    version: ['' + our_v],
                    body: !our_v ? '' : await fs.promises.readFile(filename)
                })
            else res.write('\n\n') // get it to send headers
        } else if (req.method === 'PUT') {
            // Handle PUT request to update binary files

            // Ensure directory exists
            await fs.promises.mkdir(path.dirname(filename), { recursive: true })

            var their_v = req.version && 1*req.version[0]
            if (typeof their_v != 'number') their_v = 0
            
            if (their_v > our_v) {
                // Write the file
                await fs.promises.writeFile(filename, body)
                await fs.promises.utimes(filename, new Date(their_v), new Date(their_v))

                // Notify all subscriptions of the update (except the peer which made the PUT request itself)
                if (key_to_subs[options.key])
                    for (var [peer, sub] of key_to_subs[options.key].entries())
                        if (peer !== req.peer)
                            sub.sendUpdate({ body, version: ['' + their_v] })

                res.setHeader("Version", `"${their_v}"`)
            } else res.setHeader("Version", `"${our_v}"`)
            res.end('')
        }
    })
}

function encode_filename(filename) {
    // Swap all "!" and "/" characters
    let swapped = filename.replace(/[!/]/g, (match) => (match === "!" ? "/" : "!"))

    // Encode the filename using encodeURIComponent()
    let encoded = encodeURIComponent(swapped)

    return encoded
}

function within_fiber(id, func) {
    if (!within_fiber.chains) within_fiber.chains = {}
    var prev = within_fiber.chains[id] || Promise.resolve()
    var curr = prev.then(async () => {
        try {
            return await func()
        } finally {
            if (within_fiber.chains[id] === curr)
                delete within_fiber.chains[id]
        }
    })
    return within_fiber.chains[id] = curr
}

async function slurp(req) {
    return await new Promise(done => {
        var chunks = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => done(Buffer.concat(chunks)))
    })
}

module.exports = braid_blob
