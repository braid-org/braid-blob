// Shared test definitions that work in both Node.js and browser environments

// This module exports "define_tests(run_test, context)":
function define_tests(run_test, context) {
    // Get all the Javascript functions and variables we will be using.
    // These are set differently in nodejs and the browser.
    var { braid_fetch, assert, add_section_header } = context

    // Builds an /eval request body that calls fn(req, res, ...args) on the
    // server. The function is sent over the wire and eval'd server-side, so
    // it can't close over test-side variables -- any values it needs are
    // JSON-serialized and passed to it after (req, res). It runs in the
    // server's scope, so it can use test.js globals like braid_blob, assert,
    // braid_fetch, port, and __dirname. Writing it as a real function --
    // rather than a template string -- keeps it syntax-highlighted.
    function eval_body(fn, ...args) {
        return `(${fn})(req, res, ...${JSON.stringify(args)})`
    }

    // Runs a function on the test server, and returns the response text.
    // The function is responsible for ending res. A server-side assert()
    // failure (or any thrown error) comes back as a 500, which we throw,
    // failing the test with the error's message.
    async function server_eval(fn, ...args) {
        var r = await braid_fetch(`/eval`, {
            method: 'POST',
            body: eval_body(fn, ...args)
        })
        if (!r.ok) throw new Error((await r.text()).replace(/^Error: /, ''))
        return await r.text()
    }

add_section_header("Peer")

run_test(
    "test that peer.txt gets initialized on a fresh run",
    async () => {
        var peer = await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                try {
                    await bb.serve({}, {})
                } catch (e) {}

                res.end(bb.peer)
            })
        })

        assert(peer.length > 5, `expected a peer id, got: ${JSON.stringify(peer)}`)
    }
)

run_test(
    "test that peer is different each time we create a new instance",
    async () => {
        var [peer1, peer2] = JSON.parse(await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                try {
                    await bb.serve({}, {})
                } catch (e) {}

                var bb2 = braid_blob.create_braid_blob()
                bb2.db_folder = bb.db_folder
                bb2.meta_folder = bb.meta_folder

                try {
                    await bb2.serve({}, {})
                } catch (e) {}

                res.end(JSON.stringify([bb.peer, bb2.peer]))
            })
        }))

        assert(peer1 !== peer2, `both instances got peer ${peer1}`)
    }
)

run_test(
    "test that we can set the peer of a braid_blob object",
    async () => {
        var peer = await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                bb.peer = 'test_peer'

                try {
                    await bb.serve({}, {})
                } catch (e) {}

                res.end(bb.peer)
            })
        })

        assert(peer === 'test_peer', `expected test_peer, got: ${peer}`)
    }
)

run_test(
    "test that manually set peer persists through initialization",
    async () => {
        var peer = await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                // Set the peer manually, then initialize (which should keep
                // our custom peer)
                bb.peer = 'custom-peer-id-123'
                await bb.init()

                res.end(bb.peer)
            })
        })

        assert(peer === 'custom-peer-id-123', `expected custom-peer-id-123, got: ${peer}`)
    }
)

add_section_header("HTTP")

run_test(
    "test that PUTing with shorter event id doesn't do anything.",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['11.0'],
            body: 'xyz'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['9.0'],
            body: 'abc'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var r = await braid_fetch(`/${key}`)
        var text = await r.text()
        assert(text === 'xyz', `expected xyz, got: ${text}`)
    }
)

run_test(
    "test that we ignore stuff after the ? in a url",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}?blah`, {
            method: 'PUT',
            version: ['11'],
            body: 'yo!'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var r = await braid_fetch(`/${key}`)
        var text = await r.text()
        assert(text === 'yo!', `expected yo!, got: ${text}`)
    }
)

run_test(
    "test that we ignore stuff after the # in a url",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}#blah?bloop`, {
            method: 'PUT',
            version: ['11'],
            body: 'hi!'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var r = await braid_fetch(`/${key}`)
        var text = await r.text()
        assert(text === 'hi!', `expected hi!, got: ${text}`)
    }
)

run_test(
    "test send an update to another peer",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {'Content-Type': 'text/plain'},
            version: ['1'],
            body: 'xyz'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

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
        assert(r.ok, `PUT failed with ${r.status}`)

        var body = await p
        assert(body === 'abc', `expected abc, got: ${body}`)
    }
)

run_test(
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
        assert(r.ok, `PUT failed with ${r.status}`)

        var a1 = new AbortController()
        var r1 = await braid_fetch(`/${key}`, {
            signal: a1.signal,
            subscribe: true,
            peer: key
        })

        var p1 = new Promise(done => {
            r1.subscribe(update => {
                if (update.version?.[0] === '2') done(update.body_text)
            })
        })

        var r = await braid_fetch(`/${key2}`, {
            method: 'PUT',
            headers: {'Content-Type': 'text/plain'},
            version: ['1'],
            body: 'xyz2'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var a2 = new AbortController()
        var r2 = await braid_fetch(`/${key2}`, {
            signal: a2.signal,
            subscribe: true,
            peer: key2
        })

        var p2 = new Promise(done => {
            r2.subscribe(update => {
                if (update.version?.[0] === '2') done(update.body_text)
            })
        })

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            headers: {'Content-Type': 'text/plain'},
            version: ['2'],
            body: 'abc'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var r = await braid_fetch(`/${key2}`, {
            method: 'PUT',
            headers: {'Content-Type': 'text/plain'},
            version: ['2'],
            body: 'abc2'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var [body1, body2] = await Promise.all([p1, p2])
        a1.abort()
        a2.abort()
        assert(body1 === 'abc', `expected abc, got: ${body1}`)
        assert(body2 === 'abc2', `expected abc2, got: ${body2}`)
    }
)

run_test(
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
        assert(r.ok, `PUT failed with ${r.status}`)

        var r = await braid_fetch(`/${key}`, {
            headers: {Accept: 'text/html'}
        })
        assert(r.status === 406, `expected 406, got: ${r.status}`)
        var text = await r.text()
        assert(text === 'Content-Type of text/plain not in Accept: text/html',
            `got: ${text}`)
    }
)

run_test(
    "test deleting something",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['1'],
            parents: [],
            body: 'xyz'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var r = await braid_fetch(`/${key}`, {
            method: 'DELETE',
        })
        assert(r.ok, `DELETE failed with ${r.status}`)

        var r = await braid_fetch(`/${key}`)
        assert(r.status === 404, `expected 404 after delete, got: ${r.status}`)
    }
)

run_test(
    "test deleting something that doesn't exist",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'DELETE',
        })
        assert(r.status === 200, `expected 200, got: ${r.status}`)
    }
)

add_section_header("Local API")

run_test(
    "test braid_blob.delete() directly",
    async () => {
        await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                // Put a file
                await bb.put('/test-file', Buffer.from('hello'))

                // Verify it exists
                var result = await bb.get('/test-file')
                assert(result && result.body, 'file not found after put')

                // Delete it
                await bb.delete('/test-file')

                // Verify it's gone
                assert(!(await bb.get('/test-file')), 'file still exists after delete')

                res.end('ok')
            })
        })
    }
)

run_test(
    "test braid_blob.list() returns all keys",
    async () => {
        await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                // Initially should be empty
                var keys0 = await bb.list()
                assert(keys0.length === 0,
                    'expected empty list, got ' + JSON.stringify(keys0))

                // Add some keys
                await bb.put('/file-a', Buffer.from('aaa'), { version: ['1'] })
                await bb.put('/file-b', Buffer.from('bbb'), { version: ['1'] })
                await bb.put('/file-c', Buffer.from('ccc'), { version: ['1'] })

                var keys1 = await bb.list()
                assert(keys1.length === 3, 'expected 3 keys, got ' + keys1.length)
                assert(keys1.includes('/file-a') && keys1.includes('/file-b')
                    && keys1.includes('/file-c'),
                    'missing keys, got ' + JSON.stringify(keys1))

                // Delete one and verify it's gone from list
                await bb.delete('/file-b')
                var keys2 = await bb.list()
                assert(keys2.length === 2 && !keys2.includes('/file-b'),
                    'after delete, got ' + JSON.stringify(keys2))

                res.end('ok')
            })
        })
    }
)

