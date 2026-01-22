// Shared test definitions that work in both Node.js and browser environments
// This file exports a function that takes a test runner and braid_fetch implementation

function defineTests(runTest, braid_fetch) {

runTest(
    "test that peer.txt gets initialized on a fresh run",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_id = 'test-db-' + Math.random().toString(36).slice(2)

                var new_bb = braid_blob.create_braid_blob()
                new_bb.db_folder = __dirname + '/' + test_id + '-db'
                new_bb.meta_folder = __dirname + '/' + test_id + '-meta'

                try {
                    await new_bb.serve({}, {})
                } catch (e) {}

                await require('fs').promises.rm(new_bb.db_folder,
                    { recursive: true, force: true })
                await require('fs').promises.rm(new_bb.meta_folder,
                    { recursive: true, force: true })

                res.end(new_bb.peer)

            })()`
        })
        return '' + ((await r1.text()).length > 5)
    },
    'true'
)

runTest(
    "test that peer is different each time we create a new instance",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_id = 'test-db-' + Math.random().toString(36).slice(2)
                var db = __dirname + '/' + test_id + '-db'
                var meta = __dirname + '/' + test_id + '-meta'

                var bb1 = braid_blob.create_braid_blob()
                bb1.db_folder = db
                bb1.meta_folder = meta

                try {
                    await bb1.serve({}, {})
                } catch (e) {}

                var bb2 = braid_blob.create_braid_blob()
                bb2.db_folder = db
                bb2.meta_folder = meta

                try {
                    await bb2.serve({}, {})
                } catch (e) {}

                await require('fs').promises.rm(db, { recursive: true, force: true })
                await require('fs').promises.rm(meta, { recursive: true, force: true })

                res.end('' + (bb1.peer !== bb2.peer))
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test that we can set the peer of a braid_blob object",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_id = 'test-db-' + Math.random().toString(36).slice(2)
                var db = __dirname + '/' + test_id + '-db'
                var meta = __dirname + '/' + test_id + '-meta'

                var bb1 = braid_blob.create_braid_blob()
                bb1.db_folder = db
                bb1.meta_folder = meta
                bb1.peer = 'test_peer'

                try {
                    await bb1.serve({}, {})
                } catch (e) {}

                await require('fs').promises.rm(db, { recursive: true, force: true })
                await require('fs').promises.rm(meta, { recursive: true, force: true })

                res.end(bb1.peer)
            })()`
        })
        return await r1.text()
    },
    'test_peer'
)

runTest(
    "test that manually set peer persists through initialization",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_id = 'test-db-' + Math.random().toString(36).slice(2)
                var db = __dirname + '/' + test_id + '-db'
                var meta = __dirname + '/' + test_id + '-meta'

                // Create instance with manually set peer
                var bb1 = braid_blob.create_braid_blob()
                bb1.db_folder = db
                bb1.meta_folder = meta
                bb1.peer = 'custom-peer-id-123'

                // Initialize (should keep our custom peer)
                await bb1.init()

                var peer_after_init = bb1.peer

                // Clean up
                await require('fs').promises.rm(db, { recursive: true, force: true })
                await require('fs').promises.rm(meta, { recursive: true, force: true })

                res.end(peer_after_init === 'custom-peer-id-123' ? 'true' : 'false: ' + peer_after_init)
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test that PUTing with shorter event id doesn't do anything.",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['11.0'],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['9.0'],
            body: 'abc'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`)
        return await r.text()
    },
    'xyz'
)

runTest(
    "test that we ignore stuff after the ? in a url",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}?blah`, {
            method: 'PUT',
            version: ['11'],
            body: 'yo!'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`)
        return await r.text()
    },
    'yo!'
)

runTest(
    "test that we ignore stuff after the # in a url",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}#blah?bloop`, {
            method: 'PUT',
            version: ['11'],
            body: 'hi!'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`)
        return await r.text()
    },
    'hi!'
)

runTest(
    "test send an update to another peer",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {'Content-Type': 'text/plain'},
            version: ['1'],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            peer: key
        })

        var p = new Promise(done => {
            r.subscribe(update => {
                if (update.version?.[0] !== '2') return
                done(update.body_text)
                a.abort()
            })
        })

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {'Content-Type': 'text/plain'},
            version: ['2'],
            body: 'abc'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        return await p
    },
    'abc'
)

runTest(
    "test having multiple subs",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        var key2 = 'test2-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {'Content-Type': 'text/plain'},
            version: ['1'],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            peer: key
        })

        var p = new Promise(done => {
            r.subscribe(update => {

                console.log(`p1 update = `, update)

                if (update.version?.[0] !== '2') return
                done(update.body_text)
            }, (e) => {
                console.log(`yooo`, e)
            })
        })

        var r = await braid_fetch(`/${key2}`, {
            method: 'PUT',
            headers: {'Content-Type': 'text/plain'},
            version: ['1'],
            body: 'xyz2'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        var r = await braid_fetch(`/${key2}`, {
            signal: a.signal,
            subscribe: true,
            peer: key2
        })

        var p2 = new Promise(done => {
            r.subscribe(update => {

                console.log(`p2 update = `, update)

                if (update.version?.[0] !== '2') return
                done(update.body_text)
            }, e => {
                                console.log(`yooo`, e)

            })
        })

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {'Content-Type': 'text/plain'},
            version: ['2'],
            body: 'abc'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key2}`, {
            method: 'PUT',
            headers: {'Content-Type': 'text/plain'},
            version: ['2'],
            body: 'abc2'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var ret = await Promise.all([p, p2])
        a.abort()
        return 'got: ' + ret

    },
    'got: abc,abc2'
)

runTest(
    "test getting a 406",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {'Content-Type': 'text/plain'},
            version: ['1'],
            parents: [],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`, {
            headers: {Accept: 'text/html'}
        })
        return r.status + ' ' + await r.text()
    },
    '406 Content-Type of text/plain not in Accept: text/html'
)

runTest(
    "test deleting something",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['1'],
            parents: [],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`, {
            method: 'DELETE',
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`)
        return r.status
    },
    '404'
)

runTest(
    "test deleting something that doesn't exist",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'DELETE',
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        return r.status
    },
    '200'
)

runTest(
    "test braid_blob.delete() directly",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_id = 'test-db-' + Math.random().toString(36).slice(2)
                var db_folder = __dirname + '/' + test_id + '-db'
                var meta_folder = __dirname + '/' + test_id + '-meta'

                var bb = braid_blob.create_braid_blob()
                bb.db_folder = db_folder
                bb.meta_folder = meta_folder

                try {
                    // Put a file
                    await bb.put('/test-file', Buffer.from('hello'))

                    // Verify it exists
                    var result = await bb.get('/test-file')
                    if (!result || !result.body) {
                        res.end('error: file not found after put')
                        return
                    }

                    // Delete it
                    await bb.delete('/test-file')

                    // Verify it's gone
                    var result2 = await bb.get('/test-file')
                    if (result2) {
                        res.end('error: file still exists after delete')
                        return
                    }

                    res.end('true')
                } catch (e) {
                    res.end('error: ' + e.message)
                } finally {
                    await require('fs').promises.rm(db_folder, { recursive: true, force: true })
                    await require('fs').promises.rm(meta_folder, { recursive: true, force: true })
                }
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test that aborting cleans up subscription",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_id = '/test-' + Math.random().toString(36).slice(2)

                // Put a file
                await braid_blob.put(test_id, 'hello')

                // Subscribe to it
                var got_update = false
                var ac = new AbortController()
                await braid_blob.get(test_id, {
                    signal: ac.signal,
                    subscribe: (update) => { got_update = true }
                })

                // Verify subscription exists
                var has_sub_before = !!braid_blob.key_to_subs[test_id]

                await new Promise(done => setTimeout(done, 30))
                ac.abort()
                await new Promise(done => setTimeout(done, 30))

                // Verify subscription is cleaned up
                var has_sub_after = !!braid_blob.key_to_subs[test_id]

                res.end('' + (has_sub_before && !has_sub_after))
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test that subscribe returns current-version header",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['1'],
            parents: [],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true
        })
        a.abort()
        return r.headers.get('current-version')
    },
    '"1"'
)

runTest(
    "test that subscribe returns version as string-number in array",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['1'],
            parents: [],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true
        })

        var x = await new Promise(done => {
            r.subscribe(update => {
                done(update.version)
            })
        })

        a.abort()
        return JSON.stringify(x)
    },
    '["1"]'
)

runTest(
    "test that subscribe's update's versions are string-number in array",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['4'],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            parents: ['0']
        })

        var p = new Promise(done => {
            r.subscribe(update => {
                done(update.version)
            })
        })

        var ret = await p
        a.abort()
        return JSON.stringify(ret)
    },
    '["4"]'
)

runTest(
    "test that non-subscribe returns version header",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['2'],
            parents: [],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`)
        return r.headers.get('version')
    },
    '"2"'
)

runTest(
    "test that subscribe sends no version if parents is big enough.",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['3'],
            parents: [],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            parents: ['3']
        })

        var received_update = false
        var promise_a = new Promise(done => {
            r.subscribe(async (update) => {
                received_update = true
                done()
            })
        })

        var promise_b = new Promise(done => setTimeout(done, 300))

        await Promise.race([promise_a, promise_b])
        a.abort()

        return '' + received_update
    },
    'false'
)

