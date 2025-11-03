
var {http_server: braidify, free_cors} = require('braid-http'),
    fs = require('fs'),
    path = require('path')

var braid_blob = {
    db_folder: './braid-blob-db',
    meta_folder: './braid-blob-meta',
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
        const metaname = `${braid_blob.meta_folder}/${encode_filename(options.key)}`
        
        // Read the meta file
        var meta = {}
        try {
            meta = JSON.parse(await fs.promises.readFile(metaname, 'utf8'))
        } catch (e) {}
        var our_v = meta.version

        if (req.method === 'GET') {
            // Handle GET request for binary files

            if (our_v == null) {
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
            res.setHeader((req.subscribe ? 'Current-' : '') + 'Version', `"${our_v}"`)
            
            // Set Content-Type
            if (meta.content_type)
                res.setHeader('Content-Type', meta.content_type)
                
            if (!req.subscribe)
                return res.end(await fs.promises.readFile(filename))

            if (!res.hasHeader("editable"))
                res.setHeader("Editable", "true")

            // Start a subscription for future updates.
            if (!key_to_subs[options.key]) key_to_subs[options.key] = new Map()
            var peer = req.peer || Math.random().toString(36).slice(2)
            key_to_subs[options.key].set(peer, res)

            res.startSubscription({ onClose: () => {
                key_to_subs[options.key].delete(peer)
                if (!key_to_subs[options.key].size)
                    delete key_to_subs[options.key]
            }})


            // Send an immediate update when:
            if (!req.parents ||          // 1) They have no version history
                                         //    (need full sync)
                !req.parents.length ||   // 2) Or their version is the empty set
                our_v > 1*req.parents[0] // 3) Or our version is newer
                )
                return res.sendUpdate({
                    version: our_v != null ? ['' + our_v] : [],
                    body: our_v != null ? await fs.promises.readFile(filename) : ''
                })
            else res.write('\n\n') // get the node http code to send headers
        } else if (req.method === 'PUT') {
            // Handle PUT request to update binary files

            // Ensure directory exists
            await fs.promises.mkdir(path.dirname(filename), { recursive: true })
            await fs.promises.mkdir(path.dirname(metaname), { recursive: true })

            var their_v =
                !req.version ?
                    // we'll give them a version in this case
                    Math.max(our_v != null ? our_v + 1 : 0, Date.now()) :
                !req.version.length ?
                    null :
                1*req.version[0]

            if (their_v != null &&
                (our_v == null || their_v > our_v)) {

                // Write the file
                await fs.promises.writeFile(filename, body)

                // Write the meta file
                meta.version = their_v
                if (req.headers['content-type'])
                    meta.content_type = req.headers['content-type']
                await fs.promises.writeFile(metaname, JSON.stringify(meta))

                // Notify all subscriptions of the update
                // (except the peer which made the PUT request itself)
                if (key_to_subs[options.key])
                    for (var [peer, sub] of key_to_subs[options.key].entries())
                        if (peer !== req.peer)
                            sub.sendUpdate({ body, version: ['' + their_v] })

                res.setHeader("Version", `"${their_v}"`)
            } else {
                res.setHeader("Version", our_v != null ? `"${our_v}"` : '')
            }
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

module.exports = braid_blob