run_test(
    "test braid_blob.list() callback receives keys atomically",
    async () => {
        await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                await bb.put('/cb-a', Buffer.from('aaa'), { version: ['1'] })
                await bb.put('/cb-b', Buffer.from('bbb'), { version: ['1'] })

                // The callback receives the keys...
                var cb_keys = null
                var returned_keys = await bb.list((keys) => { cb_keys = keys })
                assert(cb_keys, 'callback was not called')
                assert(cb_keys.length === 2,
                    'callback got ' + cb_keys.length + ' keys, expected 2')
                assert(cb_keys.includes('/cb-a') && cb_keys.includes('/cb-b'),
                    'callback missing keys, got ' + JSON.stringify(cb_keys))

                // ...and the return value still works...
                assert(returned_keys.length === 2,
                    'return value got ' + returned_keys.length + ' keys, expected 2')

                // ...as the very same array
                assert(cb_keys === returned_keys,
                    'callback and return value are not the same array')

                // And list() still works without a callback
                var no_cb_keys = await bb.list()
                assert(no_cb_keys.length === 2,
                    'no-callback list got ' + no_cb_keys.length + ' keys')

                res.end('ok')
            })
        })
    }
)

run_test(
    "test braid_blob.exists() checks key presence",
    async () => {
        await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                // Should not exist yet
                assert(await bb.exists('/ex-a') === false, 'expected false before put')

                // Add a key
                await bb.put('/ex-a', Buffer.from('aaa'), { version: ['1'] })

                // Should exist now
                assert(await bb.exists('/ex-a') === true, 'expected true after put')

                // Other key should not exist
                assert(await bb.exists('/ex-b') === false,
                    'expected false for missing key')

                // Delete and verify gone
                await bb.delete('/ex-a')
                assert(await bb.exists('/ex-a') === false, 'expected false after delete')

                // The callback receives the result too
                await bb.put('/ex-c', Buffer.from('ccc'), { version: ['1'] })
                var cb_val = null
                var ret_val = await bb.exists('/ex-c', (v) => { cb_val = v })
                assert(cb_val === true && ret_val === true,
                    'callback=' + cb_val + ', return=' + ret_val)

                res.end('ok')
            })
        })
    }
)

run_test(
    "test that aborting cleans up subscription",
    async () => {
        await server_eval(async (req, res) => {
            var test_id = '/test-' + Math.random().toString(36).slice(2)

            // Put a file
            await braid_blob.put(test_id, 'hello')

            // Subscribe to it
            var ac = new AbortController()
            await braid_blob.get(test_id, {
                signal: ac.signal,
                subscribe: (update) => {}
            })

            // Verify subscription exists
            assert(braid_blob.subscriptions_to[test_id], 'expected subscription to exist')

            await new Promise(done => setTimeout(done, 30))
            ac.abort()
            await new Promise(done => setTimeout(done, 30))

            // Verify subscription is cleaned up
            assert(!braid_blob.subscriptions_to[test_id],
                'expected subscription to be cleaned up after abort')

            res.end('ok')
        })
    }
)

add_section_header("Versioning and Subscription")

run_test(
    "test that subscribe returns current-version header",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['1'],
            parents: [],
            body: 'xyz'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true
        })
        var current_version = r.headers.get('current-version')
        a.abort()
        assert(current_version === '"1"', `got: ${current_version}`)
    }
)

run_test(
    "test that subscribe returns version as string-number in array",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['1'],
            parents: [],
            body: 'xyz'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true
        })

        var version = await new Promise(done => {
            r.subscribe(update => {
                done(update.version)
            })
        })

        a.abort()
        assert(JSON.stringify(version) === '["1"]',
            `got: ${JSON.stringify(version)}`)
    }
)

run_test(
    "test that subscribe's update's versions are string-number in array",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['4'],
            body: 'xyz'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            parents: ['0']
        })

        var version = await new Promise(done => {
            r.subscribe(update => {
                done(update.version)
            })
        })

        a.abort()
        assert(JSON.stringify(version) === '["4"]',
            `got: ${JSON.stringify(version)}`)
    }
)

run_test(
    "test that non-subscribe returns version header",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['2'],
            parents: [],
            body: 'xyz'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var r = await braid_fetch(`/${key}`)
        assert(r.headers.get('version') === '"2"',
            `got: ${r.headers.get('version')}`)
    }
)

run_test(
    "test that subscribe sends no version if parents is big enough.",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['3'],
            parents: [],
            body: 'xyz'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            parents: ['3']
        })

        var received_update = false
        var got_update = new Promise(done => {
            r.subscribe(async (update) => {
                received_update = true
                done()
            })
        })

        // Give an unwanted update 300ms to show up
        await Promise.race([got_update, new Promise(done => setTimeout(done, 300))])
        a.abort()

        assert(!received_update, 'expected no update, since parents is current')
    }
)