runTest(
    "test that we get 404 when file doesn't exist, on GET without subscribe.",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`)

        return `${r.status}`
    },
    '404'
)

runTest(
    "test second subscription to same key",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['3'],
            parents: [],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            parents: ['3']
        })

        var a2 = new AbortController()
        var r2 = await braid_fetch(`/${key}`, {
            signal: a2.signal,
            subscribe: true,
            parents: ['2']
        })

        var body = await new Promise(done => {
            r2.subscribe((update) => done(update.body_text))
        })

        a.abort()
        a2.abort()
        return body
    },
    'xyz'
)

runTest(
    "test PUTing when server already has blob",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['3'],
            parents: [],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['4'],
            parents: [],
            body: 'XYZ'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        return await (await braid_fetch(`/${key}`)).text()
    },
    'XYZ'
)

runTest(
    "test PUTing when server has newer version",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['3'],
            parents: [],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['2'],
            parents: [],
            body: 'XYZ'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        return r.headers.get('current-version')
    },
    '"3"'
)

runTest(
    "test that version we get back is the version we set",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['1760077018883'],
            parents: [],
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var r = await braid_fetch(`/${key}`)
        return r.headers.get('version')
    },
    '"1760077018883"'
)

runTest(
    "test that subscribe gets back editable:true.",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            body: 'xyz'
        })
        if (!r.ok) throw 'got: ' + r.statusCode

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            parents: ['3']
        })

        var ret = r.headers.get('editable')
        a.abort()
        return '' + ret
    },
    'true'
)

runTest(
    "test that we can override editable on the server.",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            subscribe: true,
            body: `void (async () => {
                req.method = 'GET'
                res.setHeader('editable', 'false')
                braid_blob.serve(req, res, {key: ':test'})
            })()`
        })
        return r1.headers.get('editable')

    },
    'false'
)

runTest(
    "test that meta filenames distinguish between 'a' and 'A' on case-insensitive filesystems",
    async () => {
        var suffix = Math.random().toString(36).slice(2)
        var key1 = 'test-' + suffix + '-a'
        var key2 = 'test-' + suffix + '-A'

        // PUT to lowercase key with version 100
        var r = await braid_fetch(`/${key1}`, {
            method: 'PUT',
            version: ['100'],
            body: 'lowercase content'
        })
        if (!r.ok) throw 'PUT to lowercase key failed: ' + r.status

        // PUT to uppercase key with version 200
        var r = await braid_fetch(`/${key2}`, {
            method: 'PUT',
            version: ['200'],
            body: 'uppercase content'
        })
        if (!r.ok) throw 'PUT to uppercase key failed: ' + r.status

        // GET both and verify they have different versions (stored in meta files)
        var r1 = await braid_fetch(`/${key1}`)
        if (!r1.ok) throw 'GET lowercase key failed: ' + r1.status
        var version1 = r1.headers.get('version')

        var r2 = await braid_fetch(`/${key2}`)
        if (!r2.ok) throw 'GET uppercase key failed: ' + r2.status
        var version2 = r2.headers.get('version')

        return version1 + '|' + version2
    },
    '"100"|"200"'
)

runTest(
    "test put with URL (no content_type)",
    async () => {
        var key = 'test-url-put-' + Math.random().toString(36).slice(2)

        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var braid_blob = require(\`\${__dirname}/../index.js\`)
                var url = new URL('http://localhost:' + req.socket.localPort + '/${key}')
                await braid_blob.put(url, Buffer.from('url put test'), { version: ['100'] })
                res.end('done')
            })()`
        })
        await r1.text()

        var r = await braid_fetch(`/${key}`)
        return await r.text()
    },
    'url put test'
)

