var {http_server: braidify, free_cors} = require('braid-http'),
    fs = require('fs'),
    path = require('path')

function create_braid_blob() {
    var braid_blob = {
        db_folder: './braid-blob-db',
        cache: {},
        key_to_subs: {},
        peer: null // we'll try to load this from a file, if not set by the user
    }

    braid_blob.init = async () => {
        braid_blob.init = () => {}

        await fs.promises.mkdir(`${braid_blob.db_folder}/blob`, { recursive: true })
        await fs.promises.mkdir(`${braid_blob.db_folder}/meta`, { recursive: true })

        // establish a peer id
        if (!braid_blob.peer)
            try {
                braid_blob.peer = await fs.promises.readFile(`${braid_blob.db_folder}/peer.txt`, 'utf8')
            } catch (e) {}
        if (!braid_blob.peer)
            braid_blob.peer = Math.random().toString(36).slice(2)
        await fs.promises.writeFile(`${braid_blob.db_folder}/peer.txt`, braid_blob.peer)
    }

    braid_blob.serve = async (req, res, options = {}) => {
        await braid_blob.init()

        if (!options.key) options.key = decodeURIComponent(req.url.split('?')[0])

        braidify(req, res)
        if (res.is_multiplexer) return

        // Handle OPTIONS request
        if (req.method === 'OPTIONS') return res.end();

        // consume PUT body
        var body = req.method === 'PUT' && await slurp(req)

        await within_fiber(options.key, async () => {
            const filename = `${braid_blob.db_folder}/blob/${encode_filename(options.key)}`
            const metaname = `${braid_blob.db_folder}/meta/${encode_filename(options.key)}`

            // Read the meta file
            var meta = {}
            try {
                meta = JSON.parse(await fs.promises.readFile(metaname, 'utf8'))
            } catch (e) {}

            if (req.method === 'GET') {
                // Handle GET request for binary files

                if (meta.event == null) {
                    res.statusCode = 404
                    res.setHeader('Content-Type', 'text/plain')
                    return res.end('File Not Found')
                }

                if (meta.content_type && req.headers.accept &&
                    !isAcceptable(meta.content_type, req.headers.accept)) {
                    res.statusCode = 406
                    res.setHeader('Content-Type', 'text/plain')
                    return res.end(`Content-Type of ${meta.content_type} not in Accept: ${req.headers.accept}`)
                }

                // Set Version header;
                //   but if this is a subscription,
                //     then we set Current-Version instead
                res.setHeader((req.subscribe ? 'Current-' : '') + 'Version',
                    JSON.stringify(meta.event))

                // Set Content-Type
                if (meta.content_type)
                    res.setHeader('Content-Type', meta.content_type)

                if (!req.subscribe)
                    return res.end(await fs.promises.readFile(filename))

                if (!res.hasHeader("editable"))
                    res.setHeader("Editable", "true")

                // Start a subscription for future updates.
                if (!braid_blob.key_to_subs[options.key])
                    braid_blob.key_to_subs[options.key] = new Map()
                var peer = req.peer || Math.random().toString(36).slice(2)
                braid_blob.key_to_subs[options.key].set(peer, res)

                res.startSubscription({ onClose: () => {
                    braid_blob.key_to_subs[options.key].delete(peer)
                    if (!braid_blob.key_to_subs[options.key].size)
                        delete braid_blob.key_to_subs[options.key]
                }})

                // Send an immediate update when:
                if (!req.parents ||            // 1) They want everything,
                    !req.parents.length ||     // 2) Or everything past the empty set,
                    compare_events(meta.event, req.parents[0]) > 0
                                            // 3) Or what we have is newer
                )
                    return res.sendUpdate({
                        version: [meta.event],
                        'Merge-Type': 'lww',
                        body: await fs.promises.readFile(filename)
                    })
                else res.write('\n\n') // get the node http code to send headers
            } else if (req.method === 'PUT') {
                // Handle PUT request to update binary files

                var their_e =
                    !req.version ?
                        // we'll give them a event id in this case
                        `${braid_blob.peer}-${Math.max(Date.now(),
                            meta.event ? 1*get_event_seq(meta.event) + 1 : -Infinity)}` :
                    !req.version.length ?
                        null :
                    req.version[0]

                if (their_e != null &&
                    (meta.event == null ||
                        compare_events(their_e, meta.event) > 0)) {
                    meta.event = their_e

                    // Write the file
                    await fs.promises.writeFile(filename, body)

                    // Write the meta file
                    if (req.headers['content-type'])
                        meta.content_type = req.headers['content-type']
                    await fs.promises.writeFile(metaname, JSON.stringify(meta))

                    // Notify all subscriptions of the update
                    // (except the peer which made the PUT request itself)
                    if (braid_blob.key_to_subs[options.key])
                        for (var [peer, sub] of braid_blob.key_to_subs[options.key].entries())
                            if (peer !== req.peer)
                                sub.sendUpdate({
                                    version: [meta.event],
                                    'Merge-Type': 'lww',
                                    body
                                })
                }
                res.setHeader("Version", meta.event != null ? JSON.stringify(meta.event) : '')
                res.end('')
            } else if (req.method === 'DELETE') {
                try {
                    await fs.promises.unlink(filename)
                } catch (e) {}
                try {
                    await fs.promises.unlink(metaname)
                } catch (e) {}
                res.statusCode = 204 // No Content
                res.end('')
            }
        })
    }

    function compare_events(a, b) {
        var a_num = get_event_seq(a)
        var b_num = get_event_seq(b)

        var c = a_num.length - b_num.length
        if (c) return c

        var c = a_num.localeCompare(b_num)
        if (c) return c

        return a.localeCompare(b)
    }

    function get_event_seq(e) {
        for (let i = e.length - 1; i >= 0; i--)
            if (e[i] === '-') return e.slice(i + 1)
        return e
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

    function isAcceptable(contentType, acceptHeader) {
        // If no Accept header or Accept is */*, accept everything
        if (!acceptHeader || acceptHeader === '*/*') return true;
        
        // Parse the Accept header into individual media types
        const acceptTypes = acceptHeader.split(',').map(type => type.trim());
        
        for (const acceptType of acceptTypes) {
            // Remove quality values (e.g., "text/html;q=0.9" -> "text/html")
            const cleanAcceptType = acceptType.split(';')[0].trim();
            
            // Exact match
            if (cleanAcceptType === contentType) return true;
            
            // Wildcard subtype match (e.g., "image/*" matches "image/png")
            if (cleanAcceptType.endsWith('/*')) {
                const acceptMain = cleanAcceptType.slice(0, -2);
                const contentMain = contentType.split('/')[0];
                if (acceptMain === contentMain) return true;
            }
            
            // Full wildcard
            if (cleanAcceptType === '*/*') return true;
        }
        
        return false;
    }

    braid_blob.create_braid_blob = create_braid_blob

    return braid_blob
}

module.exports = create_braid_blob()