run_test(
    "test that we get 404 when file doesn't exist, on GET without subscribe.",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`)
        assert(r.status === 404, `expected 404, got: ${r.status}`)
    }
)

run_test(
    "test second subscription to same key",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['3'],
            parents: [],
            body: 'xyz'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

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
        assert(body === 'xyz', `got: ${body}`)
    }
)

run_test(
    "test PUTing when server already has blob",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['3'],
            parents: [],
            body: 'xyz'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['4'],
            parents: [],
            body: 'XYZ'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var text = await (await braid_fetch(`/${key}`)).text()
        assert(text === 'XYZ', `expected XYZ, got: ${text}`)
    }
)

run_test(
    "test PUTing when server has newer version",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['3'],
            parents: [],
            body: 'xyz'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['2'],
            parents: [],
            body: 'XYZ'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        assert(r.headers.get('current-version') === '"3"',
            `got: ${r.headers.get('current-version')}`)
    }
)

run_test(
    "test that version we get back is the version we set",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['1760077018883'],
            parents: [],
            body: 'xyz'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var r = await braid_fetch(`/${key}`)
        assert(r.headers.get('version') === '"1760077018883"',
            `got: ${r.headers.get('version')}`)
    }
)

run_test(
    "test that subscribe gets back editable:true.",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            body: 'xyz'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            parents: ['3']
        })

        var editable = r.headers.get('editable')
        a.abort()
        assert(editable === 'true', `got: ${editable}`)
    }
)

run_test(
    "test that we can override editable on the server.",
    async () => {
        var a = new AbortController()
        var r = await braid_fetch(`/eval`, {
            method: 'POST',
            subscribe: true,
            signal: a.signal,
            body: eval_body((req, res) => {
                req.method = 'GET'
                res.setHeader('editable', 'false')
                braid_blob.serve(req, res, {key: ':test'})
            })
        })
        var editable = r.headers.get('editable')
        a.abort()
        assert(editable === 'false', `got: ${editable}`)
    }
)

run_test(
    "test requesting with version/parents server doesn't have",
    async () => {
        var key = 'test-parents-unknown-' + Math.random().toString(36).slice(2)

        // Put with version 100
        await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['100'],
            body: 'content v100'
        })

        // Try to GET with parents 200 (newer than what server has)
        var r = await braid_fetch(`/${key}`, {
            parents: ['200']
        })
        assert(r.status === 432, `expected 432, got: ${r.status}`)
    }
)

run_test(
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
        var r = await braid_fetch(`/${key}`, {
            version: ['200']
        })
        assert(r.status === 432, `expected 432, got: ${r.status}`)
    }
)

add_section_header("URL API")

run_test(
    "test put with URL (no content_type)",
    async () => {
        var key = 'test-url-put-' + Math.random().toString(36).slice(2)

        await server_eval(async (req, res, key) => {
            var url = new URL('http://localhost:' + req.socket.localPort + '/' + key)
            await braid_blob.put(url, Buffer.from('url put test'), { version: ['100'] })
            res.end('ok')
        }, key)

        var r = await braid_fetch(`/${key}`)
        var text = await r.text()
        assert(text === 'url put test', `got: ${text}`)
    }
)

run_test(
    "test put with URL (with content_type)",
    async () => {
        var key = 'test-url-put-ct-' + Math.random().toString(36).slice(2)

        await server_eval(async (req, res, key) => {
            var url = new URL('http://localhost:' + req.socket.localPort + '/' + key)
            await braid_blob.put(url, Buffer.from('url put with ct'), {
                version: ['200'],
                content_type: 'text/plain'
            })
            res.end('ok')
        }, key)

        var r = await braid_fetch(`/${key}`)
        assert(r.headers.get('content-type') === 'text/plain',
            `got content-type: ${r.headers.get('content-type')}`)
        var text = await r.text()
        assert(text === 'url put with ct', `got: ${text}`)
    }
)

run_test(
    "test get with URL (no subscribe)",
    async () => {
        var key = 'test-url-get-' + Math.random().toString(36).slice(2)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['300'],
            body: 'url get test'
        })

        var body = await server_eval(async (req, res, key) => {
            var url = new URL('http://localhost:' + req.socket.localPort + '/' + key)
            var result = await braid_blob.get(url)
            res.end(Buffer.from(result.body).toString('utf8'))
        }, key)

        assert(body === 'url get test', `got: ${body}`)
    }
)

run_test(
    "test get with URL (with subscribe)",
    async () => {
        var key = 'test-url-get-sub-' + Math.random().toString(36).slice(2)

        await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['400'],
            body: 'initial'
        })

        // Don't await yet -- the server function ends its response only once
        // it has seen both updates
        var eval_promise = server_eval(async (req, res, key) => {
            var url = new URL('http://localhost:' + req.socket.localPort + '/' + key)

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
        }, key)

        // Wait a bit for subscription to be established
        await new Promise(done => setTimeout(done, 100))

        // Send update
        await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['500'],
            body: 'updated'
        })

        var updates = await eval_promise
        assert(updates === 'initial|updated', `got: ${updates}`)
    }
)

run_test(
    "test get with URL returns null on 404",
    async () => {
        var key = 'test-url-get-404-' + Math.random().toString(36).slice(2)

        await server_eval(async (req, res, key) => {
            var url = new URL('http://localhost:' + req.socket.localPort + '/' + key)
            var result = await braid_blob.get(url)
            assert(result === null, 'expected null, got: ' + JSON.stringify(result))
            res.end('ok')
        }, key)
    }
)

add_section_header("Sync")

run_test(
    "sync() local to remote",
    async () => {
        var local_key = 'test-sync-local-' + Math.random().toString(36).slice(2)
        var remote_key = 'test-sync-remote-' + Math.random().toString(36).slice(2)

        await server_eval(async (req, res, local_key, remote_key) => {
            // Put something locally first
            await braid_blob.put(local_key, Buffer.from('local content'),
                { version: ['600'] })

            var remote_url = new URL(
                'http://localhost:' + req.socket.localPort + '/' + remote_key)

            // Start sync
            braid_blob.sync(local_key, remote_url)

            res.end('ok')
        }, local_key, remote_key)

        // Wait a bit for sync to happen
        await new Promise(done => setTimeout(done, 100))

        // Check remote has the content
        var res = await braid_fetch(`/${remote_key}`)
        assert(res.status === 200, 'Remote url returned status ' + res.status)
        var text = await res.text()
        assert(text === 'local content', `Test received text="${text}"`)
    }
)

run_test(
    "sync() two local keys throws error",
    async () => {
        var key1 = '/test-sync-local1-' + Math.random().toString(36).slice(2)
        var key2 = '/test-sync-local2-' + Math.random().toString(36).slice(2)

        await server_eval(async (req, res, key1, key2) => {
            // Syncing between two local keys should throw
            var threw = false
            try {
                braid_blob.sync(key1, key2)
            } catch (e) {
                threw = true
            }
            assert(threw, 'expected sync of two local keys to throw')
            res.end('ok')
        }, key1, key2)
    }
)

run_test(
    "sync() when server already has our version",
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

        await server_eval(async (req, res, local_key, remote_key, version, content) => {
            // Put the same content locally with the same version
            await braid_blob.put(local_key, Buffer.from(content), { version })

            var remote_url = new URL(
                'http://localhost:' + req.socket.localPort + '/' + remote_key)

            // Start sync - this should trigger the "server already has our
            // version" path
            braid_blob.sync(local_key, remote_url)

            res.end('ok')
        }, local_key, remote_key, version, content)

        // Wait a bit for sync to initialize
        await new Promise(done => setTimeout(done, 100))

        // Verify that both still have the same content
        var r = await braid_fetch(`/${remote_key}`)
        var text = await r.text()
        assert(text === content, `got: ${text}`)
    }
)

run_test(
    "sync() connect does not read file body for version check",
    async () => {
        // This test and "If-None-Match saves the disk read too" both
        // temporarily wrap the server's global db.read, and both count
        // reads filtered to their own key. If their windows overlap (tests
        // run concurrently), an interleaved restore can disarm a counter
        // early -- which only undercounts, so the reads-stay-zero asserts
        // can pass vacuously, never flake.
        var local_key = '/test-sync-no-read-' + Math.random().toString(36).slice(2)
        var remote_key = 'test-sync-no-read-remote-' + Math.random().toString(36).slice(2)

        // Put something on remote with SAME version as local, so no data needs to flow
        var r = await braid_fetch(`/${remote_key}`, {
            method: 'PUT',
            version: ['same-version-123'],
            body: 'same content'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        await server_eval(async (req, res, local_key, remote_key) => {
            // Put locally with SAME version - so when sync connects, no
            // updates need to flow
            await braid_blob.put(local_key, 'same content',
                { version: ['same-version-123'] })

            // Wrap db.read to count calls for our specific key
            var read_count = 0
            var original_read = braid_blob.db.read
            braid_blob.db.read = async function (key, range) {
                if (key === local_key) read_count++
                return original_read.call(this, key, range)
            }

            try {
                var remote_url = new URL('http://localhost:' + port + '/' + remote_key)
                var ac = new AbortController()

                // Start sync - since both have same version, no updates should flow
                braid_blob.sync(local_key, remote_url, { signal: ac.signal })

                // Wait for sync to establish connection
                await new Promise(done => setTimeout(done, 300))

                ac.abort()

                // db.read should not have been called since:
                // 1. Initial version check uses head:true (no body read)
                // 2. Both have same version so no updates flow
                assert(read_count === 0, 'reads: ' + read_count)
            } finally {
                braid_blob.db.read = original_read
            }
            res.end('ok')
        }, local_key, remote_key)
    }
)

run_test(
    "sync() downloads the remote version when it's newer, without uploading ours",
    async () => {
        var local_key = 'test-sync-ahead-local-' + Math.random().toString(36).slice(2)
        var remote_key = 'test-sync-ahead-remote-' + Math.random().toString(36).slice(2)

        // The remote starts out newer than the local
        var r = await braid_fetch(`/${remote_key}`, {
            method: 'PUT', version: ['200'], body: 'newer' })
        assert(r.ok, `PUT failed with ${r.status}`)

        var got = await server_eval(async (req, res, local_key, remote_key) => {
            await braid_blob.put(local_key, Buffer.from('older'),
                { version: ['100'] })

            // Count writes to the remote key, to catch any stale upload
            var uploads = 0
            var original_put = braid_blob.put
            braid_blob.put = function (key, ...args) {
                if (key === '/' + remote_key) uploads++
                return original_put.call(this, key, ...args)
            }

            try {
                var remote_url = new URL('http://localhost:' + port + '/' + remote_key)
                var ac = new AbortController()
                braid_blob.sync(local_key, remote_url, { signal: ac.signal })
                await new Promise(done => setTimeout(done, 300))
                ac.abort()

                var local = await braid_blob.get(local_key)
                res.end(JSON.stringify({
                    body: local.body.toString(),
                    version: local.version,
                    uploads
                }))
            } finally {
                braid_blob.put = original_put
            }
        }, local_key, remote_key)

        var { body, version, uploads } = JSON.parse(got)
        assert(body === 'newer', `local body: ${body}`)
        assert(version[0] === '200', `local version: ${version}`)
        assert(uploads === 0, `uploads: ${uploads}`)
    }
)

run_test(
    "sync() uploads the local version when it's newer, and live edits after that",
    async () => {
        var local_key = 'test-sync-behind-local-' + Math.random().toString(36).slice(2)
        var remote_key = 'test-sync-behind-remote-' + Math.random().toString(36).slice(2)

        // The remote starts out older than the local
        var r = await braid_fetch(`/${remote_key}`, {
            method: 'PUT', version: ['200'], body: 'older' })
        assert(r.ok, `PUT failed with ${r.status}`)

        var got = await server_eval(async (req, res, local_key, remote_key) => {
            await braid_blob.put(local_key, Buffer.from('newer'),
                { version: ['300'] })

            var remote_url = new URL('http://localhost:' + port + '/' + remote_key)
            var ac = new AbortController()
            braid_blob.sync(local_key, remote_url, { signal: ac.signal })
            await new Promise(done => setTimeout(done, 300))
            var after_connect = (await braid_blob.get('/' + remote_key)).body.toString()

            // A live local edit flows up through the running sync
            await braid_blob.put(local_key, Buffer.from('live'),
                { version: ['400'] })
            await new Promise(done => setTimeout(done, 300))
            var after_edit = (await braid_blob.get('/' + remote_key)).body.toString()

            ac.abort()
            res.end(JSON.stringify({ after_connect, after_edit }))
        }, local_key, remote_key)

        var { after_connect, after_edit } = JSON.parse(got)
        assert(after_connect === 'newer', `after connect: ${after_connect}`)
        assert(after_edit === 'live', `after edit: ${after_edit}`)
    }
)

run_test(
    "sync() closed during error",
    async () => {
        var local_key = 'test-sync-closed-local-' + Math.random().toString(36).slice(2)
        var remote_key = 'test-sync-closed-remote-' + Math.random().toString(36).slice(2)

        await server_eval(async (req, res, local_key, remote_key) => {
            // Use an invalid/unreachable URL to trigger an error
            var remote_url = new URL('http://localhost:9999/' + remote_key)

            var ac = new AbortController()
            braid_blob.sync(local_key, remote_url, { signal: ac.signal })

            // Close the sync immediately to trigger the closed path when the
            // error occurs
            ac.abort()

            res.end('ok')
        }, local_key, remote_key)

        // Wait for the connection error and closed message
        await new Promise(done => setTimeout(done, 200))
    }
)

run_test(
    "sync() error with retry",
    async () => {
        var local_key = 'test-sync-retry-local-' + Math.random().toString(36).slice(2)
        var remote_key = 'test-sync-retry-remote-' + Math.random().toString(36).slice(2)

        await server_eval(async (req, res, local_key, remote_key) => {
            // Use an invalid/unreachable URL to trigger an error
            var remote_url = new URL('http://localhost:9999/' + remote_key)

            var ac = new AbortController()

            // Start sync with signal - should trigger retry on error
            braid_blob.sync(local_key, remote_url, { signal: ac.signal })

            // Wait a bit for the error to occur and retry message to print
            await new Promise(done => setTimeout(done, 200))

            // Now close it to stop retrying
            ac.abort()

            res.end('ok')
        }, local_key, remote_key)
    }
)

run_test(
    "sync() abort stops retry after error",
    async () => {
        var local_key = 'test-sync-abort-retry-' + Math.random().toString(36).slice(2)

        await server_eval(async (req, res, local_key) => {
            // Use unreachable URL to trigger errors (RFC 5737 TEST-NET-1,
            // guaranteed not routable)
            var remote_url = new URL('http://192.0.2.1:12345/unreachable')

            var connect_count = 0
            var ac = new AbortController()

            // Start sync - will fail and try to reconnect
            braid_blob.sync(local_key, remote_url, {
                signal: ac.signal,
                on_pre_connect: () => {
                    connect_count++
                    // Abort after first connect attempt
                    if (connect_count === 1) setTimeout(() => ac.abort(), 50)
                }
            })

            // Wait long enough for potential retries (retry is 1 second)
            await new Promise(done => setTimeout(done, 1500))

            // Should only have 1 connect attempt since we aborted
            assert(connect_count === 1, 'connect_count=' + connect_count)
            res.end('ok')
        }, local_key)
    },
    undefined, {timeout: 5000}
)

add_section_header("Filename Encoding")

run_test(
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
        assert(r.ok, `PUT to lowercase key failed: ${r.status}`)

        // PUT to uppercase key with version 200
        var r = await braid_fetch(`/${key2}`, {
            method: 'PUT',
            version: ['200'],
            body: 'uppercase content'
        })
        assert(r.ok, `PUT to uppercase key failed: ${r.status}`)

        // GET both and verify they have different versions (stored in meta files)
        var r1 = await braid_fetch(`/${key1}`)
        assert(r1.ok, `GET lowercase key failed: ${r1.status}`)
        assert(r1.headers.get('version') === '"100"',
            `lowercase key got version: ${r1.headers.get('version')}`)

        var r2 = await braid_fetch(`/${key2}`)
        assert(r2.ok, `GET uppercase key failed: ${r2.status}`)
        assert(r2.headers.get('version') === '"200"',
            `uppercase key got version: ${r2.headers.get('version')}`)
    }
)

run_test(
    "test that keys without letters work (encode_filename bitmap edge)",
    async () => {
        var key = '/1234-' + Math.floor(Math.random() * 1e9)
        var r = await braid_fetch(key, {method: 'PUT', version: ['5'], body: 'num'})
        assert(r.ok, `PUT failed: ${r.status}`)

        var r2 = await braid_fetch(key)
        assert(r2.status === 200, `expected 200, got: ${r2.status}`)
        assert(await r2.text() === 'num', 'wrong body')
    }
)

add_section_header("Persistence")

run_test(
    "test multiple writes preserve correct mtime across restarts",
    async () => {
        await server_eval(async (req, res) => {
            var test_key = 'test-file'

            await with_test_instance(async bb => {
                // First write
                await bb.put(test_key, Buffer.from('content1'), {
                    version: ['version-1']
                })

                // Wait a bit to ensure different mtime
                await new Promise(resolve => setTimeout(resolve, 50))

                // Second write to same file (this is where the bug would occur)
                await bb.put(test_key, Buffer.from('content2'), {
                    version: ['version-2']
                })

                await bb.get(test_key)

                // Now restart and check
                var bb2 = braid_blob.create_braid_blob()
                bb2.db_folder = bb.db_folder
                bb2.meta_folder = bb.meta_folder

                // Get the file from the new instance
                var result = await bb2.get(test_key)

                // Version should still be version-2, not regenerated
                assert(result.version[0] === 'version-2',
                    'version=' + result.version[0])
                assert(result.body.toString() === 'content2',
                    'content=' + result.body.toString())

                res.end('ok')
            })
        })
    }
)

run_test(
    "test that files keep same event ID across restarts when not edited",
    async () => {
        await server_eval(async (req, res) => {
            var test_key = 'test-file'
            var test_content = 'test content that should not change'

            await with_test_instance(async bb => {
                // Put a file with specific version
                await bb.put(test_key, Buffer.from(test_content), {
                    version: ['test-peer-123456']
                })

                // Get the file to verify it has the expected version
                var result1 = await bb.get(test_key)

                // Close the first instance's db
                bb.meta_db.close()

                // Wait a bit to ensure file system has settled
                await new Promise(resolve => setTimeout(resolve, 100))

                // Now create a second braid_blob instance with the same
                // folders. This simulates a restart
                var bb2 = braid_blob.create_braid_blob()
                bb2.db_folder = bb.db_folder
                bb2.meta_folder = bb.meta_folder

                // Initialize bb2 by doing a get (this triggers init)
                var result2 = await bb2.get(test_key)

                // The version should be the same - no new event ID generated
                assert(result1.version[0] === result2.version[0],
                    'v1=' + result1.version[0] + ', v2=' + result2.version[0])
                assert(result1.version[0] === 'test-peer-123456',
                    'v1=' + result1.version[0])

                bb2.meta_db.close()
                res.end('ok')
            })
        })
    }
)

add_section_header("Abort Signal")

run_test(
    "test signal abort stops local put operation",
    async () => {
        await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                // Create an already-aborted signal
                var ac = new AbortController()
                ac.abort()

                // Try to put with aborted signal
                var result = await bb.put('/test-file', Buffer.from('hello'), {
                    signal: ac.signal
                })

                // Result should be undefined since operation was aborted
                assert(result === undefined,
                    'expected put to be aborted, got: ' + result)

                res.end('ok')
            })
        })
    }
)

run_test(
    "test signal abort stops local get operation",
    async () => {
        await server_eval(async (req, res) => {
            var test_id = '/test-abort-get-' + Math.random().toString(36).slice(2)

            // Put a file first
            await braid_blob.put(test_id, 'hello', { version: ['1'] })

            // Create an already-aborted signal
            var ac = new AbortController()
            ac.abort()

            // Try to get with aborted signal
            var result = await braid_blob.get(test_id, {
                signal: ac.signal,
            })

            // Result should be undefined since operation was aborted already
            assert(result === undefined, 'expected get to be aborted')

            res.end('ok')
        })
    }
)

run_test(
    "test signal abort stops local delete operation",
    async () => {
        await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                // Put a file first
                await bb.put('/test-file', Buffer.from('hello'), { version: ['1'] })

                // Create an already-aborted signal
                var ac = new AbortController()
                ac.abort()

                // Try to delete with aborted signal
                await bb.delete('/test-file', { signal: ac.signal })

                // File should still exist since delete was aborted
                var result = await bb.get('/test-file')
                assert(result && result.body,
                    'expected file to still exist after aborted delete')

                res.end('ok')
            })
        })
    }
)

run_test(
    "test signal abort stops subscription updates",
    async () => {
        await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
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
                assert(updates.length === 1 && updates[0] === 'v1',
                    'initial update wrong: ' + JSON.stringify(updates))

                // Abort the subscription
                ac.abort()

                // Put another update
                await bb.put('/test-file', Buffer.from('v2'), { version: ['2'] })

                // Wait a bit for any updates to propagate
                await new Promise(done => setTimeout(done, 50))

                // Should still only have the initial update
                assert(updates.length === 1,
                    'got extra updates: ' + JSON.stringify(updates))

                res.end('ok')
            })
        })
    }
)

add_section_header("Custom DB")

run_test(
    "test options.db in put writes to custom db",
    async () => {
        await server_eval(async (req, res) => {
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
            assert(custom_content && custom_content.toString() === 'custom db content',
                'custom db got: ' + custom_content)

            // Verify content is NOT in the default db
            assert(await braid_blob.db.read(test_key) === null,
                'expected default db to be empty')

            res.end('ok')
        })
    }
)

run_test(
    "test options.db in get reads from custom db",
    async () => {
        await server_eval(async (req, res) => {
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
            assert(result && result.body.toString() === 'from custom db',
                'got: ' + (result ? result.body.toString() : 'null'))

            res.end('ok')
        })
    }
)

run_test(
    "test options.db in delete deletes from custom db",
    async () => {
        await server_eval(async (req, res) => {
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
            assert(await custom_db.read(test_key) === null,
                'expected custom db content to be deleted')

            // Verify default db content still exists
            var default_content = await braid_blob.db.read(test_key)
            assert(default_content && default_content.toString() === 'default content',
                'default db got: ' + default_content)

            res.end('ok')
        })
    }
)

run_test(
    "test options.db in get subscribe uses custom db for initial update",
    async () => {
        await server_eval(async (req, res) => {
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

            assert(received_content === 'subscribe custom content',
                'got: ' + received_content)

            res.end('ok')
        })
    }
)

add_section_header("Atomic Write")

run_test(
    "test atomic write creates temp_folder on init",
    async () => {
        await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                // Initialize
                await bb.init()

                // Check that temp_folder is set to meta_folder (no /temp
                // subdirectory anymore)
                assert(bb.temp_folder === bb.meta_folder,
                    'temp_folder is ' + bb.temp_folder)

                res.end('ok')
            })
        })
    }
)

run_test(
    "test atomic write leaves no temp files after successful write",
    async () => {
        await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                // Do a write
                await bb.put('/test-file', Buffer.from('hello'), { version: ['1'] })

                // Check that no temp_ files remain in temp_folder
                var files = await require('fs').promises.readdir(bb.temp_folder)
                var temp_files = files.filter(f => f.startsWith('temp_'))
                assert(temp_files.length === 0,
                    'leftover files: ' + temp_files.join(', '))

                res.end('ok')
            })
        })
    }
)

run_test(
    "test atomic write data file integrity",
    async () => {
        await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                // Write initial content
                await bb.put('/test-file', Buffer.from('initial content'),
                    { version: ['1'] })

                // Verify we can read it back correctly
                var result = await bb.get('/test-file')
                assert(result.body.toString() === 'initial content',
                    'wrong content: ' + result.body.toString())

                res.end('ok')
            })
        })
    }
)

run_test(
    "test atomic write - multiple rapid writes preserve last value",
    async () => {
        await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                // Do multiple rapid writes
                await bb.put('/test-file', Buffer.from('write1'), { version: ['1'] })
                await bb.put('/test-file', Buffer.from('write2'), { version: ['2'] })
                await bb.put('/test-file', Buffer.from('write3'), { version: ['3'] })

                // Verify last write won
                var result = await bb.get('/test-file')
                assert(result.body.toString() === 'write3',
                    'content=' + result.body.toString())
                assert(result.version[0] === '3', 'version=' + result.version[0])

                // Also verify no temp_ files remain
                var files = await require('fs').promises.readdir(bb.temp_folder)
                var temp_files = files.filter(f => f.startsWith('temp_'))
                assert(temp_files.length === 0,
                    'leftover files: ' + temp_files.join(', '))

                res.end('ok')
            })
        })
    }
)

run_test(
    "test atomic write - meta file is also written atomically",
    async () => {
        await server_eval(async (req, res) => {
            await with_test_instance(async bb => {
                // Write with content_type to test meta file
                await bb.put('/test-file', Buffer.from('content'), {
                    version: ['test-version'],
                    content_type: 'text/plain'
                })

                // Create new instance to read from disk (not cache)
                var bb2 = braid_blob.create_braid_blob()
                bb2.db_folder = bb.db_folder
                bb2.meta_folder = bb.meta_folder

                var result = await bb2.get('/test-file')

                // Verify both version and content_type are correctly persisted
                assert(result.version[0] === 'test-version',
                    'version=' + result.version[0])
                assert(result.content_type === 'text/plain',
                    'content_type=' + result.content_type)

                res.end('ok')
            })
        })
    }
)

add_section_header("Options and Validation")

run_test(
    "test that headers with different casing are normalized correctly",
    async () => {
        // This test verifies that normalize_options correctly lowercases
        // header keys when extracting special headers. Without the fix,
        // "Parents" wouldn't match "parents" in the special keys lookup, so
        // it wouldn't be extracted.
        await server_eval(async (req, res) => {
            var test_key = '/test-header-case-' + Math.random().toString(36).slice(2)

            // Put some content first
            await braid_blob.put(test_key, Buffer.from('v1'), { version: ['1.0'] })

            // Now call get with uppercase "Parents" header key. The parents
            // option affects whether subscribe sends an immediate update: if
            // parents=['1.0'] (same as current version), no update is sent;
            // if parents is not recognized, an update IS sent.
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

            assert(!got_immediate,
                'got an update, meaning the Parents header was not normalized')

            res.end('ok')
        })
    }
)

run_test(
    "test version validation rejects non-array",
    async () => {
        var err = await server_eval(async (req, res) => {
            var test_key = '/test-validate-nonarr-' + Math.random().toString(36).slice(2)
            try {
                await braid_blob.put(test_key, Buffer.from('test'), {
                    version: {not: 'an array'}  // Object instead of array
                })
                res.end('no error')
            } catch (e) {
                res.end(e.message)
            }
        })
        assert(err.includes('not an array'), `expected "not an array" error, got: ${err}`)
    }
)

run_test(
    "test version validation rejects empty array",
    async () => {
        var err = await server_eval(async (req, res) => {
            var test_key = '/test-validate-empty-' + Math.random().toString(36).slice(2)
            try {
                await braid_blob.put(test_key, Buffer.from('test'), {
                    version: []  // Empty array
                })
                res.end('no error')
            } catch (e) {
                res.end(e.message)
            }
        })
        assert(err.includes('must have an event id'),
            `expected "must have an event id" error, got: ${err}`)
    }
)

run_test(
    "test version validation rejects multiple event ids",
    async () => {
        var err = await server_eval(async (req, res) => {
            var test_key = '/test-validate-multi-' + Math.random().toString(36).slice(2)
            try {
                await braid_blob.put(test_key, Buffer.from('test'), {
                    version: ['1', '2']  // Multiple event ids
                })
                res.end('no error')
            } catch (e) {
                res.end(e.message)
            }
        })
        assert(err.includes('only have 1 event id'),
            `expected "only have 1 event id" error, got: ${err}`)
    }
)

run_test(
    "test version validation rejects non-string event id",
    async () => {
        var err = await server_eval(async (req, res) => {
            var test_key = '/test-validate-nonstr-' + Math.random().toString(36).slice(2)
            try {
                await braid_blob.put(test_key, Buffer.from('test'), {
                    version: [123]  // Number instead of string
                })
                res.end('no error')
            } catch (e) {
                res.end(e.message)
            }
        })
        assert(err.includes('must be a string'),
            `expected "must be a string" error, got: ${err}`)
    }
)

run_test(
    "test parents validation rejects non-array",
    async () => {
        var err = await server_eval(async (req, res) => {
            var test_key = '/test-validate-parents-nonarr-' + Math.random().toString(36).slice(2)
            try {
                await braid_blob.put(test_key, Buffer.from('test'), {
                    version: ['1'],
                    parents: {not: 'an array'}  // Object instead of array
                })
                res.end('no error')
            } catch (e) {
                res.end(e.message)
            }
        })
        assert(err.includes('not an array'), `expected "not an array" error, got: ${err}`)
    }
)

run_test(
    "test parents validation rejects multiple event ids",
    async () => {
        var err = await server_eval(async (req, res) => {
            var test_key = '/test-validate-parents-multi-' + Math.random().toString(36).slice(2)
            try {
                await braid_blob.put(test_key, Buffer.from('test'), {
                    version: ['1'],
                    parents: ['0', '1']  // Multiple parent ids
                })
                res.end('no error')
            } catch (e) {
                res.end(e.message)
            }
        })
        assert(err.includes('only have 1 event id'),
            `expected "only have 1 event id" error, got: ${err}`)
    }
)

run_test(
    "test parents validation allows empty array",
    async () => {
        var key = 'test-validate-parents-empty-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {
            method: 'PUT',
            version: ['1'],
            parents: [],  // Empty parents is allowed (min=0)
            body: 'test'
        })
        assert(r.ok, `PUT failed with ${r.status}`)

        var r2 = await braid_fetch(`/${key}`)
        var text = await r2.text()
        assert(text === 'test', `got: ${text}`)
    }
)

run_test(
    "test parents validation rejects non-string event id",
    async () => {
        var err = await server_eval(async (req, res) => {
            var test_key = '/test-validate-parents-nonstr-' + Math.random().toString(36).slice(2)
            try {
                await braid_blob.put(test_key, Buffer.from('test'), {
                    version: ['1'],
                    parents: [123]  // Number instead of string
                })
                res.end('no error')
            } catch (e) {
                res.end(e.message)
            }
        })
        assert(err.includes('must be a string'),
            `expected "must be a string" error, got: ${err}`)
    }
)

run_test(
    "test version string is auto-wrapped in array",
    async () => {
        await server_eval(async (req, res) => {
            var test_key = '/test-validate-string-wrap-' + Math.random().toString(36).slice(2)

            // String version should be auto-wrapped in array
            await braid_blob.put(test_key, Buffer.from('test'), {
                version: 'my-version'
            })
            var result = await braid_blob.get(test_key)
            assert(result.version[0] === 'my-version',
                'wrong version: ' + result.version)

            res.end('ok')
        })
    }
)

run_test(
    "test parents string is auto-wrapped in array",
    async () => {
        await server_eval(async (req, res) => {
            var test_key = '/test-validate-parents-string-wrap-' + Math.random().toString(36).slice(2)

            // Put initial version
            await braid_blob.put(test_key, Buffer.from('v1'), { version: ['1'] })

            // String parents should be auto-wrapped in array
            await braid_blob.put(test_key, Buffer.from('v2'), {
                version: ['2'],
                parents: '1'  // String instead of array
            })
            var result = await braid_blob.get(test_key)
            assert(result.version[0] === '2', 'wrong version: ' + result.version)

            res.end('ok')
        })
    }
)

run_test(
    "test version passed via headers is parsed correctly",
    async () => {
        await server_eval(async (req, res) => {
            var test_key = '/test-version-header-' + Math.random().toString(36).slice(2)

            // Pass version via headers (JSON-encoded as per braid protocol)
            await braid_blob.put(test_key, Buffer.from('test'), {
                headers: { 'Version': '"header-version-123"' }
            })
            var result = await braid_blob.get(test_key)
            assert(result.version[0] === 'header-version-123',
                'wrong version: ' + result.version[0])

            res.end('ok')
        })
    }
)

run_test(
    "test parents passed via headers is parsed correctly",
    async () => {
        await server_eval(async (req, res) => {
            var test_key = '/test-parents-header-' + Math.random().toString(36).slice(2)

            // Put initial version
            await braid_blob.put(test_key, Buffer.from('v1'), { version: ['1'] })

            // Pass parents via headers (JSON-encoded as per braid protocol)
            await braid_blob.put(test_key, Buffer.from('v2'), {
                version: ['2'],
                headers: { 'Parents': '"1"' }
            })
            var result = await braid_blob.get(test_key)
            assert(result.version[0] === '2', 'wrong version: ' + result.version[0])

            res.end('ok')
        })
    }
)

run_test(
    "test version via headers validation rejects multiple event ids",
    async () => {
        var err = await server_eval(async (req, res) => {
            var test_key = '/test-version-header-multi-' + Math.random().toString(36).slice(2)
            try {
                // Pass multiple versions via headers (should fail validation)
                await braid_blob.put(test_key, Buffer.from('test'), {
                    headers: { 'Version': '"v1", "v2"' }
                })
                res.end('no error')
            } catch (e) {
                res.end(e.message)
            }
        })
        assert(err.includes('only have 1 event id'),
            `expected "only have 1 event id" error, got: ${err}`)
    }
)

run_test(
    "test parents via headers validation rejects multiple event ids",
    async () => {
        var err = await server_eval(async (req, res) => {
            var test_key = '/test-parents-header-multi-' + Math.random().toString(36).slice(2)
            try {
                await braid_blob.put(test_key, Buffer.from('test'), {
                    version: ['1'],
                    headers: { 'Parents': '"p1", "p2"' }
                })
                res.end('no error')
            } catch (e) {
                res.end(e.message)
            }
        })
        assert(err.includes('only have 1 event id'),
            `expected "only have 1 event id" error, got: ${err}`)
    }
)

add_section_header("Caching and ETag")

run_test(
    "test that GET sends ETag and Cache-Control: no-cache",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['7'], body: 'abc'})

        var r = await braid_fetch(`/${key}`)
        assert(r.status === 200, `expected 200, got: ${r.status}`)
        assert(r.headers.get('etag') === '"7"', `got etag: ${r.headers.get('etag')}`)
        assert(r.headers.get('cache-control') === 'no-cache',
            `got cache-control: ${r.headers.get('cache-control')}`)
    }
)

run_test(
    "test that matching If-None-Match gets a 304 with no body",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['7'], body: 'abc'})

        var r = await braid_fetch(`/${key}`, {headers: {'If-None-Match': '"7"'}})
        assert(r.status === 304, `expected 304, got: ${r.status}`)
        assert(r.headers.get('etag') === '"7"', `got etag: ${r.headers.get('etag')}`)
        var text = await r.text()
        assert(text === '', `expected empty body, got: ${text}`)
    }
)

run_test(
    "test that non-matching If-None-Match gets the full 200",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['7'], body: 'abc'})

        var r = await braid_fetch(`/${key}`, {headers: {'If-None-Match': '"6"'}})
        assert(r.status === 200, `expected 200, got: ${r.status}`)
        var text = await r.text()
        assert(text === 'abc', `got: ${text}`)
    }
)

run_test(
    "test that If-None-Match matches weak etags and etag lists",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['7'], body: 'abc'})

        var r = await braid_fetch(`/${key}`,
            {headers: {'If-None-Match': 'W/"5", "7"'}})
        assert(r.status === 304, `expected 304, got: ${r.status}`)
    }
)

run_test(
    "test that a 404 wins over If-None-Match",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)

        var r = await braid_fetch(`/${key}`, {headers: {'If-None-Match': '"7"'}})
        assert(r.status === 404, `expected 404, got: ${r.status}`)
    }
)

run_test(
    "test that HEAD supports If-None-Match",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['7'], body: 'abc'})

        var r = await braid_fetch(`/${key}`,
            {method: 'HEAD', headers: {'If-None-Match': '"7"'}})
        assert(r.status === 304, `expected 304, got: ${r.status}`)
    }
)

run_test(
    "test subscribe with matching If-None-Match elides the body into a 304",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['7'], body: 'abc'})

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            headers: {'If-None-Match': '"7"'}
        })
        var got = [], on_update = () => {}
        r.subscribe(u => { got.push(u); on_update() })
        await new Promise(done => { on_update = done; if (got.length) done() })

        // A later update should come through whole
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['8'], body: 'xyz'})
        await new Promise(done => { on_update = done; if (got.length >= 2) done() })

        a.abort()
        assert(r.status === 209, `expected 209, got: ${r.status}`)
        assert(got[0].status === 304, `expected first update 304, got: ${got[0].status}`)
        assert(got[0].extra_headers.etag === '"7"',
            `got etag: ${got[0].extra_headers.etag}`)
        assert(got[0].body_text === '',
            `expected empty first body, got: ${got[0].body_text}`)
        assert(got[1].status === 200, `expected second update 200, got: ${got[1].status}`)
        assert(got[1].body_text === 'xyz', `got second body: ${got[1].body_text}`)
    }
)

run_test(
    "test subscribe with non-matching If-None-Match sends the snapshot",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['7'], body: 'abc'})

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            headers: {'If-None-Match': '"6"'}
        })
        var got = await new Promise(done => r.subscribe(done))

        a.abort()
        assert(got.status === 200, `expected 200, got: ${got.status}`)
        assert(got.body_text === 'abc', `got: ${got.body_text}`)
    }
)

run_test(
    "test subscribe with current parents and If-None-Match stays silent",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['7'], body: 'abc'})

        var a = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            signal: a.signal,
            subscribe: true,
            parents: ['7'],
            headers: {'If-None-Match': '"7"'}
        })
        var got = [], on_update = () => {}
        r.subscribe(u => { got.push(u); on_update() })

        // No initial message; the first thing to arrive is the next update
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['8'], body: 'xyz'})
        await new Promise(done => { on_update = done; if (got.length) done() })

        a.abort()
        assert(got.length === 1, `expected 1 update, got: ${got.length}`)
        assert(got[0].status === 200, `expected 200, got: ${got[0].status}`)
        assert(got[0].body_text === 'xyz', `got: ${got[0].body_text}`)
    }
)

run_test(
    "test that if_none_match makes get() skip the body and disk read",
    async () => {
        await server_eval(async (req, res) => {
            var test_key = '/test-skip-body-' + Math.random().toString(36).slice(2)

            // A db that counts its reads
            var reads = 0
            var storage = {}
            var counting_db = {
                read: async (key) => { reads++; return storage[key] || null },
                write: async (key, data) => { storage[key] = data },
                delete: async (key) => { delete storage[key] }
            }

            await braid_blob.put(test_key, Buffer.from('abc'), {
                version: ['300'],
                db: counting_db
            })

            // The client already has version 300, so no body, no read
            var skipped = await braid_blob.get(test_key, {
                db: counting_db,
                if_none_match: ['300']
            })
            assert(skipped.not_modified === true, 'nm=' + skipped.not_modified)
            assert(skipped.body === undefined, 'body=' + skipped.body)
            assert(reads === 0, 'reads=' + reads)

            // A normal get still reads
            var read = await braid_blob.get(test_key, {db: counting_db})
            assert(read.body.toString() === 'abc', 'got: ' + read.body.toString())
            assert(reads === 1, 'reads=' + reads)

            res.end('ok')
        })
    }
)

run_test(
    "test get with URL supports if_none_match",
    async () => {
        await server_eval(async (req, res) => {
            var test_key = '/test-inm-url-' + Math.random().toString(36).slice(2)
            await braid_blob.put(test_key, Buffer.from('abc'), {version: ['302']})

            var url = new URL('http://localhost:' + port + test_key)
            var hit = await braid_blob.get(url, {
                if_none_match: ['302'], dont_retry: true})
            var miss = await braid_blob.get(url, {
                if_none_match: ['999'], dont_retry: true})

            assert(hit.not_modified === true && hit.body === undefined,
                'hit=' + JSON.stringify(hit))
            assert(!miss.not_modified, 'miss_nm=' + miss.not_modified)
            assert(Buffer.from(miss.body).toString() === 'abc',
                'miss body=' + Buffer.from(miss.body).toString())

            res.end('ok')
        })
    }
)

run_test(
    "test that If-None-Match saves the disk read too",
    async () => {
        // Counts db reads filtered to our own random key, so concurrent
        // tests' traffic can't bump the counter past the asserted 0
        await server_eval(async (req, res) => {
            var test_key = '/test-skip-read-' + Math.random().toString(36).slice(2)
            await braid_blob.put(test_key, Buffer.from('abc'), {version: ['301']})

            // Count reads of our key on the server's db
            var reads = 0
            var real_read = braid_blob.db.read
            braid_blob.db.read = async (key, range) => {
                if (key === test_key) reads++
                return real_read(key, range)
            }
            try {
                // A matching plain GET: 304, and no disk read
                var r = await braid_fetch('http://localhost:' + port + test_key,
                    {headers: {'If-None-Match': '"301"'}})
                assert(r.status === 304, 'status=' + r.status)

                // A matching subscribe: inner 304, and no disk read
                var a = new AbortController()
                var r2 = await braid_fetch('http://localhost:' + port + test_key, {
                    subscribe: true,
                    signal: a.signal,
                    headers: {'If-None-Match': '"301"'}
                })
                var u = await new Promise(done => r2.subscribe(done))
                a.abort()
                assert(u.status === 304, 'u=' + u.status)
                assert(reads === 0, 'reads=' + reads)

                res.end('ok')
            } finally {
                braid_blob.db.read = real_read
            }
        })
    }
)

add_section_header("Range Requests")

// Each test PUTs this 10-byte body, and asks for a slice of it
async function put_alphabet(key) {
    await braid_fetch(`/${key}`, {method: 'PUT', version: ['7'], body: '0123456789'})
}

run_test(
    "test that GET advertises Accept-Ranges: bytes",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await put_alphabet(key)

        var r = await braid_fetch(`/${key}`)
        assert(r.headers.get('accept-ranges') === 'bytes',
            `got accept-ranges: ${r.headers.get('accept-ranges')}`)
    }
)

run_test(
    "test that a Range gets a 206 with Content-Range and just those bytes",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await put_alphabet(key)

        var r = await braid_fetch(`/${key}`, {headers: {Range: 'bytes=2-4'}})
        assert(r.status === 206, `expected 206, got: ${r.status}`)
        assert(r.headers.get('content-range') === 'bytes 2-4/10',
            `got content-range: ${r.headers.get('content-range')}`)
        var text = await r.text()
        assert(text === '234', `got: ${text}`)
    }
)

run_test(
    "test that an open-ended Range reads to the end of the blob",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await put_alphabet(key)

        var r = await braid_fetch(`/${key}`, {headers: {Range: 'bytes=7-'}})
        assert(r.status === 206, `expected 206, got: ${r.status}`)
        assert(r.headers.get('content-range') === 'bytes 7-9/10',
            `got content-range: ${r.headers.get('content-range')}`)
        var text = await r.text()
        assert(text === '789', `got: ${text}`)
    }
)

run_test(
    "test that a suffix Range reads the last bytes of the blob",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await put_alphabet(key)

        var r = await braid_fetch(`/${key}`, {headers: {Range: 'bytes=-3'}})
        assert(r.status === 206, `expected 206, got: ${r.status}`)
        assert(r.headers.get('content-range') === 'bytes 7-9/10',
            `got content-range: ${r.headers.get('content-range')}`)
        var text = await r.text()
        assert(text === '789', `got: ${text}`)
    }
)

run_test(
    "test that a Range past the end of the blob gets a 416",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await put_alphabet(key)

        var r = await braid_fetch(`/${key}`, {headers: {Range: 'bytes=50-60'}})
        assert(r.status === 416, `expected 416, got: ${r.status}`)
        assert(r.headers.get('content-range') === 'bytes */10',
            `got content-range: ${r.headers.get('content-range')}`)
    }
)

run_test(
    "test that a Range we don't support is ignored, sending the whole blob",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await put_alphabet(key)

        // Multiple ranges, and non-byte units, both fall back to a full 200
        for (var range of ['bytes=0-1,5-6', 'items=0-1']) {
            var r = await braid_fetch(`/${key}`, {headers: {Range: range}})
            assert(r.status === 200, `${range}: expected 200, got: ${r.status}`)
            var text = await r.text()
            assert(text === '0123456789', `${range}: got: ${text}`)
        }
    }
)

run_test(
    "test that If-Range honors the Range only while the blob is unchanged",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await put_alphabet(key)

        var r = await braid_fetch(`/${key}`,
            {headers: {Range: 'bytes=2-4', 'If-Range': '"7"'}})
        assert(r.status === 206, `expected 206, got: ${r.status}`)
        assert((await r.text()) === '234', 'wrong slice for a current If-Range')

        // A stale If-Range means the client's copy is out of date, so it
        // wants the whole blob rather than a slice of a different version
        r = await braid_fetch(`/${key}`,
            {headers: {Range: 'bytes=2-4', 'If-Range': '"6"'}})
        assert(r.status === 200, `expected 200, got: ${r.status}`)
        assert((await r.text()) === '0123456789', 'expected the whole blob')
    }
)

run_test(
    "test that HEAD reports the blob's size, so clients know what to ask for",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await put_alphabet(key)

        var r = await braid_fetch(`/${key}`, {method: 'HEAD'})
        assert(r.status === 200, `expected 200, got: ${r.status}`)
        assert(r.headers.get('content-length') === '10',
            `got content-length: ${r.headers.get('content-length')}`)
        assert(r.headers.get('accept-ranges') === 'bytes',
            `got accept-ranges: ${r.headers.get('accept-ranges')}`)
    }
)

run_test(
    "test that a ranged get() only reads the bytes it needs",
    async () => {
        await server_eval(async (req, res) => {
            var test_key = '/test-range-read-' + Math.random().toString(36).slice(2)

            // Our own db: concurrent tests swap the shared braid_blob.db.read
            var stored = Buffer.from('0123456789')
            var asked_for = 'never called'
            var db = {
                read: async (key, offsets) => {
                    asked_for = JSON.stringify(offsets)
                    return offsets
                        ? stored.subarray(offsets.start, offsets.end + 1) : stored
                },
                write: async (key, data) => { stored = Buffer.from(data) },
                delete: async () => { stored = null },
                open: async (key) => ({
                    size: stored.length,
                    stream: (offsets) => require('stream').Readable.from([offsets
                        ? stored.subarray(offsets.start, offsets.end + 1) : stored]),
                    close: async () => {},
                }),
            }
            await braid_blob.put(test_key, Buffer.from('0123456789'),
                {version: ['7'], db})

            var r = await braid_blob.get(test_key,
                {db, range: {unit: 'bytes', range: '2-4'}})
            assert(r.body === undefined, 'a range answers with patches, not a body')
            assert(r.patches.length === 1, 'patches=' + r.patches.length)
            assert(r.patches[0].unit === 'bytes', 'unit=' + r.patches[0].unit)
            assert(r.patches[0].range === '2-4', 'range=' + r.patches[0].range)
            assert(r.patches[0].content.toString() === '234',
                'got: ' + r.patches[0].content.toString())

            // It asked the db for exactly those bytes, not the whole blob
            assert(asked_for === '{"start":2,"end":4}', 'read got range: ' + asked_for)

            // and the whole representation's length rides alongside repr_type
            assert(r.repr_length === 10, 'repr_length=' + r.repr_length)

            res.end('ok')
        })
    }
)

run_test(
    "test that a GET for a version we don't have gets a 432, range or not",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['30'], body: '0123456789'})
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['40'], body: 'abcdefghij'})

        // Any version but the current one is one we don't have
        for (var headers of [
            {Version: '"30"', 'Version-Type': 'wallclockish'},
            {Version: '"30"', 'Version-Type': 'wallclockish', Range: 'bytes=0-4'},
            {Version: '"50"', 'Version-Type': 'wallclockish'},
            {Version: '"50"', 'Version-Type': 'wallclockish', Range: 'bytes=0-4'},
        ]) {
            var r = await braid_fetch(`/${key}`, {headers})
            assert(r.status === 432,
                `${JSON.stringify(headers)}: expected 432, got ${r.status}`)
            assert((await r.text()) === '', 'expected no body on a 432')
            // The 432 echoes back the version it could not satisfy
            assert(r.headers.get('version') === headers.Version,
                `expected Version: ${headers.Version}, got ${r.headers.get('version')}`)

        }

        // The current version is served normally, range and all
        var r = await braid_fetch(`/${key}`,
            {headers: {Version: '"40"', 'Version-Type': 'wallclockish'}})
        assert(r.status === 200, `expected 200, got ${r.status}`)
        assert((await r.text()) === 'abcdefghij', 'wrong body')

        r = await braid_fetch(`/${key}`, {headers:
            {Version: '"40"', 'Version-Type': 'wallclockish', Range: 'bytes=0-4'}})
        assert(r.status === 206, `expected 206, got ${r.status}`)
        assert((await r.text()) === 'abcde', 'wrong slice')
    }
)

run_test(
    "test that a Version on a subscribe GET is a 400",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['30'], body: 'hello'})

        // A 400 even when the version named is the current one
        for (var v of ['"30"', '"99"']) {
            var ac = new AbortController()
            var r = await braid_fetch(`/${key}`, {subscribe: true, signal: ac.signal,
                headers: {Version: v, 'Version-Type': 'wallclockish'}})
            assert(r.status === 400, `Version: ${v}: expected 400, got ${r.status}`)
            ac.abort()
        }

        // Parents is how a subscription says where to start, and still works
        var ac = new AbortController()
        var r = await braid_fetch(`/${key}`, {subscribe: true, signal: ac.signal,
            headers: {Parents: '"20"', 'Version-Type': 'wallclockish'}})
        assert(r.status === 209, `expected 209, got ${r.status}`)
        var u = await new Promise(done => r.subscribe(done, () => {}))
        assert(new TextDecoder().decode(u.body) === 'hello',
            'expected the subscription to deliver the blob')
        ac.abort()
    }
)

run_test(
    "test that a status result says what the status means",
    async () => {
        await server_eval(async (req, res) => {
            var test_key = '/test-status-text-' + Math.random().toString(36).slice(2)
            await braid_blob.put(test_key, Buffer.from('0123456789'), {version: ['40']})

            var unknown = await braid_blob.get(test_key, {version: ['30']})
            assert(unknown.status === 432, 'status=' + unknown.status)
            assert(unknown.status_text === 'Version Not Found',
                'status_text=' + unknown.status_text)
            assert(unknown.version[0] === '30', 'echoed version=' + unknown.version)

            var unsatisfiable = await braid_blob.get(test_key,
                {range: {unit: 'bytes', range: '50-60'}})
            assert(unsatisfiable.status === 416, 'status=' + unsatisfiable.status)
            assert(unsatisfiable.status_text === 'Range Not Satisfiable',
                'status_text=' + unsatisfiable.status_text)
            assert(unsatisfiable.repr_length === 10,
                'repr_length=' + unsatisfiable.repr_length)

            res.end('ok')
        })
    }
)

run_test(
    "test that Parents still means 'I have this', so an old one is fine",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['30'], body: '0123456789'})
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['40'], body: 'abcdefghij'})

        // An older Parents is a client catching up, it must not 432
        var r = await braid_fetch(`/${key}`,
            {headers: {Parents: '"30"', 'Version-Type': 'wallclockish'}})
        assert(r.status === 200, `expected 200, got ${r.status}`)
        assert((await r.text()) === 'abcdefghij', 'wrong body')

        // But parents we've never heard of is still a 432
        r = await braid_fetch(`/${key}`,
            {headers: {Parents: '"50"', 'Version-Type': 'wallclockish'}})
        assert(r.status === 432, `expected 432, got ${r.status}`)
        assert(r.headers.get('parents') === '"50"',
            `expected Parents: "50", got ${r.headers.get('parents')}`)
    }
)

run_test(
    "test that a Version equal but for trailing zeros still matches",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['1.5'], body: 'hello'})

        // Wallclockish versions compare numerically, not as strings
        var r = await braid_fetch(`/${key}`,
            {headers: {Version: '"1.50"', 'Version-Type': 'wallclockish'}})
        assert(r.status === 200, `expected 200, got ${r.status}`)
        assert((await r.text()) === 'hello', 'wrong body')
    }
)

run_test(
    "test that a plain GET streams its body instead of buffering it",
    async () => {
        await server_eval(async (req, res) => {
            var test_key = '/test-stream-' + Math.random().toString(36).slice(2)
            await braid_blob.put(test_key, Buffer.from('0123456789'), {version: ['7']})

            // serve() asks for a stream; a plain get() yields a buffer
            var streamed = await braid_blob.get(test_key, {as_stream: true})
            assert(typeof streamed.body?.pipe === 'function',
                'expected a stream, got: ' + typeof streamed.body)
            assert(streamed.repr_length === 10, 'repr_length=' + streamed.repr_length)

            var chunks = []
            for await (var c of streamed.body) chunks.push(c)
            assert(Buffer.concat(chunks).toString() === '0123456789',
                'got: ' + Buffer.concat(chunks).toString())

            var buffered = await braid_blob.get(test_key)
            assert(Buffer.isBuffer(buffered.body), 'expected a buffer by default')
            assert(buffered.body.toString() === '0123456789',
                'got: ' + buffered.body.toString())

            res.end('ok')
        })
    }
)

run_test(
    "test that rewriting a blob mid-stream doesn't tear the response",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        // Big enough that the response can't be sent in one chunk
        var old_body = 'a'.repeat(4 * 1024 * 1024)
        var new_body = 'b'.repeat(1024)
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['10'], body: old_body})

        var r = await braid_fetch(`/${key}`)
        var promised = +r.headers.get('content-length')
        var version = r.headers.get('etag')

        // Overwrite with a shorter, different body while the read is in flight
        var read = r.text()
        await braid_fetch(`/${key}`, {method: 'PUT', version: ['20'], body: new_body})
        var text = await read

        // Whichever version we were promised, the bytes must match it
        var expected = version === '"10"' ? old_body : new_body
        assert(text.length === promised,
            `body is ${text.length} bytes but Content-Length said ${promised}`)
        assert(text === expected,
            `body doesn't match the ${version} it was served as`)
    }
)

run_test(
    "test that a subscription ignores Range, and streams whole versions",
    async () => {
        var key = 'test-' + Math.random().toString(36).slice(2)
        await put_alphabet(key)

        var updates = []
        var ac = new AbortController()
        var r = await braid_fetch(`/${key}`, {
            subscribe: true, signal: ac.signal, headers: {Range: 'bytes=2-4'}})
        assert(r.status === 209, `expected 209, got: ${r.status}`)
        assert(!r.headers.get('content-range'),
            `got content-range: ${r.headers.get('content-range')}`)
        assert(!r.headers.get('accept-ranges'),
            `got accept-ranges: ${r.headers.get('accept-ranges')}`)

        await new Promise(done => {
            r.subscribe(update => { updates.push(update); done() }, () => {})
        })
        ac.abort()

        var body = new TextDecoder().decode(updates[0].body)
        assert(body === '0123456789', `got: ${body}`)
    }
)

}

// Export for Node.js (CommonJS)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = define_tests
}

// Export for browser (global)
if (typeof window !== 'undefined') {
    window.define_tests = define_tests
}