runTest(
    "test put with URL (with content_type)",
    async () => {
        var key = 'test-url-put-ct-' + Math.random().toString(36).slice(2)

        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var braid_blob = require(\`\${__dirname}/../index.js\`)
                var url = new URL('http://localhost:' + req.socket.localPort + '/${key}')
                await braid_blob.put(url, Buffer.from('url put with ct'), {
                    version: ['200'],
                    content_type: 'text/plain'
                })
                res.end('done')
            })()`
        })
        await r1.text()

        var r = await braid_fetch(`/${key}`)
        return r.headers.get('content-type') + '|' + await r.text()
    },
    'text/plain|url put with ct'
)

runTest(
    "test get with URL (no subscribe)",
    async () => {
        var key = 'test-url-get-' + Math.random().toString(36).slice(2)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['300'],
            body: 'url get test'
        })

        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var braid_blob = require(\`\${__dirname}/../index.js\`)
                var url = new URL('http://localhost:' + req.socket.localPort + '/${key}')
                var result = await braid_blob.get(url)
                res.end(Buffer.from(result.body).toString('utf8'))
            })()`
        })

        return await r1.text()
    },
    'url get test'
)

runTest(
    "test get with URL (with subscribe)",
    async () => {
        var key = 'test-url-get-sub-' + Math.random().toString(36).slice(2)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['400'],
            body: 'initial'
        })

        // Use a promise to wait for the eval to complete
        var evalPromise = braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var braid_blob = require(\`\${__dirname}/../index.js\`)
                var url = new URL('http://localhost:' + req.socket.localPort + '/${key}')

                var updates = []
                var a = new AbortController()

                // Don't await - braid_blob.get returns immediately when subscribe is used
                braid_blob.get(url, {
                    subscribe: update => {
                        updates.push(Buffer.from(update.body).toString('utf8'))
                        if (updates.length === 2) {
                            a.abort()
                            res.end(updates.join('|'))
                        }
                    },
                    signal: a.signal
                })
            })()`
        })

        // Wait a bit for subscription to be established
        await new Promise(done => setTimeout(done, 100))

        // Send update
        await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['500'],
            body: 'updated'
        })

        // Wait for the eval to complete
        var r1 = await evalPromise
        return await r1.text()
    },
    'initial|updated'
)

runTest(
    "test sync local to remote",
    async () => {
        var local_key = 'test-sync-local-' + Math.random().toString(36).slice(2)
        var remote_key = 'test-sync-remote-' + Math.random().toString(36).slice(2)

        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                try {
                    var braid_blob = require(\`\${__dirname}/../index.js\`)

                    // Put something locally first
                    await braid_blob.put('${local_key}', Buffer.from('local content'), { version: ['600'] })

                    var remote_url = new URL('http://localhost:' + req.socket.localPort + '/${remote_key}')

                    // Start sync
                    braid_blob.sync('${local_key}', remote_url)

                    res.end('syncing')
                } catch (e) {
                    res.end('error: ' + e.message + ' ' + e.stack)
                }
            })()`
        })
        var result = await r1.text()
        if (result.startsWith('error:')) return result

        // Wait a bit for sync to happen
        await new Promise(done => setTimeout(done, 100))

        // Check remote has the content
        var r = await braid_fetch(`/${remote_key}`)
        return await r.text()
    },
    'local content'
)

runTest(
    "test sync two local keys throws error",
    async () => {
        var key1 = '/test-sync-local1-' + Math.random().toString(36).slice(2)
        var key2 = '/test-sync-local2-' + Math.random().toString(36).slice(2)

        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                try {
                    var braid_blob = require(\`\${__dirname}/../index.js\`)

                    // Try to sync between two local keys - should throw
                    braid_blob.sync('${key1}', '${key2}')

                    res.end('no error thrown')
                } catch (e) {
                    res.end('error thrown')
                }
            })()`
        })
        return await r1.text()
    },
    'error thrown'
)

runTest(
    "test sync remote to local (swap)",
    async () => {
        var local_key = '/test-sync-swap-local-' + Math.random().toString(36).slice(2)
        var remote_key = '/test-sync-swap-remote-' + Math.random().toString(36).slice(2)

        // Put something on the server first
        await braid_fetch(`${remote_key}`, {
            method: 'PUT',
            version: ['800'],
            body: 'remote content'
        })

        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                try {
                    var remote_url = new URL('http://localhost:' + port + '${remote_key}')

                    // Start sync with URL as first argument (should swap internally)
                    braid_blob.sync(remote_url, '${local_key}')

                    res.end('syncing')
                } catch (e) {
                    res.end('error: ' + e.message + ' ' + e.stack)
                }
            })()`
        })
        var result = await r1.text()
        if (result.startsWith('error:')) return result

        // Wait a bit for sync to happen
        await new Promise(done => setTimeout(done, 100))

        // Check local key has the remote content
        var r = await braid_fetch(`${local_key}`)
        return await r.text()
    },
    'remote content'
)

runTest(
    "test sync when server already has our version",
    async () => {
        var local_key = 'test-sync-has-version-local-' + Math.random().toString(36).slice(2)
        var remote_key = 'test-sync-has-version-remote-' + Math.random().toString(36).slice(2)

        // Put the same content on both local and remote with the same version
        var version = ['900']
        var content = 'shared content'

        // Put on remote first
        await braid_fetch(`/${remote_key}`, {
            method: 'PUT',
            version: version,
            body: content
        })

        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                try {
                    var braid_blob = require(\`\${__dirname}/../index.js\`)

                    // Put the same content locally with the same version
                    await braid_blob.put('${local_key}', Buffer.from('${content}'), { version: ${JSON.stringify(version)} })

                    var remote_url = new URL('http://localhost:' + req.socket.localPort + '/${remote_key}')

                    // Start sync - this should trigger the "server already has our version" path
                    braid_blob.sync('${local_key}', remote_url)

                    res.end('syncing')
                } catch (e) {
                    res.end('error: ' + e.message + ' ' + e.stack)
                }
            })()`
        })
        var result = await r1.text()
        if (result.startsWith('error:')) return result

        // Wait a bit for sync to initialize (the console.log should happen quickly)
        await new Promise(done => setTimeout(done, 100))

        // Verify that both still have the same content
        var r = await braid_fetch(`/${remote_key}`)
        return await r.text()
    },
    'shared content'
)

