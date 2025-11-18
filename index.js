var {http_server: braidify} = require('braid-http'),
    {url_file_db} = require('url-file-db'),
    fs = require('fs'),
    path = require('path')

function create_braid_blob() {
    var braid_blob = {
        db_folder: './braid-blob-db',
        meta_folder: './braid-blob-meta',
        cache: {},
        key_to_subs: {},
        peer: null, // we'll try to load this from a file, if not set by the user
        db: null, // url-file-db instance for blob storage
        meta_db: null // url-file-db instance for meta storage
    }

    braid_blob.init = async () => {
        // We only want to initialize once
        var init_p = real_init()
        braid_blob.init = () => init_p
        await braid_blob.init()

        async function real_init() {
            // Create url-file-db instance for blob storage
            braid_blob.db = await url_file_db.create(braid_blob.db_folder, async (key) => {
                // File changed externally, notify subscriptions
                var body = await braid_blob.db.read(key)
                await braid_blob.put(key, body, { skip_write: true })
            })

            // Create url-file-db instance for meta storage (in a subfolder)
            // This will create both meta_folder and the db subfolder with recursive: true
            braid_blob.meta_db = await url_file_db.create(`${braid_blob.meta_folder}/db`)

            // establish a peer id (stored at root of meta_folder, sibling to db subfolder)
            if (!braid_blob.peer)
                try {
                    braid_blob.peer = await fs.promises.readFile(`${braid_blob.meta_folder}/peer.txt`, 'utf8')
                } catch (e) {}
            if (!braid_blob.peer)
                braid_blob.peer = Math.random().toString(36).slice(2)
            await fs.promises.writeFile(`${braid_blob.meta_folder}/peer.txt`, braid_blob.peer)
        }
    }

    braid_blob.put = async (key, body, options = {}) => {
        await braid_blob.init()

        // Read the meta data from meta_db
        var meta = {}
        var meta_content = await braid_blob.meta_db.read(key)
        if (meta_content)
            meta = JSON.parse(meta_content.toString('utf8'))

        var their_e =
            !options.version ?
                // we'll give them a event id in this case
                `${braid_blob.peer}-${Math.max(Date.now(),
                    meta.event ? 1*get_event_seq(meta.event) + 1 : -Infinity)}` :
            !options.version.length ?
                null :
            options.version[0]

        if (their_e != null &&
            (meta.event == null ||
                compare_events(their_e, meta.event) > 0)) {
            meta.event = their_e

            // Write the file using url-file-db (unless skip_write is set)
            if (!options.skip_write)
                await braid_blob.db.write(key, body)

            // Write the meta data
            if (options.content_type)
                meta.content_type = options.content_type

            await braid_blob.meta_db.write(key, JSON.stringify(meta))

            // Notify all subscriptions of the update
            // (except the peer which made the PUT request itself)
            if (braid_blob.key_to_subs[key])
                for (var [peer, sub] of braid_blob.key_to_subs[key].entries())
                    if (peer !== options.peer)
                        sub.sendUpdate({
                            version: [meta.event],
                            'Merge-Type': 'lww',
                            body
                        })
        }

        return meta.event
    }

    braid_blob.get = async (key, options = {}) => {
        await braid_blob.init()

        // Read the meta data from meta_db
        var meta = {}
        var meta_content = await braid_blob.meta_db.read(key)
        if (meta_content)
            meta = JSON.parse(meta_content.toString('utf8'))
        if (meta.event == null) return null

        var result = {
            version: [meta.event],
            content_type: meta.content_type
        }
        if (options.header_cb) await options.header_cb(result)
        if (options.head) return

        if (options.subscribe) {
            var subscribe_chain = Promise.resolve()
            options.my_subscribe = (x) => subscribe_chain =
                subscribe_chain.then(() => options.subscribe(x))

            // Start a subscription for future updates
            if (!braid_blob.key_to_subs[key])
                braid_blob.key_to_subs[key] = new Map()

            var peer = options.peer || Math.random().toString(36).slice(2)
            braid_blob.key_to_subs[key].set(peer, {
                sendUpdate: (update) => {
                    options.my_subscribe({
                        body: update.body,
                        version: update.version,
                        content_type: meta.content_type
                    })
                }
            })

            // Store unsubscribe function
            result.unsubscribe = () => {
                braid_blob.key_to_subs[key].delete(peer)
                if (!braid_blob.key_to_subs[key].size)
                    delete braid_blob.key_to_subs[key]
            }

            if (options.before_send_cb) await options.before_send_cb(result)

            // Send an immediate update if needed
            if (!options.parents ||
                !options.parents.length ||
                compare_events(result.version[0], options.parents[0]) > 0) {
                result.sent = true
                options.my_subscribe({
                    body: await braid_blob.db.read(key),
                    version: result.version,
                    content_type: result.content_type
                })
            }
        } else {
            // If not subscribe, send the body now
            result.body = await braid_blob.db.read(key)
        }

        return result
    }

    braid_blob.serve = async (req, res, options = {}) => {
        await braid_blob.init()

        if (!options.key) options.key = url_file_db.get_key(req.url)

        braidify(req, res)
        if (res.is_multiplexer) return

        // Handle OPTIONS request
        if (req.method === 'OPTIONS') return res.end();

        // consume PUT body
        var body = req.method === 'PUT' && await slurp(req)

        await within_fiber(options.key, async () => {
            // Read the meta data from meta_db
            var meta = {}
            var meta_content = await braid_blob.meta_db.read(options.key)
            if (meta_content)
                meta = JSON.parse(meta_content.toString('utf8'))

            if (req.method === 'GET') {
                if (!res.hasHeader("editable")) res.setHeader("Editable", "true")
                if (!req.subscribe) res.setHeader("Accept-Subscribe", "true")
                res.setHeader("Merge-Type", "lww")

                var result = await braid_blob.get(options.key, {
                    peer: req.peer,
                    head: req.method == "HEAD",
                    parents: req.parents || null,
                    header_cb: (result) => {
                        res.setHeader((req.subscribe ? "Current-" : "") +
                            "Version", ascii_ify(result.version.map((x) =>
                                JSON.stringify(x)).join(", ")))
                        if (result.content_type)
                            res.setHeader('Content-Type', result.content_type)
                    },
                    before_send_cb: (result) =>
                        res.startSubscription({ onClose: result.unsubscribe }),
                    subscribe: req.subscribe ? (update) => {
                        res.sendUpdate({
                            version: update.version,
                            'Merge-Type': 'lww',
                            body: update.body
                        })
                    } : null
                })

                if (!result) {
                    res.statusCode = 404
                    return res.end('File Not Found')
                }

                if (result.content_type && req.headers.accept &&
                    !isAcceptable(result.content_type, req.headers.accept)) {
                    res.statusCode = 406
                    return res.end(`Content-Type of ${result.content_type} not in Accept: ${req.headers.accept}`)
                }

                if (req.method == "HEAD") return res.end('')
                else if (!req.subscribe) return res.end(result.body)
                else {
                    // If no immediate update was sent,
                    // get the node http code to send headers
                    if (!result.sent) res.write('\n\n') 
                }
            } else if (req.method === 'PUT') {
                // Handle PUT request to update binary files
                meta.event = await braid_blob.put(options.key, body, {
                    version: req.version,
                    content_type: req.headers['content-type'],
                    peer: req.peer
                })
                res.setHeader("Version", version_to_header(meta.event != null ? [meta.event] : []))
                res.end('')
            } else if (req.method === 'DELETE') {
                await braid_blob.db.delete(options.key)
                await braid_blob.meta_db.delete(options.key)
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

    function ascii_ify(s) {
        return s.replace(/[^\x20-\x7E]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
    }

    function version_to_header(version) {
        // Convert version array to header format: JSON without outer brackets
        if (!version || !version.length) return ''
        return ascii_ify(version.map(v => JSON.stringify(v)).join(', '))
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
