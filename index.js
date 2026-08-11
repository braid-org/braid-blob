var {http_server: braidify, fetch: braid_fetch, free_cors} = require('braid-http')

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed')
}

function create_braid_blob() {
    var braid_blob = {
        db_folder:          null, // defaults to './braid-blobs'
        meta_folder:        null, // defaults to './braid-blobs'
        temp_folder:        null, // defaults to './braid-blobs'
        cache:              {},
        subscriptions_to:   {},
        peer:               null, // will be auto-generated if not set by the user
        db:                 null, // object with read/write/delete methods
        meta_db:            null, // sqlite database for meta storage
        reconnect_delay_ms: 1000,
    }

    // Syncs a local key to a remote URL, forever, across reconnections.
    braid_blob.sync = (local_key, remote_url, params = {}) => {
        assert(typeof local_key === 'string', '.sync: local_key must be string')
        assert(remote_url instanceof URL,     '.sync: remote_url must be URL')

        params = normalize_params(params)

        // Set our peer ID.  Will prevent echoes.
        if (!params.peer) params.peer = Math.random().toString(36).slice(2)

        reconnector(params.signal, (_e, count) => {
            var delay = braid_blob.reconnect_delay_ms ?? Math.min(count, 3) * 1000
            console.log(`disconnected from ${remote_url.href}, retrying in ${delay}ms`)
            return delay
        }, async (signal, handle_error) => {
            if (signal.aborted) return
            if (params.on_pre_connect) await params.on_pre_connect()

            // Remote calls get dont_retry, because sync retries by
            // reconnecting, which redoes the version check below
            var local_params  = {...params, signal}
            var remote_params = {...local_params, dont_retry: true}

            try {
                // Learn the current version for local and remote.  We will
                // subscribe from these (as parents) below.
                var local_version = (await braid_blob.get(local_key, {
                    ...local_params, head: true}))?.version
                if (signal.aborted) return
                var remote_version = (await braid_blob.get(remote_url, {
                    ...remote_params, head: true}))?.version
                if (signal.aborted) return

                // Sync Local -> Remote:
                // - Subscribe to all local changes
                // - For each, send a PUT to the remote.
                await braid_blob.get(local_key, {
                    ...local_params,
                    parents: remote_version,
                    subscribe: async update => {
                        try {
                            if (update.delete) {
                                var res = await braid_blob.delete(remote_url, {
                                    ...remote_params,
                                    repr_type: update.repr_type})
                                if (signal.aborted) return
                                if (!res.ok) handle_error(new Error('failed to delete'))
                            } else {
                                var res = await braid_blob.put(remote_url, update.body, {
                                    ...remote_params,
                                    version: update.version,
                                    repr_type: update.repr_type})
                                if (signal.aborted) return
                                if (res.status === 401 || res.status === 403)
                                    await params.on_unauthorized?.()
                                else if (!res.ok)
                                    handle_error(new Error('failed to PUT: ' + res.status))
                            }
                        } catch (e) { handle_error(e) }
                    }
                })

                // Sync Remote -> Local:
                //  - Subscribe to the remote blob
                //  - Write each remote update to the local blob
                var remote_res = await braid_blob.get(remote_url, {
                    ...remote_params,
                    parents: local_version,
                    subscribe: async update => {
                        try {
                            if (update.delete)
                                await braid_blob.delete(local_key, {
                                    ...local_params,
                                    repr_type: update.repr_type})
                            else
                                await braid_blob.put(local_key, update.body, {
                                    ...local_params,
                                    version: update.version,
                                    repr_type: update.repr_type})
                        } catch (e) { handle_error(e) }
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

            // Advertise range request support
            if (!req.subscribe) res.setHeader("Accept-Ranges", "bytes")

            // Set "no-cache".  This makes etags the only way a browser can
            // reuse a cache, which makes caching more accurate, which goes
            // with our braidly ethos so I'm just making it default behavior
            // here.
            if (!req.subscribe && !res.hasHeader("cache-control"))
                res.setHeader("Cache-Control", "no-cache")

            // We don't do ranges over subscriptions yet
            var range = req.subscribe ? null : parse_range(req.headers.range)

            try {
                var result = await braid_blob.get(params.key, {
                    peer: req.peer,
                    head: req.method === "HEAD",
                    version: req.version,
                    parents: req.parents,
                    if_none_match: etags_to_versions(req.headers['if-none-match']),
                    range,
                    if_range: etags_to_versions(req.headers['if-range']),
                    as_stream: req.method === 'GET' && !req.subscribe,
                    header_cb: (result) => {
                        res.setHeader((req.subscribe ? "Current-" : "") +
                            "Version", version_to_header(result.version))
                        res.setHeader("Version-Type", "wallclockish")
                        if (!req.subscribe && result.version?.length)
                            res.setHeader('ETag', version_to_etag(result.version[0]))
                        if (result.repr_type) {
                            res.setHeader('Repr-Type', result.repr_type)
                            if (!req.subscribe)
                                res.setHeader('Content-Type', result.repr_type)
                        }
                    },
                    before_send_cb: () => res.startSubscription(),
                    subscribe: req.subscribe ? (update) => {
                        if (update.delete) {
                            update.status = 404
                            delete update.delete
                        } else if (update.not_modified)
                            // The client already has this version, so send
                            // a 304 instead of the body
                            update = {
                                status: 304,
                                version: update.version,
                                ETag: version_to_etag(update.version[0]),
                                'Cache-Control': 'no-cache',
                            }
                        // Drop the legacy alias; sendUpdate takes repr_type
                        delete update.content_type
                        update['Merge-Type'] = 'aww'
                        update['Version-Type'] = 'wallclockish'
                        res.sendUpdate(update)
                    } : null
                })
            } catch (e) {
                // Bad Request
                if (e.message && e.message.startsWith('bad request')) {
                    res.statusCode = 400
                    return res.end(e.message.replace(/^bad request: /, ''))
                } else throw e
            }

            // Not Found
            if (!result) {
                res.statusCode = 404
                return res.end('File Not Found')
            }

            // Version Not Found
            if (result.status === 432) {
                res.statusCode = result.status
                res.statusMessage = result.status_text
                res.setHeader("Version-Type", "wallclockish")
                if (result.version)
                    res.setHeader('Version', version_to_header(result.version))
                if (result.parents)
                    res.setHeader('Parents', version_to_header(result.parents))
                return res.end('')
            }

            // Range Not Satisfiable
            if (result.status === 416) {
                res.statusCode = result.status
                res.statusMessage = result.status_text
                res.setHeader('Content-Range',
                    `${range.unit} */${result.repr_length}`)
                return res.end('')
            }

            // Not Acceptable
            if (result.repr_type && req.headers.accept &&
                !isAcceptable(result.repr_type, req.headers.accept)) {
                res.statusCode = 406
                // we opened a stream we won't send
                ;(result.patches?.[0].content ?? result.body)?.destroy?.()
                return res.end(`Content-Type of ${result.repr_type} not in Accept: ${req.headers.accept}`)
            }

            // Not Modified
            if (!req.subscribe && result.not_modified) {
                res.statusCode = 304
                return res.end()
            }

            // Partial Content
            if (result.patches) {
                res.statusCode = 206
                res.statusMessage = 'Partial Content'
                res.setHeader('Content-Range', `${result.patches[0].unit} ` +
                    `${result.patches[0].range}/${result.repr_length}`)
            }

            if (req.method == "HEAD") {
                // A HEAD reports what a GET would send, where res.end('')
                // would say zero
                if (result.repr_length != null)
                    res.setHeader('Content-Length', result.repr_length)
                return res.end('')
            }
            else if (!req.subscribe) {
                var content = result.patches ? result.patches[0].content : result.body
                if (typeof content?.pipe !== 'function') return res.end(content)

                // Node falls back to chunking without an explicit length
                var length = result.repr_length
                if (result.patches) {
                    var [start, end] = result.patches[0].range.split('-').map(Number)
                    length = end - start + 1
                }
                res.setHeader('Content-Length', length)
                return require('stream').pipeline(content, res, (e) => {
                    // No headers left to report an error in; just hang up
                    if (e) res.destroy(e)
                })
            }
            else {
                // If no immediate update was sent,
                // get the node http code to send headers
                if (!result.sent) res.write('\n\n') 
            }
        } else if (req.method === 'PUT') {
            // Handle PUT request to update binary files
            var event = await braid_blob.put(params.key, body, {
                version: req.version,
                repr_type: req.headers['repr-type'] || req.headers['content-type'],
                peer: req.peer
            })
            res.setHeader("Current-Version", version_to_header(event != null ? [event] : []))
            res.setHeader("Version-Type", "wallclockish")
            res.end('')
        } else if (req.method === 'DELETE') {
            await braid_blob.delete(params.key, {
                repr_type: req.headers['repr-type'] || req.headers['content-type'],
                peer: req.peer
            })
            res.end('')
        }
    }

    braid_blob.get = async (key, params = {}) => {
        params = normalize_params(params)

        // A subscription starts from Parents, not Version
        if (params.subscribe && params.version)
            throw new Error('bad request: Version cannot be used with Subscribe')

        // If the key is a URL, then fetch it from remote server!
        if (key instanceof URL) {

            // Do a braid-HTTP GET + Subscribe
            var res = await braid_fetch(key.href, {
                signal: params.signal,
                subscribe: params.subscribe,
                heartbeats: 120,

                // If we have this...          ...the request carries this:
                ...(params.head                && {method: 'HEAD'}),
                ...(params.version != null     && {version: params.version}),
                ...(params.parents != null     && {parents: params.parents}),
                ...(params.peer != null        && {peer: params.peer}),

                // Retry unless the status is a final answer
                ...(!params.dont_retry         && {retry: res =>
                    ![304, 309, 404, 406, 432].includes(res.status)}),

                headers: {
                    ...params.headers,

                    //  if we have this...     ...the headers carry this:
                    ...(params.repr_type       && {'Accept': params.repr_type}),
                    ...((params.version ||
                         params.parents)       && {'Version-Type': 'wallclockish'}),
                    ...(params.if_none_match   && {'If-None-Match':
                        params.if_none_match.map(version_to_etag).join(', ')})
                }
            })

            // ...and its response translates back into our result
            if (!params.subscribe && res.status === 304) {
                var result = { not_modified: true }
                if (res.version) result.version = res.version
                return result
            }

            if (!res.ok)
                if (params.subscribe) throw new Error('failed to subscribe')
                else return null

            var result = {}
            if (res.version) result.version = res.version

            // On a solo response the body is the representation, so its type
            // may come as Repr-Type or (from older servers) Content-Type
            if (!params.subscribe)
                set_repr_type(result, res.headers.get('repr-type')
                                      || res.headers.get('content-type'))

            if (params.head) return result

            if (params.subscribe) {
                var repr_type = res.headers.get('repr-type') || undefined
                res.subscribe(async update => {
                    if (update.status === 404 || update.status === 410)
                        update.delete = true
                    else if (update.status && update.status !== 200)
                        return // e.g. 304: no new state to apply
                    if (update.repr_type) repr_type = update.repr_type
                    set_repr_type(update, repr_type)
                    await params.subscribe(update)
                }, e => params.on_error?.(e))
                return res
            } else {
                result.body = await res.arrayBuffer()
                return result
            }
        }

        // Otherwise the blob is local.
        else {
            // Initialize storage on first use...
            await braid_blob.init()
            if (params.signal?.aborted) return

            // ...and do the rest within this key's fiber, which serializes
            // all operations on the key
            return await within_fiber(key, async () => {
                // Get the current version and content-type from metadata.
                var meta = await get_meta(key)
                if (params.signal?.aborted) return

                // If the blob is missing, we want to return null, which becomes a 404.
                if (!meta.event
                    // But if this is a subscription, we will just wait for the
                    // blob to appear.  A 404 will get sent over the subscription
                    // as the first update.
                    && !params.subscribe)
                    return null

                var result = { version: meta.event ? [meta.event] : [] }
                set_repr_type(result, meta.content_type)

                if (!params.subscribe) {
                    // The spec requires a 432 to echo back the version it
                    // could not satisfy.  We keep no history, so the current
                    // version is the only one we have.  Use compare_events,
                    // since wallclockish versions can differ in trailing zeros.
                    if (params.version &&
                        compare_events(params.version[0], meta.event) !== 0)
                        return {status: 432, status_text: 'Version Not Found',
                                version: params.version}

                    // Only a newer Parents is one we don't have: an older one
                    // is a client catching up
                    if (compare_events(params.parents?.[0], meta.event) > 0)
                        return {status: 432, status_text: 'Version Not Found',
                                parents: params.parents}
                }

                // Set our response headers for hte .serve()
                if (params.header_cb) await params.header_cb(result)
                if (params.signal?.aborted) return

                // Handle etags.
                // If the client tells us (via if_none_match) that it already has this version...
                if (params.if_none_match?.includes(result.version[0]))
                    // Return not_modified and skip the body.  serve() will render a 304.
                    result.not_modified = true

                var db = params.db || braid_blob.db

                // A stale If-Range means the blob changed under the client,
                // which wants the whole thing rather than a slice of it
                var range = params.range
                if (range && params.if_range &&
                    !params.if_range.includes(result.version[0]))
                    range = null

                if (params.head) {
                    if (db.open) {
                        var handle = await db.open(key)
                        if (handle) {
                            result.repr_length = handle.size
                            await handle.close()
                        }
                    }
                    return result
                }

                if (params.subscribe) {
                    // Return subscription
                    var subscribe_chain = Promise.resolve()
                    params.my_subscribe = (x) => subscribe_chain =
                        subscribe_chain.then(() =>
                            !params.signal?.aborted && params.subscribe(x))

                    // Remember this subscription....
                    if (!braid_blob.subscriptions_to[key])
                        braid_blob.subscriptions_to[key] = new Map()

                    var peer = params.peer || Math.random().toString(36).slice(2)
                    braid_blob.subscriptions_to[key].set(peer, {
                        sendUpdate: (update) => {
                            if (update.delete ||
                                // Skip updates it already has
                                compare_events(update.version[0], params.parents?.[0]) > 0)
                                params.my_subscribe(update)
                        }
                    })

                    // ...until it aborts
                    params.signal?.addEventListener('abort', () => {
                        braid_blob.subscriptions_to[key].delete(peer)
                        if (!braid_blob.subscriptions_to[key].size)
                            delete braid_blob.subscriptions_to[key]
                    })

                    if (params.before_send_cb) await params.before_send_cb()
                    if (params.signal?.aborted) return

                    // Send an immediate update if needed
                    if (compare_events(result.version?.[0], params.parents?.[0]) > 0) {
                        result.sent = true
                        if (!result.not_modified)
                            result.body = await db.read(key)
                        params.my_subscribe(result)
                    }
                } else if (!result.not_modified) {
                    // If not subscribe, send the body now.
                    var streaming = params.as_stream && db.open

                    // Ranges resolve against the length, and streams declare
                    // it as Content-Length
                    var handle = null, whole = null, repr_length = null
                    if (range || streaming) {
                        if (db.open) {
                            handle = await db.open(key)
                            repr_length = handle?.size ?? 0
                        } else {
                            whole = await db.read(key)
                            repr_length = whole?.length ?? 0
                        }
                        result.repr_length = repr_length
                    }

                    var offsets = range ? resolve_range(range, repr_length) : null
                    if (range && offsets === null) {
                        await handle?.close()
                        result.status = 416
                        result.status_text = 'Range Not Satisfiable'
                        return result
                    }
                    if (offsets === undefined) offsets = null

                    var content
                    if (streaming && handle) content = handle.stream(offsets)
                    else {
                        await handle?.close()
                        content = whole
                            ? (offsets ? whole.subarray(offsets.start,
                                                        offsets.end + 1) : whole)
                            : await db.read(key, offsets)
                    }

                    // A range answers with patches, fragments scoped by range
                    if (offsets) result.patches = [{unit: range.unit,
                        range: `${offsets.start}-${offsets.end}`, content}]
                    else result.body = content
                }

                return result
            })
        }
    }

    braid_blob.put = async (key, body, params = {}) => {
        params = normalize_params(params)

        // If the key is a URL, this is a braid-HTTP PUT to a remote server
        if (key instanceof URL)
            return await braid_fetch(key.href, {
                method: 'PUT',
                signal: params.signal,
                body,

                //  if we have this...         ...the request carries this:
                ...(!params.dont_retry         && {retry: () => true}),
                ...(params.version != null     && {version: params.version}),
                ...(params.peer != null        && {peer: params.peer}),
                ...(params.repr_type           && {repr_type: params.repr_type}),
                headers: {
                    ...params.headers,
                    ...(params.version         && {'Version-Type': 'wallclockish'})
                }
            })

        // Otherwise we are putting locally
        else {
            // Initialize the blob
            await braid_blob.init()
            if (params.signal?.aborted) return

            // And write to it within a serialized fiber for this key
            return await within_fiber(key, async () => {
                var meta = await get_meta(key)
                if (params.signal?.aborted) return

                // Use the writer's event id, or mint a fresh one, which is
                // newest by construction
                var their_e = params.version ? params.version[0] :
                    create_event(meta.event)

                // The write only wins if it's newer than what we have
                if (compare_events(their_e, meta.event) > 0) {
                    meta.event = their_e

                    if (!params.skip_write)
                        await (params.db || braid_blob.db).write(key, body)
                    if (params.signal?.aborted) return

                    if (params.repr_type)
                        meta.content_type = params.repr_type

                    save_meta(key, meta)
                    if (params.signal?.aborted) return

                    // Notify all subscriptions of the update
                    // (except the peer which made the PUT request itself)
                    var update = { version: [meta.event], body }
                    set_repr_type(update, meta.content_type)
                    if (braid_blob.subscriptions_to[key])
                        for (var [peer, sub] of braid_blob.subscriptions_to[key].entries())
                            if (!params.peer || params.peer !== peer)
                                await sub.sendUpdate(update)
                }

                return meta.event  // the winning event, either way
            })
        }
    }

    braid_blob.delete = async (key, params = {}) => {
        params = normalize_params(params)

        // If the key is a URL, this is a braid-HTTP DELETE to a remote server
        if (key instanceof URL)
            return await braid_fetch(key.href, {
                method: 'DELETE',
                signal: params.signal,

                //  if we have this...         ...the request carries this:
                ...(params.peer != null        && {peer: params.peer}),

                // Retry unless the status is a final answer
                ...(!params.dont_retry         && {retry: res =>
                    ![309, 404, 406, 432].includes(res.status)}),

                headers: {
                    ...params.headers,
                    ...(params.repr_type       && {'Accept': params.repr_type})
                }
            })

        // Else it's a local delete
        else {
            await braid_blob.init()
            if (params.signal?.aborted) return

            return await within_fiber(key, async () => {
                var meta = await get_meta(key)
                if (params.signal?.aborted) return

                // Unlike put, a delete always wins -- it has no version to
                // compare with ours
                await (params.db || braid_blob.db).delete(key)
                await delete_meta(key)

                // Notify all subscriptions of the delete
                // (except the peer which made the DELETE request itself)
                var update = { delete: true }
                set_repr_type(update, meta.content_type)
                if (braid_blob.subscriptions_to[key])
                    for (var [peer, sub] of braid_blob.subscriptions_to[key].entries())
                        if (!params.peer || params.peer !== peer)
                            sub.sendUpdate(update)
            })
        }
    }

    // list() accepts an optional callback to process keys atomically,
    // avoiding races where the set of keys changes between await and processing
    braid_blob.list = async (cb) => {
        await braid_blob.init()
        var keys = braid_blob.meta_db.prepare(`SELECT key FROM meta`).all().map(row => row.key)
        if (cb) cb(keys)
        return keys
    }

    // exists() checks whether a key is present, with an optional callback
    // to process the result atomically (same pattern as list())
    braid_blob.exists = async (key, cb) => {
        await braid_blob.init()
        var exists = !!braid_blob.meta_db.prepare(`SELECT 1 FROM meta WHERE key = ?`).get(key)
        if (cb) cb(exists)
        return exists
    }

    braid_blob.init = async () => {
        // We only want to initialize once
        var init_p = real_init()
        braid_blob.init = () => init_p
        await braid_blob.init()

        async function real_init() {
            var fs = require('fs')

            // Resolve the three folders:
            //  - db_folder holds the blobs (default ./braid-blobs)
            //  - meta_folder holds the sqlite (default: inside db_folder)
            //  - temp_folder holds the in-progress atomic writes (default: inside meta_folder or db_folder)
            var db_was_not_set = !braid_blob.db_folder
            if (db_was_not_set)
                braid_blob.db_folder = './braid-blobs'

            // The db_folder can also be a custom db object
            var get_db_folder = () =>
                // Then anything needing an actual folder falls back to the default
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

            // Delete temp files left by a crash
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

            // Migrate from before 0.0.53, which stored meta as one JSON
            // file per key (defaults: meta in ./braid-blob-meta, blobs in
            // ./braid-blob-db)
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
                    // The whole blob, or just the bytes between the given
                    // start and end offsets, inclusive
                    read: async (key, offsets) => {
                        var file_path = `${braid_blob.db_folder}/${encode_filename(key)}`
                        try {
                            if (!offsets)
                                return await require('fs').promises.readFile(file_path)

                            var file = await require('fs').promises.open(file_path)
                            try {
                                var len = offsets.end - offsets.start + 1
                                var buf = Buffer.allocUnsafe(len)
                                var {bytesRead} = await file.read(buf, 0, len, offsets.start)
                                return bytesRead === len ? buf : buf.subarray(0, bytesRead)
                            } finally { await file.close() }
                        } catch (e) {
                            if (e.code === 'ENOENT') return null
                            throw e
                        }
                    },
                    // Opens the blob for its size and bytes.  Writes replace
                    // the file by rename, so a handle keeps seeing one version.
                    open: async (key) => {
                        var file_path = `${braid_blob.db_folder}/${encode_filename(key)}`
                        try {
                            var file = await require('fs').promises.open(file_path)
                        } catch (e) {
                            if (e.code === 'ENOENT') return null
                            throw e
                        }
                        return {
                            size: (await file.stat()).size,
                            stream: (offsets) => file.createReadStream(
                                offsets && {start: offsets.start, end: offsets.end}),
                            close: () => file.close(),
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

    // A braid-blob etag is a version id, encoded in HTTP's etag syntax:
    function version_to_etag(version_id) {
        return '"' + version_id + '"'
    }

    // Decodes an If-None-Match header into an array of version ids,
    // stripping each etag's quotes and W/ prefix (per RFC 9110,
    // If-None-Match compares weakly, so W/"x" matches "x")
    function etags_to_versions(header) {
        if (!header) return null
        var versions = [], m, re = /(?:W\/)?"([^"]*)"/g
        while ((m = re.exec(header))) versions.push(m[1])
        return versions
    }

    // Decodes a Range header: "bytes=500-600" -> {unit, range}.  The form
    // of the range string is up to the unit.
    function parse_range(header) {
        var m = header?.match(/^\s*([^=\s]+)\s*=\s*(\S.*?)\s*$/)
        return m && {unit: m[1].toLowerCase(), range: m[2]}
    }

    // Resolves a {unit, range} into inclusive start/end offsets.  undefined
    // for a unit or form we don't support, null for one we can't satisfy.
    function resolve_range(range, size) {
        if (range.unit !== 'bytes') return undefined

        // "500-600", "500-" (to the end), or "-500" (the last 500 bytes)
        var m = range.range.match(/^(\d*)-(\d*)$/)
        if (!m || (!m[1] && !m[2])) return undefined
        var first = m[1] ? +m[1] : null, last = m[2] ? +m[2] : null

        if (first == null) return last ? {start: Math.max(0, size - last),
                                          end: size - 1} : null
        if (last != null && last < first) return undefined  // invalid: ignore it
        if (first >= size) return null
        return {start: first, end: last == null ? size - 1
                                                : Math.min(last, size - 1)}
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

    // Encodes a key as a safe, unique filename.  Three hazards:
    //  - Case-insensitive filesystems would collide /foo with /Foo, so we
    //    append a bitmap of each letter's case, in hex
    //  - '/' can't appear in filenames, so we swap it with '!', which can
    //    (swapping, rather than replacing, keeps keys with '!'s distinct)
    //  - Windows forbids some characters and names, so we %-encode those
    function encode_filename(s) {
        // Deal with case insensitivity: compute the case bitmap
        var bits = (s.match(/\p{L}/ug) || []).
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

        // Deal with case insensitivity: append the case bitmap
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

    // Results and updates carry the blob's type as repr_type, plus
    // content_type as a legacy alias
    function set_repr_type(obj, repr_type) {
        if (repr_type)
            obj.repr_type = obj.content_type = repr_type
    }

    function normalize_params(params = {}) {
        if (!normalize_params.special) {
            normalize_params.special = {
                version: 'version',
                parents: 'parents',
                'content-type': 'repr_type',
                'repr-type': 'repr_type',
                accept: 'repr_type',
                peer: 'peer',
                'if-none-match': 'if_none_match',
                range: 'range',
                'if-range': 'if_range',
            }
        }

        var normalized = {}
        Object.assign(normalized, params)

        // Normalize the legacy names accept and content_type to repr_type
        if (params.accept) {
            normalized.repr_type = normalized.repr_type || params.accept
            delete normalized.accept
        }
        if (params.content_type) {
            normalized.repr_type = normalized.repr_type || params.content_type
            delete normalized.content_type
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
                    // And decode etag header values into version ids
                    if (s === 'if_none_match' || s === 'if_range')
                        v = etags_to_versions(v)
                    // And decode the Range header into {unit, range}
                    if (s === 'range')
                        v = parse_range(v)
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
        if (typeof normalized.if_none_match === 'string')
            normalized.if_none_match = [normalized.if_none_match]
        if (typeof normalized.if_range === 'string')
            normalized.if_range = [normalized.if_range]
        
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