runTest(
    "test sync connect does not read file body for version check",
    async () => {
        var local_key = '/test-sync-no-read-' + Math.random().toString(36).slice(2)
        var remote_key = 'test-sync-no-read-remote-' + Math.random().toString(36).slice(2)

        // Put something on remote with SAME version as local, so no data needs to flow
        var put_result = await braid_fetch(`/${remote_key}`, {
            method: 'PUT',
            version: ['same-version-123'],
            body: 'same content'
        })
        if (!put_result.ok) return 'PUT status: ' + put_result.status

        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                try {
                    // Put locally with SAME version - so when sync connects, no updates need to flow
                    await braid_blob.put('${local_key}', 'same content', { version: ['same-version-123'] })

                    // Wrap db.read to count calls for our specific key
                    var read_count = 0
                    var original_read = braid_blob.db.read
                    braid_blob.db.read = async function(key) {
                        if (key === '${local_key}') read_count++
                        return original_read.call(this, key)
                    }

                    var remote_url = new URL('http://localhost:' + port + '/${remote_key}')

                    // Create an AbortController to stop the sync
                    var ac = new AbortController()

                    // Start sync - since both have same version, no updates should flow
                    braid_blob.sync('${local_key}', remote_url, { signal: ac.signal })

                    // Wait for sync to establish connection
                    await new Promise(done => setTimeout(done, 300))

                    // Stop sync
                    ac.abort()

                    // Restore original read
                    braid_blob.db.read = original_read

                    // db.read should not have been called since:
                    // 1. Initial version check uses head:true (no body read)
                    // 2. Both have same version so no updates flow
                    res.end(read_count === 0 ? 'no reads' : 'reads: ' + read_count)
                } catch (e) {
                    res.end('error: ' + e.message + ' ' + e.stack)
                }
            })()`
        })
        return await r1.text()
    },
    'no reads'
)

runTest(
    "test sync closed during error",
    async () => {
        var local_key = 'test-sync-closed-local-' + Math.random().toString(36).slice(2)
        var remote_key = 'test-sync-closed-remote-' + Math.random().toString(36).slice(2)

        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                try {
                    var braid_blob = require(\`\${__dirname}/../index.js\`)

                    // Use an invalid/unreachable URL to trigger an error
                    var remote_url = new URL('http://localhost:9999/${remote_key}')

                    // Create an AbortController to stop the sync
                    var ac = new AbortController()

                    // Start sync with signal
                    braid_blob.sync('${local_key}', remote_url, { signal: ac.signal })

                    // Close the sync immediately to trigger the closed path when error occurs
                    ac.abort()

                    res.end('sync started and closed')
                } catch (e) {
                    res.end('error: ' + e.message + ' ' + e.stack)
                }
            })()`
        })
        var result = await r1.text()
        if (result.startsWith('error:')) return result

        // Wait for the connection error and closed message
        await new Promise(done => setTimeout(done, 200))

        return result
    },
    'sync started and closed'
)

runTest(
    "test sync error with retry",
    async () => {
        var local_key = 'test-sync-retry-local-' + Math.random().toString(36).slice(2)
        var remote_key = 'test-sync-retry-remote-' + Math.random().toString(36).slice(2)

        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                try {
                    var braid_blob = require(\`\${__dirname}/../index.js\`)

                    // Use an invalid/unreachable URL to trigger an error
                    var remote_url = new URL('http://localhost:9999/${remote_key}')

                    // Create an AbortController to stop the sync
                    var ac = new AbortController()

                    // Start sync with signal - should trigger retry on error
                    braid_blob.sync('${local_key}', remote_url, { signal: ac.signal })

                    // Wait a bit for the error to occur and retry message to print
                    await new Promise(done => setTimeout(done, 200))

                    // Now close it to stop retrying
                    ac.abort()

                    res.end('sync error occurred')
                } catch (e) {
                    res.end('error: ' + e.message + ' ' + e.stack)
                }
            })()`
        })
        var result = await r1.text()

        return result
    },
    'sync error occurred'
)

runTest(
    "test requesting with version/parents server doesn't have",
    async () => {
        var key = 'test-parents-unknown-' + Math.random().toString(36).slice(2)

        // Put with version 100
        await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['100'],
            body: 'content v100'
        })

        // Try to subscribe with parents 200 (newer than what server has)
        // This triggers the "unknown version" error which gets caught and returns 309
        var r = await braid_fetch(`/${key}`, {
            parents: ['200']
        })

        return r.status
    },
    '309'
)

runTest(
    "test requesting specific version server doesn't have",
    async () => {
        var key = 'test-version-unknown-' + Math.random().toString(36).slice(2)

        // Put with version 100
        await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['100'],
            body: 'content v100'
        })

        // Try to GET with version 200 (newer than what server has)
        // This should trigger line 269 when req.version is checked
        var r = await braid_fetch(`/${key}`, {
            version: ['200']
        })

        return r.status
    },
    '309'
)

