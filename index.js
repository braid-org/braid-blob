var {http_server: braidify, fetch: braid_fetch} = require('braid-http'),
    {url_file_db} = require('url-file-db'),
    path = require('path')

function create_braid_blob() {
    var braid_blob = {
        db_folder: './braid-blob-db',
        meta_folder: './braid-blob-meta',
        cache: {},
        key_to_subs: {},
        peer: null, // will be auto-generated if not set by the user
        db: null // url-file-db instance with integrated meta storage
    }

    braid_blob.init = async () => {
        // We only want to initialize once
        var init_p = real_init()
        braid_blob.init = () => init_p
        await braid_blob.init()

        async function real_init() {
            // Create url-file-db instance with integrated meta storage
            braid_blob.db = await url_file_db.create(
                braid_blob.db_folder,
                braid_blob.meta_folder,
                async (db, key) => {
                    // File changed externally, notify subscriptions
                    // Use db parameter instead of braid_blob.db to avoid race condition
                    var body = await db.read(key)
                    await braid_blob.put(key, body, { skip_write: true })
                }
            )

            // establish a peer id if not already set
            if (!braid_blob.peer)
                braid_blob.peer = Math.random().toString(36).slice(2)
        }
    }

    braid_blob.put = async (key, body, options = {}) => {
        // Handle URL case - make a remote PUT request
        if (key instanceof URL) {

            var params = {
                method: 'PUT',
                signal: options.signal,
                retry: () => true,
                body: body
            }
            for (var x of ['headers', 'version', 'peer'])
                if (options[x] != null) params[x] = options[x]
            if (options.content_type) {
                params.headers = { ...params.headers, 'Content-Type': options.content_type }
            }

            return await braid_fetch(key.href, params)
        }

        await braid_blob.init()
        if (options.signal?.aborted) return

        // Read the meta data using new meta API
        var meta = braid_blob.db.get_meta(key) || {}

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
            if (options.signal?.aborted) return

            // Update only the fields we want to change in metadata
            var meta_updates = { event: their_e }
            if (options.content_type)
                meta_updates.content_type = options.content_type

            await braid_blob.db.update_meta(key, meta_updates)
            if (options.signal?.aborted) return

            // Notify all subscriptions of the update
            // (except the peer which made the PUT request itself)
            if (braid_blob.key_to_subs[key])
                for (var [peer, sub] of braid_blob.key_to_subs[key].entries())
                    if (peer !== options.peer)
                        sub.sendUpdate({
                            version: [meta.event],
                            'Merge-Type': 'aww',
                            body
                        })
        }

        return meta.event
    }

    braid_blob.get = async (key, options = {}) => {
        // Handle URL case - make a remote GET request
        if (key instanceof URL) {
            var params = {
                signal: options.signal,
                subscribe: !!options.subscribe,
                heartbeats: 120,
            }
            if (!options.dont_retry) {
                params.retry = (res) => res.status !== 404
            }
            for (var x of ['headers', 'parents', 'version', 'peer'])
                if (options[x] != null) params[x] = options[x]

            var res = await braid_fetch(key.href, params)

            if (res.status === 404) return null

            if (options.subscribe) {
                res.subscribe(async update => {
                    await options.subscribe(update)
                }, e => options.on_error?.(e))
                return res
            } else {
                return await res.arrayBuffer()
            }
        }

        await braid_blob.init()

        // Read the meta data using new meta API
        var meta = braid_blob.db.get_meta(key) || {}
        if (meta.event == null) return null

        var result = {
            version: [meta.event],
            content_type: meta.content_type
        }
        if (options.header_cb) await options.header_cb(result)
        if (options.signal?.aborted) return
        // Check if requested version/parents is newer than what we have - if so, we don't have it
        if (options.version && options.version.length && compare_events(options.version[0], meta.event) > 0)
            throw new Error('unkown version: ' + options.version)
        if (options.parents && options.parents.length && compare_events(options.parents[0], meta.event) > 0)
            throw new Error('unkown version: ' + options.parents)
        if (options.head) return

        if (options.subscribe) {
            var subscribe_chain = Promise.resolve()
            options.my_subscribe = (x) => subscribe_chain =
                subscribe_chain.then(() =>
                    !options.signal?.aborted && options.subscribe(x))

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

            options.signal?.addEventListener('abort', () => {
                braid_blob.key_to_subs[key].delete(peer)
                if (!braid_blob.key_to_subs[key].size)
                    delete braid_blob.key_to_subs[key]
            })

            if (options.before_send_cb) await options.before_send_cb(result)
            if (options.signal?.aborted) return

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

    braid_blob.delete = async (key, options = {}) => {
        // Handle URL case - make a remote DELETE request
        if (key instanceof URL) {

            var params = {
                method: 'DELETE',
                signal: options.signal
            }
            for (var x of ['headers', 'peer'])
                if (options[x] != null) params[x] = options[x]

            return await braid_fetch(key.href, params)
        }

        await braid_blob.init()
        if (options.signal?.aborted) return

        // Delete the file from the database
        await braid_blob.db.delete(key)

        // TODO: notify subscribers of deletion once we have a protocol for that
        // For now, just clean up the subscriptions
        if (braid_blob.key_to_subs[key])
            delete braid_blob.key_to_subs[key]
    }

    braid_blob.serve = async (req, res, options = {}) => {
        await braid_blob.init()

        if (!options.key) {
            var url = new URL(req.url, 'http://localhost')
            options.key = url_file_db.get_canonical_path(url.pathname)
        }

        braidify(req, res)
        if (res.is_multiplexer) return

        // Handle OPTIONS request
        if (req.method === 'OPTIONS') return res.end();

        // consume PUT body
        var body = req.method === 'PUT' && await slurp(req)

        await within_fiber(options.key, async () => {
            if (req.method === 'GET' || req.method === 'HEAD') {
                if (!res.hasHeader("editable")) res.setHeader("Editable", "true")
                if (!req.subscribe) res.setHeader("Accept-Subscribe", "true")
                res.setHeader("Merge-Type", "aww")

                try {
                    var result = await braid_blob.get(options.key, {
                        peer: req.peer,
                        head: req.method == "HEAD",
                        version: req.version || null,
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
                                'Merge-Type': 'aww',
                                body: update.body
                            })
                        } : null
                    })
                } catch (e) {
                    if (e.message && e.message.startsWith('unkown version')) {
                        // Server doesn't have this version
                        res.statusCode = 309
                        res.statusMessage = 'Version Unknown Here'
                        return res.end('')
                    } else throw e
                }

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
                var event = await braid_blob.put(options.key, body, {
                    version: req.version,
                    content_type: req.headers['content-type'],
                    peer: req.peer
                })
                res.setHeader("Version", version_to_header(event != null ? [event] : []))
                res.end('')
            } else if (req.method === 'DELETE') {
                await braid_blob.delete(options.key)
                res.statusCode = 204 // No Content
                res.end('')
            }
        })
    }

    braid_blob.sync = (a, b, options = {}) => {
        if ((a instanceof URL) === (b instanceof URL)) {
            // Both are URLs or both are local keys
            var a_first_put, b_first_put
            var a_first_put_promise = new Promise(done => a_first_put = done)
            var b_first_put_promise = new Promise(done => b_first_put = done)

            var a_ops = {
                signal: options.signal,
                subscribe: update => {
                    braid_blob.put(b, update.body, {
                        signal: options.signal,
                        version: update.version,
                        content_type: update.headers?.['content-type']
                    }).then(a_first_put)
                }
            }
            braid_blob.get(a, a_ops).then(x =>
                x || b_first_put_promise.then(() =>
                    braid_blob.get(a, a_ops)))

            var b_ops = {
                signal: options.signal,
                subscribe: update => {
                    braid_blob.put(a, update.body, {
                        signal: options.signal,
                        version: update.version,
                        content_type: update.headers?.['content-type']
                    }).then(b_first_put)
                }
            }
            braid_blob.get(b, b_ops).then(x =>
                x || a_first_put_promise.then(() =>
                    braid_blob.get(b, b_ops)))
        } else {
            // One is local, one is remote - make a=local and b=remote (swap if not)
            if (a instanceof URL) {
                let swap = a; a = b; b = swap
            }

            var closed = false
            var disconnect = () => { }
            options.signal?.addEventListener('abort', () =>
                { closed = true; disconnect() })

            var local_first_put, remote_first_put
            var local_first_put_promise = new Promise(done => local_first_put = done)
            var remote_first_put_promise = new Promise(done => remote_first_put = done)

            function handle_error(e) {
                if (closed) return
                disconnect()
                console.log(`disconnected, retrying in 1 second`)
                setTimeout(connect, 1000)
            }

            async function connect() {
                var ac = new AbortController()
                disconnect = () => ac.abort()

                try {
                    // Check if remote has our current version (simple fork-point check)
                    var local_result = await braid_blob.get(a, {
                        signal: ac.signal
                    })
                    var local_version = local_result ? local_result.version : null
                    var server_has_our_version = false

                    if (local_version) {
                        // Check if server has our version
                        var r = await braid_fetch(b.href, {
                            signal: ac.signal,
                            method: "HEAD",
                            version: local_version
                        })
                        server_has_our_version = r.ok
                    }

                    // Local -> remote: subscribe to future local changes
                    var a_ops = {
                        signal: ac.signal,
                        subscribe: update => {
                            braid_blob.put(b, update.body, {
                                signal: ac.signal,
                                version: update.version,
                                content_type: update.content_type
                            }).then(local_first_put).catch(e => {
                                if (e.name === 'AbortError') {
                                    // ignore
                                } else throw e
                            })
                        }
                    }
                    // Only set parents if server already has our version
                    // If server doesn't have it, omit parents so subscription sends everything
                    if (server_has_our_version) {
                        a_ops.parents = local_version
                    }

                    // Remote -> local: subscribe to remote updates
                    var b_ops = {
                        signal: ac.signal,
                        dont_retry: true,
                        subscribe: async update => {
                            await braid_blob.put(a, update.body, {
                                version: update.version,
                                content_type: update.headers?.['content-type']
                            })
                            remote_first_put()
                        },
                        on_error: handle_error
                    }
                    // Use fork-point (parents) to avoid receiving data we already have
                    if (local_version) {
                        b_ops.parents = local_version
                    }

                    // Set up both subscriptions, handling cases where one doesn't exist yet
                    braid_blob.get(a, a_ops).then(x =>
                        x || remote_first_put_promise.then(() =>
                            braid_blob.get(a, a_ops)))

                    var remote_res = await braid_blob.get(b, b_ops)

                    // If remote doesn't exist yet, wait for it to be created then reconnect
                    if (!remote_res) {
                        await local_first_put_promise
                        disconnect()
                        connect()
                    }
                    // Otherwise, on_error will call handle_error when connection drops
                } catch (e) {
                    handle_error(e)
                }
            }
            connect()
        }
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
