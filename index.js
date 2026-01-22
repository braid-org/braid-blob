var {http_server: braidify, fetch: braid_fetch, free_cors} = require('braid-http')

function create_braid_blob() {
    var braid_blob = {
        db_folder: null, // defaults to './braid-blobs'
        meta_folder: null, // defaults to './braid-blobs'
        temp_folder: null, // defaults to './braid-blobs'
        cache: {},
        key_to_subs: {},
        peer: null, // will be auto-generated if not set by the user
        db: null, // object with read/write/delete methods
        meta_db: null, // sqlite database for meta storage
        reconnect_delay_ms: 1000,
    }

    braid_blob.sync = (a, b, params = {}) => {
        params = normalize_params(params)
        if (!params.peer) params.peer = Math.random().toString(36).slice(2)

        // Support for same-type params removed for now,
        // since it is unused, unoptimized,
        // and not as well battle tested
        if ((a instanceof URL) === (b instanceof URL))
            throw new Error(`one parameter should be local string key, and the other a remote URL object`)

        // One is local, one is remote - make a=local and b=remote (swap if not)
        if (a instanceof URL) {
            let swap = a; a = b; b = swap
        }

        reconnector(params.signal, (_e, count) => {
            var delay = braid_blob.reconnect_delay_ms ?? Math.min(count, 3) * 1000
            console.log(`disconnected from ${b.href}, retrying in ${delay}ms`)
            return delay
        }, async (signal, handle_error) => {
            if (signal.aborted) return
            if (params.on_pre_connect) await params.on_pre_connect()

            try {
                // Check if remote has our current version (simple fork-point check)
                var server_has_our_version = false
                var local_version = (await braid_blob.get(a, {
                    ...params,
                    signal,
                    head: true
                }))?.version
                if (signal.aborted) return
                if (local_version) {
                    var r = await braid_blob.get(b, {
                        ...params,
                        signal,
                        head: true,
                        dont_retry: true,
                        version: local_version,
                    })
                    if (signal.aborted) return
                    server_has_our_version = !!r
                }

                // Local -> remote
                await braid_blob.get(a, {
                    ...params,
                    signal,
                    parents: server_has_our_version ? local_version : null,
                    subscribe: async update => {
                        try {
                            if (update.delete) {
                                var x = await braid_blob.delete(b, {
                                    ...params,
                                    signal,
                                    dont_retry: true,
                                    content_type: update.content_type,
                                })
                                if (signal.aborted) return
                                if (!x.ok) handle_error(new Error('failed to delete'))
                            } else {
                                var x = await braid_blob.put(b, update.body, {
                                    ...params,
                                    signal,
                                    dont_retry: true,
                                    version: update.version,
                                    content_type: update.content_type,
                                })
                                if (signal.aborted) return
                                if ((x.status === 401 || x.status === 403) && params.on_unauthorized) {
                                    await params.on_unauthorized?.()
                                } else if (!x.ok) handle_error(new Error('failed to PUT: ' + x.status))
                            }
                        } catch (e) { handle_error(e) }
                    }
                })

                // Remote -> local
                var remote_res = await braid_blob.get(b, {
                    ...params,
                    signal,
                    dont_retry: true,
                    parents: local_version,
                    subscribe: async update => {
                        if (update.delete) await braid_blob.delete(a, {
                            ...params,
                            signal,
                            content_type: update.content_type,
                        })
                        else await braid_blob.put(a, update.body, {
                            ...params,
                            signal,
                            version: update.version,
                            content_type: update.content_type,
                        })
                    },
                    on_error: e => {
                        params.on_disconnect?.()
                        handle_error(e)
                    }
                })
                params.on_res?.(remote_res)
            } catch (e) { handle_error(e) }
        })
    }

    braid_blob.serve = async (req, res, params = {}) => {
        await braid_blob.init()

        if (!params.key) {
            var url = new URL(req.url, 'http://localhost')
            params.key = url.pathname
        }

        free_cors(res)

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
                var result = await braid_blob.get(params.key, {
                    peer: req.peer,
                    head: req.method === "HEAD",
                    version: req.version,
                    parents: req.parents,
                    header_cb: (result) => {
                        res.setHeader((req.subscribe ? "Current-" : "") +
                            "Version", version_to_header(result.version))
                        res.setHeader("Version-Type", "wallclockish")
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
                        update['Version-Type'] = 'wallclockish'
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
            var event = await braid_blob.put(params.key, body, {
                version: req.version,
                content_type: req.headers['content-type'],
                peer: req.peer
            })
            res.setHeader("Current-Version", version_to_header(event != null ? [event] : []))
            res.setHeader("Version-Type", "wallclockish")
            res.end('')
        } else if (req.method === 'DELETE') {
            await braid_blob.delete(params.key, {
                content_type: req.headers['content-type'],
                peer: req.peer
            })
            res.end('')
        }
    }

    braid_blob.get = async (key, params = {}) => {
        params = normalize_params(params)

        // Handle URL case - make a remote GET request
        if (key instanceof URL) {
            var fetch_params = {
                signal: params.signal,
                subscribe: params.subscribe,
                heartbeats: 120,
            }
            if (!params.dont_retry) {
                fetch_params.retry = (res) => res.status !== 309 &&
                    res.status !== 404 && res.status !== 406
            }
            if (params.head) fetch_params.method = 'HEAD'
            for (var x of ['headers', 'parents', 'version', 'peer'])
                if (params[x] != null) fetch_params[x] = params[x]
            if (params.content_type)
                fetch_params.headers = { ...fetch_params.headers,
                    'Accept': params.content_type }
            if (params.version || params.parents)
                fetch_params.headers = { ...fetch_params.headers,
                    'Version-Type': 'wallclockish' }

            var res = await braid_fetch(key.href, fetch_params)

            if (!res.ok)
                if (params.subscribe) throw new Error('failed to subscribe')
                else return null

            var result = {}
            if (res.version) result.version = res.version

            if (params.head) return result

            if (params.subscribe) {
                res.subscribe(async update => {
                    if (update.status === 404) update.delete = true
                    update.content_type = update.extra_headers['content-type']
                    await params.subscribe(update)
                }, e => params.on_error?.(e))
                return res
            } else {
                result.body = await res.arrayBuffer()
                return result
            }
        }

        await braid_blob.init()
        if (params.signal?.aborted) return

        return await within_fiber(key, async () => {
            var meta = await get_meta(key)
            if (params.signal?.aborted) return

            if (!meta.event && !params.subscribe) return null

            var result = {
                version: meta.event ? [meta.event] : [],
                content_type: meta.content_type
            }

            if (params.header_cb) await params.header_cb(result)
            if (params.signal?.aborted) return

            // Check if requested version/parents is newer than what we have - if so, we don't have it
            if (!params.subscribe) {
                if (compare_events(params.version?.[0], meta.event) > 0)
                    throw new Error('unknown version: ' + params.version)
                if (compare_events(params.parents?.[0], meta.event) > 0)
                    throw new Error('unknown version: ' + params.parents)
            }
            if (params.head) return result

            if (params.subscribe) {
                var subscribe_chain = Promise.resolve()
                params.my_subscribe = (x) => subscribe_chain =
                    subscribe_chain.then(() =>
                        !params.signal?.aborted && params.subscribe(x))

                // Start a subscription for future updates
                if (!braid_blob.key_to_subs[key])
                    braid_blob.key_to_subs[key] = new Map()

                var peer = params.peer || Math.random().toString(36).slice(2)
                braid_blob.key_to_subs[key].set(peer, {
                    sendUpdate: (update) => {
                        if (update.delete) params.my_subscribe(update)
                        else if (compare_events(update.version[0], params.parents?.[0]) > 0)
                            params.my_subscribe(update)
                    }
                })

                params.signal?.addEventListener('abort', () => {
                    braid_blob.key_to_subs[key].delete(peer)
                    if (!braid_blob.key_to_subs[key].size)
                        delete braid_blob.key_to_subs[key]
                })

                if (params.before_send_cb) await params.before_send_cb()
                if (params.signal?.aborted) return

                // Send an immediate update if needed
                if (compare_events(result.version?.[0], params.parents?.[0]) > 0) {
                    result.sent = true
                    result.body = await (params.db || braid_blob.db).read(key)
                    params.my_subscribe(result)
                }
            } else {
                // If not subscribe, send the body now
                result.body = await (params.db || braid_blob.db).read(key)
            }

            return result
        })
    }

    braid_blob.put = async (key, body, params = {}) => {
        params = normalize_params(params)

        // Handle URL case - make a remote PUT request
        if (key instanceof URL) {
            var fetch_params = {
                method: 'PUT',
                signal: params.signal,
                body
            }
            if (!params.dont_retry)
                fetch_params.retry = () => true
            for (var x of ['headers', 'version', 'peer'])
                if (params[x] != null) fetch_params[x] = params[x]
            if (params.content_type)
                fetch_params.headers = { ...fetch_params.headers,
                    'Content-Type': params.content_type }
            if (params.version)
                fetch_params.headers = { ...fetch_params.headers,
                    'Version-Type': 'wallclockish' }

            return await braid_fetch(key.href, fetch_params)
        }

        await braid_blob.init()
        if (params.signal?.aborted) return

        return await within_fiber(key, async () => {
            var meta = await get_meta(key)
            if (params.signal?.aborted) return

            var their_e = params.version ? params.version[0] :
                // we'll give them a event id in this case
                create_event(meta.event)

            if (compare_events(their_e, meta.event) > 0) {
                meta.event = their_e

                if (!params.skip_write)
                    await (params.db || braid_blob.db).write(key, body)
                if (params.signal?.aborted) return

                if (params.content_type)
                    meta.content_type = params.content_type

                save_meta(key, meta)
                if (params.signal?.aborted) return

                // Notify all subscriptions of the update
                // (except the peer which made the PUT request itself)
                var update = {
                    version: [meta.event],
                    content_type: meta.content_type,
                    body
                }
                if (braid_blob.key_to_subs[key])
                    for (var [peer, sub] of braid_blob.key_to_subs[key].entries())
                        if (!params.peer || params.peer !== peer)
                            await sub.sendUpdate(update)
            }

            return meta.event
        })
    }

    braid_blob.delete = async (key, params = {}) => {
        params = normalize_params(params)

        // Handle URL case - make a remote DELETE request
        if (key instanceof URL) {
            var fetch_params = {
                method: 'DELETE',
                signal: params.signal
            }
            if (!params.dont_retry)
                fetch_params.retry = (res) => res.status !== 309 &&
                    res.status !== 404 && res.status !== 406
            for (var x of ['headers', 'peer'])
                if (params[x] != null) fetch_params[x] = params[x]
            if (params.content_type)
                fetch_params.headers = { ...fetch_params.headers,
                    'Accept': params.content_type }

            return await braid_fetch(key.href, fetch_params)
        }

        await braid_blob.init()
        if (params.signal?.aborted) return

        return await within_fiber(key, async () => {
            var meta = await get_meta(key)
            if (params.signal?.aborted) return

            await (params.db || braid_blob.db).delete(key)
            await delete_meta(key)

            // Notify all subscriptions of the delete
            // (except the peer which made the DELETE request itself)
            var update = {
                delete: true,
                content_type: meta.content_type
            }
            if (braid_blob.key_to_subs[key])
                for (var [peer, sub] of braid_blob.key_to_subs[key].entries())
                    if (!params.peer || params.peer !== peer)
                        sub.sendUpdate(update)
        })
    }

    braid_blob.init = async () => {
        // We only want to initialize once
        var init_p = real_init()
        braid_blob.init = () => init_p
        await braid_blob.init()

        async function real_init() {
            var fs = require('fs')

            var db_was_not_set = !braid_blob.db_folder
            if (db_was_not_set)
                braid_blob.db_folder = './braid-blobs'

            var get_db_folder = () =>
                ((typeof braid_blob.db_folder === 'string') &&
                braid_blob.db_folder) || './braid-blobs'

            // deal with temp folder
            if (!braid_blob.temp_folder) {
                // Deal with versions before 0.0.53
                await fs.promises.rm(
                    `${braid_blob.meta_folder || './braid-blob-meta'}/temp`,
                    { recursive: true, force: true })
                
                braid_blob.temp_folder = braid_blob.meta_folder ||
                    get_db_folder()
            }
            await fs.promises.mkdir(braid_blob.temp_folder, 
                { recursive: true })
            for (var f of await fs.promises.readdir(braid_blob.temp_folder))
                if (f.match(/^temp_\w+$/))
                    await fs.promises.unlink(`${braid_blob.temp_folder}/${f}`)
            
            // deal with meta folder
            var meta_was_not_set = !braid_blob.meta_folder
            if (meta_was_not_set)
                braid_blob.meta_folder = get_db_folder()
            await fs.promises.mkdir(braid_blob.meta_folder,
                { recursive: true })

            // set up sqlite for meta storage
            var Database = require('better-sqlite3')
            braid_blob.meta_db = new Database(
                `${braid_blob.meta_folder}/meta.sqlite`)
            braid_blob.meta_db.pragma('journal_mode = WAL')
            braid_blob.meta_db.exec(`
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value JSON
                )
            `)

            // Deal with versions before 0.0.53
            async function migrate_meta_files(dir) {
                for (var f of await fs.promises.readdir(dir)) {
                    if (!f.match(/\.[0-9a-f]+$/i)) continue
                    var key = decode_filename(f)
                    var value = JSON.parse(
                        await fs.promises.readFile(`${dir}/${f}`, 'utf8'))
                    save_meta(key, value)
                    await fs.promises.unlink(`${dir}/${f}`)
                }
            }
            if (meta_was_not_set) {
                try {
                    await fs.promises.access('./braid-blob-meta')
                    await migrate_meta_files('./braid-blob-meta')
                    await fs.promises.rm('./braid-blob-meta', { recursive: true })
                } catch (e) {}
            } else if (braid_blob.meta_folder !== braid_blob.db_folder)
                await migrate_meta_files(braid_blob.meta_folder)

            // Deal with versions before 0.0.53: migrate db files from ./braid-blob-db
            if (db_was_not_set) {
                try {
                    await fs.promises.access('./braid-blob-db')
                    for (var f of await fs.promises.readdir('./braid-blob-db')) {
                        if (!f.match(/\.[0-9a-f]+$/i)) continue
                        await fs.promises.copyFile(
                            `./braid-blob-db/${f}`,
                            `${braid_blob.db_folder}/${f}`)
                        await fs.promises.unlink(`./braid-blob-db/${f}`)
                    }
                    await fs.promises.rm('./braid-blob-db', { recursive: true })
                } catch (e) {}
            }

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
                        await atomic_write(file_path, data, braid_blob.temp_folder)
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

    function get_meta(key) {
        var row = braid_blob.meta_db.prepare(
            `SELECT value FROM meta WHERE key = ?`).get(key)
        return row ? JSON.parse(row.value) : {}
    }

    function save_meta(key, meta) {
        braid_blob.meta_db.prepare(
            `INSERT OR REPLACE INTO meta (key, value) VALUES (?, json(?))`)
            .run(key, JSON.stringify(meta))
    }

    function delete_meta(key) {
        braid_blob.meta_db.prepare(`DELETE FROM meta WHERE key = ?`).run(key)
    }

    //////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////

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

    function decode_filename(s) {
        // Remove the postfix '.XXX'
        s = s.replace(/\.[^.]+$/, '')
        // Decode percent-encoded characters
        s = decodeURIComponent(s)
        // Swap ! and / (reverse of encode)
        s = s.replace(/[\/!]/g, x => x === '!' ? '/' : '!')
        return s
    }

    function normalize_params(params = {}) {
        if (!normalize_params.special) {
            normalize_params.special = {
                version: 'version',
                parents: 'parents',
                'content-type': 'content_type',
                accept: 'content_type',
                peer: 'peer',
            }
        }

        var normalized = {}
        Object.assign(normalized, params)

        // Normalize top-level accept to content_type
        if (params.accept) {
            normalized.content_type = params.accept
            delete normalized.accept
        }

        if (params.headers) {
            normalized.headers = {}
            for (var [k, v] of (params.headers instanceof Headers ?
                params.headers.entries() :
                Object.entries(params.headers))) {
                var s = normalize_params.special[k.toLowerCase()]
                if (s) {
                    // Parse JSON-encoded header values for version/parents
                    if (s === 'version' || s === 'parents')
                        v = JSON.parse('[' + v + ']')
                    normalized[s] = v
                }
                else normalized.headers[k] = v
            }
        }

        // Normalize parent -> parents
        if (params.parent)
            normalized.parents = params.parent

        // Normalize version/parents: allow strings, wrap in array for internal use
        if (typeof normalized.version === 'string')
            normalized.version = [normalized.version]
        if (typeof normalized.parents === 'string')
            normalized.parents = [normalized.parents]
        
        // Validate version and parents
        validate_version_array(normalized.version, 1)
        validate_version_array(normalized.parents, 0)

        return normalized
    }

    function validate_version_array(x, min) {
        if (!x) return
        if (!Array.isArray(x)) throw new Error(`invalid version array: not an array`)
        if (x.length < min) throw new Error(`invalid version array: must have an event id`)
        if (x.length > 1) throw new Error(`invalid version array: can only have 1 event id`)
        if (typeof x[0] !== 'string') throw new Error(`invalid version array: event id must be a string`)
    }

    async function atomic_write(final_destination, data, temp_folder) {
        var temp = `${temp_folder}/temp_${Math.random().toString(36).slice(2)}`
        await require('fs').promises.writeFile(temp, data)
        await require('fs').promises.rename(temp, final_destination)
    }

    // Calls func(inner_signal, reconnect) immediately and handles reconnection.
    // - inner_signal: AbortSignal that aborts when reconnect() is called or outter_signal aborts
    // - reconnect(error): call this to trigger a reconnection after get_delay(error, count) ms
    // - Multiple/rapid reconnect() calls are safe - only one reconnection will be scheduled
    // - If outter_signal aborts, no further calls to func will occur
    function reconnector(outter_signal, get_delay, func) {
        if (outter_signal?.aborted) return

        var current_inner_ac = null
        outter_signal?.addEventListener('abort', () =>
            current_inner_ac?.abort())

        var reconnect_count = 0
        connect()
        function connect() {
            if (outter_signal?.aborted) return

            var ac = current_inner_ac = new AbortController()
            var inner_signal = ac.signal

            func(inner_signal, (e) => {
                if (outter_signal?.aborted ||
                    inner_signal.aborted) return

                ac.abort()
                var delay = get_delay(e, ++reconnect_count)
                setTimeout(connect, delay)
            })
        }
    }

    braid_blob.create_braid_blob = create_braid_blob
    braid_blob.braid_fetch = braid_fetch
    braid_blob.encode_filename = encode_filename

    return braid_blob
}

module.exports = create_braid_blob()