runTest(
    "test multiple writes preserve correct mtime across restarts",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var fs = require('fs').promises
                var test_id = 'test-multi-write-' + Math.random().toString(36).slice(2)
                var db_folder = __dirname + '/' + test_id + '-db'
                var meta_folder = __dirname + '/' + test_id + '-meta'
                var test_key = 'test-file'

                try {
                    // Create first braid_blob instance
                    var bb1 = braid_blob.create_braid_blob()
                    bb1.db_folder = db_folder
                    bb1.meta_folder = meta_folder

                    // First write
                    await bb1.put(test_key, Buffer.from('content1'), {
                        version: ['version-1']
                    })

                    // Wait a bit to ensure different mtime
                    await new Promise(resolve => setTimeout(resolve, 50))

                    // Second write to same file (this is where the bug would occur)
                    await bb1.put(test_key, Buffer.from('content2'), {
                        version: ['version-2']
                    })

                    var result1 = await bb1.get(test_key)

                    // Now restart and check
                    var bb2 = braid_blob.create_braid_blob()
                    bb2.db_folder = db_folder
                    bb2.meta_folder = meta_folder

                    // Get the file from the new instance
                    var result2 = await bb2.get(test_key)

                    // Version should still be version-2, not regenerated
                    var correct_version = (result2.version[0] === 'version-2')
                    var content_correct = (result2.body.toString() === 'content2')

                    // Clean up
                    await fs.rm(db_folder, { recursive: true, force: true })
                    await fs.rm(meta_folder, { recursive: true, force: true })

                    res.end(correct_version && content_correct ? 'true' :
                            'false: version=' + result2.version[0] + ', content=' + result2.body.toString())
                } catch (e) {
                    // Clean up even on error
                    await fs.rm(db_folder, { recursive: true, force: true })
                    await fs.rm(meta_folder, { recursive: true, force: true })
                    res.end('error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test that files keep same event ID across restarts when not edited",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var fs = require('fs').promises
                var test_id = 'test-persist-event-' + Math.random().toString(36).slice(2)
                var db_folder = __dirname + '/' + test_id + '-db'
                var meta_folder = __dirname + '/' + test_id + '-meta'
                var test_key = 'test-file'
                var test_content = 'test content that should not change'

                try {
                    // Create first braid_blob instance
                    var bb1 = braid_blob.create_braid_blob()
                    bb1.db_folder = db_folder
                    bb1.meta_folder = meta_folder

                    // Put a file with specific version
                    var version1 = await bb1.put(test_key, Buffer.from(test_content), {
                        version: ['test-peer-123456']
                    })

                    // Get the file to verify it has the expected version
                    var result1 = await bb1.get(test_key)

                    // Close the first instance's db
                    bb1.meta_db.close()

                    // Wait a bit to ensure file system has settled
                    await new Promise(resolve => setTimeout(resolve, 100))

                    // Now create a second braid_blob instance with the same folders
                    // This simulates a restart
                    var bb2 = braid_blob.create_braid_blob()
                    bb2.db_folder = db_folder
                    bb2.meta_folder = meta_folder

                    // Initialize bb2 by doing a get (this triggers init)
                    var result2 = await bb2.get(test_key)

                    // The version should be the same - no new event ID generated
                    var versions_match = (result1.version[0] === result2.version[0])
                    var both_have_expected = (result1.version[0] === 'test-peer-123456')

                    // Clean up
                    bb2.meta_db.close()
                    await fs.rm(db_folder, { recursive: true, force: true })
                    await fs.rm(meta_folder, { recursive: true, force: true })

                    res.end(versions_match && both_have_expected ? 'true' :
                            'false: v1=' + result1.version[0] + ', v2=' + result2.version[0])
                } catch (e) {
                    // Clean up even on error
                    await fs.rm(db_folder, { recursive: true, force: true })
                    await fs.rm(meta_folder, { recursive: true, force: true })
                    res.end('error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test get with URL returns null on 404",
    async () => {
        var key = 'test-url-get-404-' + Math.random().toString(36).slice(2)

        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var braid_blob = require(\`\${__dirname}/../index.js\`)
                var url = new URL('http://localhost:' + req.socket.localPort + '/${key}')
                var result = await braid_blob.get(url)
                res.end(result === null ? 'null' : 'not null: ' + JSON.stringify(result))
            })()`
        })

        return await r1.text()
    },
    'null'
)

runTest(
    "test signal abort stops local put operation",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var fs = require('fs').promises
                var test_id = 'test-abort-put-' + Math.random().toString(36).slice(2)
                var db_folder = __dirname + '/' + test_id + '-db'
                var meta_folder = __dirname + '/' + test_id + '-meta'

                try {
                    var bb = braid_blob.create_braid_blob()
                    bb.db_folder = db_folder
                    bb.meta_folder = meta_folder

                    // Create an already-aborted signal
                    var ac = new AbortController()
                    ac.abort()

                    // Try to put with aborted signal
                    var result = await bb.put('/test-file', Buffer.from('hello'), {
                        signal: ac.signal
                    })

                    // Result should be undefined since operation was aborted
                    res.end(result === undefined ? 'aborted' : 'not aborted: ' + result)
                } catch (e) {
                    res.end('error: ' + e.message)
                } finally {
                    await fs.rm(db_folder, { recursive: true, force: true })
                    await fs.rm(meta_folder, { recursive: true, force: true })
                }
            })()`
        })
        return await r1.text()
    },
    'aborted'
)

runTest(
    "test signal abort stops local get operation",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_id = '/test-abort-get-' + Math.random().toString(36).slice(2)

                // Put a file first
                await braid_blob.put(test_id, 'hello', { version: ['1'] })

                // Create an already-aborted signal
                var ac = new AbortController()
                ac.abort()

                // Try to get with aborted signal (after header_cb)
                var result = await braid_blob.get(test_id, {
                    signal: ac.signal,
                })

                // Result should be undefined since operation was aborted already
                res.end(result === undefined ? 'aborted' : 'not aborted')
            })()`
        })
        return await r1.text()
    },
    'aborted'
)

runTest(
    "test signal abort stops local delete operation",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var fs = require('fs').promises
                var test_id = 'test-abort-delete-' + Math.random().toString(36).slice(2)
                var db_folder = __dirname + '/' + test_id + '-db'
                var meta_folder = __dirname + '/' + test_id + '-meta'

                try {
                    var bb = braid_blob.create_braid_blob()
                    bb.db_folder = db_folder
                    bb.meta_folder = meta_folder

                    // Put a file first
                    await bb.put('/test-file', Buffer.from('hello'), { version: ['1'] })

                    // Create an already-aborted signal
                    var ac = new AbortController()
                    ac.abort()

                    // Try to delete with aborted signal
                    await bb.delete('/test-file', { signal: ac.signal })

                    // File should still exist since delete was aborted
                    var result = await bb.get('/test-file')
                    res.end(result && result.body ? 'still exists' : 'deleted')
                } catch (e) {
                    res.end('error: ' + e.message)
                } finally {
                    await fs.rm(db_folder, { recursive: true, force: true })
                    await fs.rm(meta_folder, { recursive: true, force: true })
                }
            })()`
        })
        return await r1.text()
    },
    'still exists'
)

runTest(
    "test signal abort stops subscription updates",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var fs = require('fs').promises
                var test_id = 'test-abort-sub-' + Math.random().toString(36).slice(2)
                var db_folder = __dirname + '/' + test_id + '-db'
                var meta_folder = __dirname + '/' + test_id + '-meta'

                try {
                    var bb = braid_blob.create_braid_blob()
                    bb.db_folder = db_folder
                    bb.meta_folder = meta_folder

                    // Put a file first
                    await bb.put('/test-file', Buffer.from('v1'), { version: ['1'] })

                    // Subscribe with an AbortController
                    var ac = new AbortController()
                    var updates = []

                    await bb.get('/test-file', {
                        signal: ac.signal,
                        subscribe: (update) => {
                            updates.push(update.body.toString())
                        }
                    })

                    // Should have received initial update
                    if (updates.length !== 1 || updates[0] !== 'v1') {
                        res.end('initial update wrong: ' + JSON.stringify(updates))
                        return
                    }

                    // Abort the subscription
                    ac.abort()

                    // Put another update
                    await bb.put('/test-file', Buffer.from('v2'), { version: ['2'] })

                    // Wait a bit for any updates to propagate
                    await new Promise(done => setTimeout(done, 50))

                    // Should still only have the initial update
                    res.end(updates.length === 1 ? 'stopped' : 'got extra: ' + JSON.stringify(updates))
                } catch (e) {
                    res.end('error: ' + e.message)
                } finally {
                    await fs.rm(db_folder, { recursive: true, force: true })
                    await fs.rm(meta_folder, { recursive: true, force: true })
                }
            })()`
        })
        return await r1.text()
    },
    'stopped'
)

