var {http_server: braidify, fetch: braid_fetch} = require('braid-http')

function create_braid_blob() {
    var braid_blob = {
        db_folder: './braid-blob-db',
        meta_folder: './braid-blob-meta',
        cache: {},
        meta_cache: {},
        key_to_subs: {},
        peer: null, // will be auto-generated if not set by the user
        db: null // object with read/write/delete methods
    }

    braid_blob.init = async () => {
        // We only want to initialize once
        var init_p = real_init()
        braid_blob.init = () => init_p
        await braid_blob.init()

        async function real_init() {
            // Ensure our meta folder exists
            await require('fs').promises.mkdir(braid_blob.meta_folder, { recursive: true })

            // Set up db - either use provided object or create file-based storage
            if (typeof braid_blob.db_folder === 'string') {
                await require('fs').promises.mkdir(braid_blob.db_folder, { recursive: true })
                braid_blob.db = {
                    read: async (key) => {
                        var file_path = `${braid_blob.db_folder}/${encode_filename(key)}`
                        try {
                            return await require('fs').promises.readFile(file_path)
                        } catch (e) {
                            if (e.code === 'ENOENT') return null
                            throw e
                        }
                    },
                    write: async (key, data) => {
                        var file_path = `${braid_blob.db_folder}/${encode_filename(key)}`
                        await require('fs').promises.writeFile(file_path, data)
                    },
                    delete: async (key) => {
                        var file_path = `${braid_blob.db_folder}/${encode_filename(key)}`
                        try {
                            await require('fs').promises.unlink(file_path)
                        } catch (e) {
                            if (e.code !== 'ENOENT') throw e
                        }
                    }
                }
            } else {
                // db_folder is already an object with read/write/delete
                braid_blob.db = braid_blob.db_folder
            }

            // establish a peer id if not already set
            if (!braid_blob.peer)
                braid_blob.peer = Math.random().toString(36).slice(2)
        }
    }

    async function get_meta(key) {
        if (!braid_blob.meta_cache[key]) {
            try {
                braid_blob.meta_cache[key] = JSON.parse(
                    await require('fs').promises.readFile(
                        `${braid_blob.meta_folder}/${encode_filename(key)}`, 'utf8'))
            } catch (e) {
                if (e.code === 'ENOENT')
                    braid_blob.meta_cache[key] = {}
                else throw e
            }
        }
        return braid_blob.meta_cache[key]
    }

    async function save_meta(key) {
        await require('fs').promises.writeFile(
            `${braid_blob.meta_folder}/${encode_filename(key)}`,
            JSON.stringify(braid_blob.meta_cache[key]))
    }

    async function delete_meta(key) {
        delete braid_blob.meta_cache[key]
        try {
            await require('fs').promises.unlink(
                `${braid_blob.meta_folder}/${encode_filename(key)}`)
        } catch (e) {
            if (e.code !== 'ENOENT') throw e
        }
    }

    braid_blob.put = async (key, body, options = {}) => {
        options = normalize_options(options)

        // Handle URL case - make a remote PUT request
        if (key instanceof URL) {
            var params = {
                method: 'PUT',
                signal: options.signal,
                body
            }
            if (!options.dont_retry)
                params.retry = () => true
            for (var x of ['headers', 'version', 'peer'])
                if (options[x] != null) params[x] = options[x]
            if (options.content_type)
                params.headers = { ...params.headers,
                    'Content-Type': options.content_type }

            return await braid_fetch(key.href, params)
        }

        await braid_blob.init()
        if (options.signal?.aborted) return

        return await within_fiber(key, async () => {
            var meta = await get_meta(key)
            if (options.signal?.aborted) return

            var their_e = options.version ? options.version[0] :
                // we'll give them a event id in this case
                `${braid_blob.peer}-${max_seq('' + Date.now(),
                    meta.event ? increment_seq(get_event_seq(meta.event)) : '')}`

            if (compare_events(their_e, meta.event) > 0) {
                meta.event = their_e

                if (!options.skip_write)
                    await braid_blob.db.write(key, body)
                if (options.signal?.aborted) return

                if (options.content_type)
                    meta.content_type = options.content_type

                await save_meta(key)
                if (options.signal?.aborted) return

                // Notify all subscriptions of the update
                // (except the peer which made the PUT request itself)
                var update = {
                    version: [meta.event],
                    content_type: meta.content_type,
                    body
                }
                if (braid_blob.key_to_subs[key])
                    for (var [peer, sub] of braid_blob.key_to_subs[key].entries())
                        if (!options.peer || options.peer !== peer)
                            await sub.sendUpdate(update)
            }

            return meta.event
        })
    }

    braid_blob.get = async (key, options = {}) => {
        options = normalize_options(options)

        // Handle URL case - make a remote GET request
        if (key instanceof URL) {
            var params = {
                signal: options.signal,
                subscribe: options.subscribe,
                heartbeats: 120,
            }
            if (!options.dont_retry) {
                params.retry = (res) => res.status !== 309 &&
                    res.status !== 404 && res.status !== 406
            }
            if (options.head) params.method = 'HEAD'
            for (var x of ['headers', 'parents', 'version', 'peer'])
                if (options[x] != null) params[x] = options[x]
            if (options.content_type)
                params.headers = { ...params.headers,
                    'Accept': options.content_type }

            var res = await braid_fetch(key.href, params)

            if (!res.ok)
                if (options.subscribe) throw new Error('failed to subscribe')
                else return null

            var result = {}
            if (res.version) result.version = res.version

            if (options.head) return result

            if (options.subscribe) {
                res.subscribe(async update => {
                    if (update.status === 404) update.delete = true
                    update.content_type = update.extra_headers['content-type']
                    await options.subscribe(update)
                }, e => options.on_error?.(e))
                return res
            } else {
                result.body = await res.arrayBuffer()
                return result
            }
        }

        await braid_blob.init()
        if (options.signal?.aborted) return

        return await within_fiber(key, async () => {
            var meta = await get_meta(key)
            if (options.signal?.aborted) return

            if (!meta.event && !options.subscribe) return null

            var result = {
                version: meta.event ? [meta.event] : [],
                content_type: meta.content_type
            }

            if (options.header_cb) await options.header_cb(result)
            if (options.signal?.aborted) return

            // Check if requested version/parents is newer than what we have - if so, we don't have it
            if (!options.subscribe) {
                if (compare_events(options.version?.[0], meta.event) > 0)
                    throw new Error('unknown version: ' + options.version)
                if (compare_events(options.parents?.[0], meta.event) > 0)
                    throw new Error('unknown version: ' + options.parents)
            }
            if (options.head) return result

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
                        if (update.delete) options.my_subscribe(update)
                        else if (compare_events(update.version[0], options.parents?.[0]) > 0)
                            options.my_subscribe(update)
                    }
                })

                options.signal?.addEventListener('abort', () => {
                    braid_blob.key_to_subs[key].delete(peer)
                    if (!braid_blob.key_to_subs[key].size)
                        delete braid_blob.key_to_subs[key]
                })

                if (options.before_send_cb) await options.before_send_cb()
                if (options.signal?.aborted) return

                // Send an immediate update if needed
                if (compare_events(result.version?.[0], options.parents?.[0]) > 0) {
                    result.sent = true
                    result.body = await braid_blob.db.read(key)
                    options.my_subscribe(result)
                }
            } else {
                // If not subscribe, send the body now
                result.body = await braid_blob.db.read(key)
            }

            return result
        })
    }

    braid_blob.delete = async (key, options = {}) => {
        options = normalize_options(options)

        // Handle URL case - make a remote DELETE request
        if (key instanceof URL) {
            var params = {
                method: 'DELETE',
                signal: options.signal
            }
            if (!options.dont_retry)
                params.retry = (res) => res.status !== 309 &&
                    res.status !== 404 && res.status !== 406
            for (var x of ['headers', 'peer'])
                if (options[x] != null) params[x] = options[x]
            if (options.content_type)
                params.headers = { ...params.headers,
                    'Accept': options.content_type }

            return await braid_fetch(key.href, params)
        }

        await braid_blob.init()
        if (options.signal?.aborted) return

        return await within_fiber(key, async () => {
            var meta = await get_meta(key)
            if (options.signal?.aborted) return

            await braid_blob.db.delete(key)
            await delete_meta(key)

            // Notify all subscriptions of the delete
            // (except the peer which made the DELETE request itself)
            var update = {
                delete: true,
                content_type: meta.content_type
            }
            if (braid_blob.key_to_subs[key])
                for (var [peer, sub] of braid_blob.key_to_subs[key].entries())
                    if (!options.peer || options.peer !== peer)
                        sub.sendUpdate(update)
        })
    }

    braid_blob.serve = async (req, res, options = {}) => {
        await braid_blob.init()

        if (!options.key) {
            var url = new URL(req.url, 'http://localhost')
            options.key = url.pathname
        }

        braidify(req, res)
        if (res.is_multiplexer) return

        // Handle OPTIONS request
        if (req.method === 'OPTIONS') return res.end()

        // consume PUT body
        var body = req.method === 'PUT' && await slurp(req)

        if (req.method === 'GET' || req.method === 'HEAD') {
            if (!res.hasHeader("editable")) res.setHeader("Editable", "true")
            if (!req.subscribe) res.setHeader("Accept-Subscribe", "true")
            res.setHeader("Merge-Type", "aww")

            try {
                var result = await braid_blob.get(options.key, {
                    peer: req.peer,
                    head: req.method === "HEAD",
                    version: req.version,
                    parents: req.parents,
                    header_cb: (result) => {
                        res.setHeader((req.subscribe ? "Current-" : "") +
                            "Version", version_to_header(result.version))
                        if (result.content_type)
                            res.setHeader('Content-Type', result.content_type)
                    },
                    before_send_cb: () => res.startSubscription(),
                    subscribe: req.subscribe ? (update) => {
                        if (update.delete) {
                            update.status = 404
                            delete update.delete
                        }
                        if (update.content_type) {
                            update['Content-Type'] = update.content_type
                            delete update.content_type
                        }
                        update['Merge-Type'] = 'aww'
                        res.sendUpdate(update)
                    } : null
                })
            } catch (e) {
                if (e.message && e.message.startsWith('unknown version')) {
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
            await braid_blob.delete(options.key, {
                content_type: req.headers['content-type'],
                peer: req.peer
            })
            res.end('')
        }
    }

    braid_blob.sync = (a, b, options = {}) => {
        options = normalize_options(options)
        if (!options.peer) options.peer = Math.random().toString(36).slice(2)

        if ((a instanceof URL) === (b instanceof URL)) {
            braid_blob.get(a, {
                ...options,
                subscribe: async update => {
                    if (update.delete) await braid_blob.delete(b, {
                        ...options,
                        content_type: update.content_type,
                    })
                    else await braid_blob.put(b, update.body, {
                        ...options,
                        version: update.version,
                        content_type: update.content_type,
                    })
                }
            })
            braid_blob.get(b, {
                ...options,
                subscribe: async update => {
                    if (update.delete) await braid_blob.delete(a, {
                        ...options,
                        content_type: update.content_type,
                    })
                    else await braid_blob.put(a, update.body, {
                        ...options,
                        version: update.version,
                        content_type: update.content_type,
                    })
                }
            })
        } else {
            // One is local, one is remote - make a=local and b=remote (swap if not)
            if (a instanceof URL) {
                let swap = a; a = b; b = swap
            }

            var ac = new AbortController()
            options.signal?.addEventListener('abort', () => ac.abort())

            function handle_error(e) {
                if (ac.signal.aborted) return
                console.log(`disconnected, retrying in 1 second`)
                setTimeout(connect, 1000)
            }

            async function connect() {
                if (ac.signal.aborted) return
                if (options.on_pre_connect) await options.on_pre_connect()

                try {
                    // Check if remote has our current version (simple fork-point check)
                    var server_has_our_version = false
                    var local_version = (await braid_blob.get(a, {
                        ...options,
                        signal: ac.signal,
                        head: true
                    }))?.version
                    if (local_version) {
                        var r = await braid_blob.get(b, {
                            ...options,
                            signal: ac.signal,
                            head: true,
                            dont_retry: true,
                            version: local_version,
                        })
                        server_has_our_version = !!r
                    }

                    // Local -> remote
                    await braid_blob.get(a, {
                        ...options,
                        signal: ac.signal,
                        parents: server_has_our_version ? local_version : null,
                        subscribe: async update => {
                            try {
                                if (update.delete) {
                                    var x = await braid_blob.delete(b, {
                                        ...options,
                                        signal: ac.signal,
                                        dont_retry: true,
                                        content_type: update.content_type,
                                    })
                                    if (!x.ok) handle_error(new Error('failed to delete'))
                                } else {
                                    var x = await braid_blob.put(b, update.body, {
                                        ...options,
                                        signal: ac.signal,
                                        dont_retry: true,
                                        version: update.version,
                                        content_type: update.content_type,
                                    })
                                    if ((x.status === 401 || x.status === 403) && options.on_unauthorized) {
                                        await options.on_unauthorized?.()
                                    } else if (!x.ok) handle_error(new Error('failed to PUT: ' + x.status))
                                }
                            } catch (e) {
                                if (e.name !== 'AbortError')
                                    handle_error(e)
                            }
                        }
                    })

                    // Remote -> local
                    var remote_res = await braid_blob.get(b, {
                        ...options,
                        signal: ac.signal,
                        dont_retry: true,
                        parents: local_version,
                        subscribe: async update => {
                            if (update.delete) await braid_blob.delete(a, {
                                ...options,
                                signal: ac.signal,
                                content_type: update.content_type,
                            })
                            else await braid_blob.put(a, update.body, {
                                ...options,
                                signal: ac.signal,
                                version: update.version,
                                content_type: update.content_type,
                            })
                        },
                        on_error: e => {
                            options.on_disconnect?.()
                            handle_error(e)
                        }
                    })
                    options.on_res?.(remote_res)
                } catch (e) {
                    handle_error(e)
                }
            }
            connect()
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

    function encode_filename(s) {
        // Deal with case insensitivity
        var bits = s.match(/\p{L}/ug).
            map(c => +(c === c.toUpperCase())).join('')
        var postfix = BigInt('0b0' + bits).toString(16)

        // Swap ! and /
        s = s.replace(/[\/!]/g, x => x === '/' ? '!' : '/')

        // Encode characters that are unsafe on various filesystems:
        //   < > : " / \ | ? *  - Windows restrictions
        //   %                  - Reserved for encoding
        //   \x00-\x1f, \x7f    - Control characters
        s = s.replace(/[<>:"/|\\?*%\x00-\x1f\x7f]/g, encode_char)

        // Deal with windows reserved words
        if (s.match(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i))
            s = s.slice(0, 2) + encode_char(s[2]) + s.slice(3)

        // Deal with case insensitivity
        s += '.' + postfix

        return s

        function encode_char(char) {
            return '%' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
        }
    }

    function get_header(headers, key) {
        if (!headers) return

        // optimization..
        if (headers.hasOwnProperty(key))
            return headers[key]

        var lowerKey = key.toLowerCase()
        for (var headerKey of Object.keys(headers))
            if (headerKey.toLowerCase() === lowerKey)
                return headers[headerKey]
    }

    function normalize_options(options = {}) {
        if (!normalize_options.special) {
            normalize_options.special = {
                version: 'version',
                parents: 'parents',
                'content-type': 'content_type',
                accept: 'content_type',
                peer: 'peer',
            }
        }

        var normalized = {}
        Object.assign(normalized, options)

        // Normalize top-level accept to content_type
        if (options.accept) {
            normalized.content_type = options.accept
            delete normalized.accept
        }

        if (options.headers) {
            normalized.headers = {}
            for (var [k, v] of (options.headers instanceof Headers ?
                options.headers.entries() :
                Object.entries(options.headers))) {
                var s = normalize_options.special[k]
                if (s) normalized[s] = v
                else normalized.headers[k] = v
            }
        }

        // Normalize version/parents strings to arrays
        if (typeof normalized.version === 'string')
            normalized.version = JSON.parse('[' + normalized.version + ']')
        if (typeof normalized.parents === 'string')
            normalized.parents = JSON.parse('[' + normalized.parents + ']')

        return normalized
    }

    braid_blob.create_braid_blob = create_braid_blob

    return braid_blob
}

module.exports = create_braid_blob()