runTest(
    "test options.db in put writes to custom db",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-custom-db-put-' + Math.random().toString(36).slice(2)

                // Create a simple in-memory db
                var custom_storage = {}
                var custom_db = {
                    read: async (key) => custom_storage[key] || null,
                    write: async (key, data) => { custom_storage[key] = data },
                    delete: async (key) => { delete custom_storage[key] }
                }

                // Put using the custom db
                await braid_blob.put(test_key, Buffer.from('custom db content'), {
                    version: ['100'],
                    db: custom_db
                })

                // Verify content is in custom db
                var custom_content = await custom_db.read(test_key)
                var custom_ok = custom_content && custom_content.toString() === 'custom db content'

                // Verify content is NOT in the default db
                var default_content = await braid_blob.db.read(test_key)
                var default_empty = default_content === null

                res.end(custom_ok && default_empty ? 'true' :
                    'custom_ok=' + custom_ok + ', default_empty=' + default_empty)
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test options.db in get reads from custom db",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-custom-db-get-' + Math.random().toString(36).slice(2)

                // Create a simple in-memory db with some content
                var custom_storage = {}
                custom_storage[test_key] = Buffer.from('from custom db')
                var custom_db = {
                    read: async (key) => custom_storage[key] || null,
                    write: async (key, data) => { custom_storage[key] = data },
                    delete: async (key) => { delete custom_storage[key] }
                }

                // Put with skip_write to just create meta
                await braid_blob.put(test_key, Buffer.from('ignored'), {
                    version: ['200'],
                    skip_write: true
                })

                // Get using the custom db - should read from custom db
                var result = await braid_blob.get(test_key, { db: custom_db })

                res.end(result && result.body.toString() === 'from custom db' ? 'true' :
                    'got: ' + (result ? result.body.toString() : 'null'))
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test options.db in delete deletes from custom db",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-custom-db-delete-' + Math.random().toString(36).slice(2)

                // Create a simple in-memory db
                var custom_storage = {}
                custom_storage[test_key] = Buffer.from('custom content')
                var custom_db = {
                    read: async (key) => custom_storage[key] || null,
                    write: async (key, data) => { custom_storage[key] = data },
                    delete: async (key) => { delete custom_storage[key] }
                }

                // Also put to default db
                await braid_blob.put(test_key, Buffer.from('default content'), {
                    version: ['300']
                })

                // Delete using custom db - should only delete from custom db
                await braid_blob.delete(test_key, { db: custom_db })

                // Verify custom db content is gone
                var custom_content = await custom_db.read(test_key)
                var custom_deleted = custom_content === null

                // Verify default db content still exists
                var default_content = await braid_blob.db.read(test_key)
                var default_exists = default_content && default_content.toString() === 'default content'

                res.end(custom_deleted && default_exists ? 'true' :
                    'custom_deleted=' + custom_deleted + ', default_exists=' + default_exists)
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test options.db in get subscribe uses custom db for initial update",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-custom-db-sub-' + Math.random().toString(36).slice(2)

                // Create a simple in-memory db with content
                var custom_storage = {}
                custom_storage[test_key] = Buffer.from('subscribe custom content')
                var custom_db = {
                    read: async (key) => custom_storage[key] || null,
                    write: async (key, data) => { custom_storage[key] = data },
                    delete: async (key) => { delete custom_storage[key] }
                }

                // Create meta with version using skip_write
                await braid_blob.put(test_key, Buffer.from('ignored'), {
                    version: ['400'],
                    skip_write: true
                })

                // Subscribe using custom db - initial update should come from custom db
                var ac = new AbortController()
                var received_content = null

                await braid_blob.get(test_key, {
                    db: custom_db,
                    signal: ac.signal,
                    subscribe: (update) => {
                        received_content = update.body.toString()
                    }
                })

                // Wait for update
                await new Promise(done => setTimeout(done, 50))
                ac.abort()

                res.end(received_content === 'subscribe custom content' ? 'true' :
                    'got: ' + received_content)
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test atomic write creates temp_folder on init",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var fs = require('fs').promises
                var test_id = 'test-atomic-init-' + Math.random().toString(36).slice(2)
                var db_folder = __dirname + '/' + test_id + '-db'
                var meta_folder = __dirname + '/' + test_id + '-meta'

                try {
                    var bb = braid_blob.create_braid_blob()
                    bb.db_folder = db_folder
                    bb.meta_folder = meta_folder

                    // Initialize
                    await bb.init()

                    // Check that temp_folder is set to meta_folder (no /temp subdirectory anymore)
                    var temp_folder_correct = bb.temp_folder === meta_folder

                    res.end(temp_folder_correct ? 'true' : 'temp_folder is ' + bb.temp_folder)
                } catch (e) {
                    res.end('error: ' + e.message)
                } finally {
                    bb.meta_db.close()
                    await fs.rm(db_folder, { recursive: true, force: true })
                    await fs.rm(meta_folder, { recursive: true, force: true })
                }
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test atomic write leaves no temp files after successful write",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var fs = require('fs').promises
                var test_id = 'test-atomic-cleanup-' + Math.random().toString(36).slice(2)
                var db_folder = __dirname + '/' + test_id + '-db'
                var meta_folder = __dirname + '/' + test_id + '-meta'

                try {
                    var bb = braid_blob.create_braid_blob()
                    bb.db_folder = db_folder
                    bb.meta_folder = meta_folder

                    // Do a write
                    await bb.put('/test-file', Buffer.from('hello'), { version: ['1'] })

                    // Check that no temp_ files remain in temp_folder
                    var files = await fs.readdir(bb.temp_folder)
                    var temp_files = files.filter(f => f.startsWith('temp_'))

                    res.end(temp_files.length === 0 ? 'true' : 'leftover files: ' + temp_files.join(', '))
                } catch (e) {
                    res.end('error: ' + e.message)
                } finally {
                    bb.meta_db.close()
                    await fs.rm(db_folder, { recursive: true, force: true })
                    await fs.rm(meta_folder, { recursive: true, force: true })
                }
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test atomic write data file integrity",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var fs = require('fs').promises
                var test_id = 'test-atomic-integrity-' + Math.random().toString(36).slice(2)
                var db_folder = __dirname + '/' + test_id + '-db'
                var meta_folder = __dirname + '/' + test_id + '-meta'

                try {
                    var bb = braid_blob.create_braid_blob()
                    bb.db_folder = db_folder
                    bb.meta_folder = meta_folder

                    // Write initial content
                    await bb.put('/test-file', Buffer.from('initial content'), { version: ['1'] })

                    // Verify we can read it back correctly
                    var result = await bb.get('/test-file')
                    var content = result.body.toString()

                    res.end(content === 'initial content' ? 'true' : 'wrong content: ' + content)
                } catch (e) {
                    res.end('error: ' + e.message)
                } finally {
                    bb.meta_db.close()
                    await fs.rm(db_folder, { recursive: true, force: true })
                    await fs.rm(meta_folder, { recursive: true, force: true })
                }
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test atomic write - multiple rapid writes preserve last value",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var fs = require('fs').promises
                var test_id = 'test-atomic-rapid-' + Math.random().toString(36).slice(2)
                var db_folder = __dirname + '/' + test_id + '-db'
                var meta_folder = __dirname + '/' + test_id + '-meta'

                try {
                    var bb = braid_blob.create_braid_blob()
                    bb.db_folder = db_folder
                    bb.meta_folder = meta_folder

                    // Do multiple rapid writes
                    await bb.put('/test-file', Buffer.from('write1'), { version: ['1'] })
                    await bb.put('/test-file', Buffer.from('write2'), { version: ['2'] })
                    await bb.put('/test-file', Buffer.from('write3'), { version: ['3'] })

                    // Verify last write won
                    var result = await bb.get('/test-file')
                    var content = result.body.toString()
                    var version = result.version[0]

                    // Also verify no temp_ files remain
                    var files = await fs.readdir(bb.temp_folder)
                    var temp_files = files.filter(f => f.startsWith('temp_'))

                    res.end(content === 'write3' && version === '3' && temp_files.length === 0 ? 'true' :
                        'content=' + content + ', version=' + version + ', temp_files=' + temp_files.length)
                } catch (e) {
                    res.end('error: ' + e.message)
                } finally {
                    bb.meta_db.close()
                    await fs.rm(db_folder, { recursive: true, force: true })
                    await fs.rm(meta_folder, { recursive: true, force: true })
                }
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test atomic write - meta file is also written atomically",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var fs = require('fs').promises
                var test_id = 'test-atomic-meta-' + Math.random().toString(36).slice(2)
                var db_folder = __dirname + '/' + test_id + '-db'
                var meta_folder = __dirname + '/' + test_id + '-meta'

                try {
                    var bb = braid_blob.create_braid_blob()
                    bb.db_folder = db_folder
                    bb.meta_folder = meta_folder

                    // Write with content_type to test meta file
                    await bb.put('/test-file', Buffer.from('content'), {
                        version: ['test-version'],
                        content_type: 'text/plain'
                    })

                    // Create new instance to read from disk (not cache)
                    var bb2 = braid_blob.create_braid_blob()
                    bb2.db_folder = db_folder
                    bb2.meta_folder = meta_folder

                    var result = await bb2.get('/test-file')

                    // Verify both version and content_type are correctly persisted
                    var version_ok = result.version[0] === 'test-version'
                    var ct_ok = result.content_type === 'text/plain'

                    res.end(version_ok && ct_ok ? 'true' :
                        'version_ok=' + version_ok + ', ct_ok=' + ct_ok +
                        ', version=' + result.version[0] + ', ct=' + result.content_type)
                } catch (e) {
                    res.end('error: ' + e.message)
                } finally {
                    await fs.rm(db_folder, { recursive: true, force: true })
                    await fs.rm(meta_folder, { recursive: true, force: true })
                }
            })()`
        })
        return await r1.text()
    },
    'true'
)

runTest(
    "test that headers with different casing are normalized correctly",
    async () => {
        // This test verifies that normalize_options correctly lowercases header keys
        // when extracting special headers. Without the fix, "Parents" wouldn't match
        // "parents" in the special keys lookup, so it wouldn't be extracted.
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                // Get a reference to normalize_options by creating a fresh braid_blob
                var bb = braid_blob.create_braid_blob()

                // Access the normalize_options function through the module internals
                // We'll test it indirectly through the options processing in put/get
                var test_key = '/test-header-case-' + Math.random().toString(36).slice(2)

                // Put some content first
                await braid_blob.put(test_key, Buffer.from('v1'), { version: ['1.0'] })

                // Now call get with uppercase "Parents" header key
                // Without the toLowerCase() fix, "Parents" wouldn't be recognized
                // and wouldn't be extracted to normalized.parents

                // The parents option affects whether subscribe sends an immediate update
                // If parents=['1.0'] (same as current version), no update is sent
                // If parents is not set or recognized, update IS sent

                var got_immediate = false
                var ac = new AbortController()
                await braid_blob.get(test_key, {
                    signal: ac.signal,
                    headers: { 'Parents': '"1.0"' },  // Uppercase "Parents" key
                    subscribe: (update) => {
                        got_immediate = true
                    }
                })

                // Wait a bit for potential update
                await new Promise(done => setTimeout(done, 100))
                ac.abort()

                // If Parents was correctly normalized, got_immediate should be false
                // (because parents='1.0' equals current version, so no update needed)
                // If Parents was NOT normalized (bug case), got_immediate would be true
                res.end(got_immediate ? 'got update (bug)' : 'no update (correct)')
            })()`
        })
        return await r1.text()
    },
    'no update (correct)'
)

runTest(
    "test version validation rejects non-array",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-validate-nonarr-' + Math.random().toString(36).slice(2)
                try {
                    await braid_blob.put(test_key, Buffer.from('test'), {
                        version: {not: 'an array'}  // Object instead of array
                    })
                    res.end('no error')
                } catch (e) {
                    res.end(e.message.includes('not an array') ? 'caught' : 'wrong error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'caught'
)

runTest(
    "test version validation rejects empty array",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-validate-empty-' + Math.random().toString(36).slice(2)
                try {
                    await braid_blob.put(test_key, Buffer.from('test'), {
                        version: []  // Empty array
                    })
                    res.end('no error')
                } catch (e) {
                    res.end(e.message.includes('must have an event id') ? 'caught' : 'wrong error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'caught'
)

runTest(
    "test version validation rejects multiple event ids",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-validate-multi-' + Math.random().toString(36).slice(2)
                try {
                    await braid_blob.put(test_key, Buffer.from('test'), {
                        version: ['1', '2']  // Multiple event ids
                    })
                    res.end('no error')
                } catch (e) {
                    res.end(e.message.includes('only have 1 event id') ? 'caught' : 'wrong error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'caught'
)

runTest(
    "test version validation rejects non-string event id",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-validate-nonstr-' + Math.random().toString(36).slice(2)
                try {
                    await braid_blob.put(test_key, Buffer.from('test'), {
                        version: [123]  // Number instead of string
                    })
                    res.end('no error')
                } catch (e) {
                    res.end(e.message.includes('must be a string') ? 'caught' : 'wrong error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'caught'
)

runTest(
    "test parents validation rejects non-array",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-validate-parents-nonarr-' + Math.random().toString(36).slice(2)
                try {
                    await braid_blob.put(test_key, Buffer.from('test'), {
                        version: ['1'],
                        parents: {not: 'an array'}  // Object instead of array
                    })
                    res.end('no error')
                } catch (e) {
                    res.end(e.message.includes('not an array') ? 'caught' : 'wrong error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'caught'
)

runTest(
    "test parents validation rejects multiple event ids",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-validate-parents-multi-' + Math.random().toString(36).slice(2)
                try {
                    await braid_blob.put(test_key, Buffer.from('test'), {
                        version: ['1'],
                        parents: ['0', '1']  // Multiple parent ids
                    })
                    res.end('no error')
                } catch (e) {
                    res.end(e.message.includes('only have 1 event id') ? 'caught' : 'wrong error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'caught'
)

runTest(
    "test parents validation allows empty array",
    async () => {
        var key = 'test-validate-parents-empty-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['1'],
            parents: [],  // Empty parents is allowed (min=0)
            body: 'test'
        })
        if (!r.ok) return 'put failed: ' + r.status

        var r2 = await braid_fetch(`/${key}`)
        return await r2.text()
    },
    'test'
)

runTest(
    "test parents validation rejects non-string event id",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-validate-parents-nonstr-' + Math.random().toString(36).slice(2)
                try {
                    await braid_blob.put(test_key, Buffer.from('test'), {
                        version: ['1'],
                        parents: [123]  // Number instead of string
                    })
                    res.end('no error')
                } catch (e) {
                    res.end(e.message.includes('must be a string') ? 'caught' : 'wrong error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'caught'
)

runTest(
    "test version string is auto-wrapped in array",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-validate-string-wrap-' + Math.random().toString(36).slice(2)
                try {
                    // String version should be auto-wrapped in array
                    await braid_blob.put(test_key, Buffer.from('test'), {
                        version: 'my-version'
                    })
                    var result = await braid_blob.get(test_key)
                    res.end(result.version[0] === 'my-version' ? 'ok' : 'wrong version: ' + result.version)
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'ok'
)

runTest(
    "test parents string is auto-wrapped in array",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-validate-parents-string-wrap-' + Math.random().toString(36).slice(2)
                try {
                    // Put initial version
                    await braid_blob.put(test_key, Buffer.from('v1'), { version: ['1'] })

                    // String parents should be auto-wrapped in array
                    await braid_blob.put(test_key, Buffer.from('v2'), {
                        version: ['2'],
                        parents: '1'  // String instead of array
                    })
                    var result = await braid_blob.get(test_key)
                    res.end(result.version[0] === '2' ? 'ok' : 'wrong version: ' + result.version)
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'ok'
)

runTest(
    "test version passed via headers is parsed correctly",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-version-header-' + Math.random().toString(36).slice(2)
                try {
                    // Pass version via headers (JSON-encoded as per braid protocol)
                    await braid_blob.put(test_key, Buffer.from('test'), {
                        headers: { 'Version': '"header-version-123"' }
                    })
                    var result = await braid_blob.get(test_key)
                    res.end(result.version[0] === 'header-version-123' ? 'ok' : 'wrong version: ' + result.version[0])
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'ok'
)

runTest(
    "test parents passed via headers is parsed correctly",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-parents-header-' + Math.random().toString(36).slice(2)
                try {
                    // Put initial version
                    await braid_blob.put(test_key, Buffer.from('v1'), { version: ['1'] })

                    // Pass parents via headers (JSON-encoded as per braid protocol)
                    await braid_blob.put(test_key, Buffer.from('v2'), {
                        version: ['2'],
                        headers: { 'Parents': '"1"' }
                    })
                    var result = await braid_blob.get(test_key)
                    res.end(result.version[0] === '2' ? 'ok' : 'wrong version: ' + result.version[0])
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'ok'
)

runTest(
    "test version via headers validation rejects multiple event ids",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-version-header-multi-' + Math.random().toString(36).slice(2)
                try {
                    // Pass multiple versions via headers (should fail validation)
                    await braid_blob.put(test_key, Buffer.from('test'), {
                        headers: { 'Version': '"v1", "v2"' }
                    })
                    res.end('no error')
                } catch (e) {
                    res.end(e.message.includes('only have 1 event id') ? 'caught' : 'wrong error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'caught'
)

runTest(
    "test parents via headers validation rejects multiple event ids",
    async () => {
        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                var test_key = '/test-parents-header-multi-' + Math.random().toString(36).slice(2)
                try {
                    await braid_blob.put(test_key, Buffer.from('test'), {
                        version: ['1'],
                        headers: { 'Parents': '"p1", "p2"' }
                    })
                    res.end('no error')
                } catch (e) {
                    res.end(e.message.includes('only have 1 event id') ? 'caught' : 'wrong error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'caught'
)

runTest(
    "test sync abort stops retry after error",
    async () => {
        var local_key = 'test-sync-abort-retry-' + Math.random().toString(36).slice(2)

        var r1 = await braid_fetch(`/eval`, {
            method: 'POST',
            body: `void (async () => {
                try {
                    var braid_blob = require(\`\${__dirname}/../index.js\`)

                    // Use unreachable URL to trigger errors (RFC 5737 TEST-NET-1, guaranteed not routable)
                    var remote_url = new URL('http://192.0.2.1:12345/unreachable')

                    var connect_count = 0
                    var ac = new AbortController()

                    // Start sync - will fail and try to reconnect
                    braid_blob.sync('${local_key}', remote_url, {
                        signal: ac.signal,
                        on_pre_connect: () => {
                            connect_count++
                            // Abort after first connect attempt
                            if (connect_count === 1) {
                                setTimeout(() => ac.abort(), 50)
                            }
                        }
                    })

                    // Wait long enough for potential retries (retry is 1 second)
                    await new Promise(done => setTimeout(done, 1500))

                    // Should only have 1 connect attempt since we aborted
                    res.end(connect_count === 1 ? 'true' : 'connect_count=' + connect_count)
                } catch (e) {
                    res.end('error: ' + e.message)
                }
            })()`
        })
        return await r1.text()
    },
    'true'
)

}

// Export for Node.js (CommonJS)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = defineTests
}

// Export for browser (global)
if (typeof window !== 'undefined') {
    window.defineTests = defineTests
}
