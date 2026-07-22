#!/usr/bin/env node

// Unified test runner - can run in console mode (Node.js) or browser mode (server)
var http = require('http')
var {fetch: braid_fetch} = require('braid-http')
var define_tests = require('./tests.js')

// The shared runner (braid-http/run-tests) parses --filter/--serial/
// --in-parallel/--hangs, runs the pool, and prints the reports; this file
// hosts it: the braid-blob server, the fetch wrapper, and browser mode
var runner = require('braid-http/run-tests')({
    braid_fetch,
    rerun_command: 'node test/test.js'
})
var { run_test, add_section_header, log, claim_request, test_context } = runner

// Parse command line arguments
var args = process.argv.slice(2)
var mode = args.includes('--browser') || args.includes('-b') ? 'browser' : 'console'
var port = parseInt(process.env.PORT
    || args.find(arg => arg.startsWith('--port='))?.split('=')[1]
    || args.find(arg => !arg.startsWith('-') && !isNaN(arg))
    || 8889)

// Show help if requested
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node test/test.js [options]

Options:
  --browser, -b          Start server for browser testing (default: console mode)
  --port=PORT            Specify port number (default: 8889). Or set PORT env.
  PORT                   Port number as positional argument
  --filter=PATTERN       Only run tests matching pattern (case-insensitive)
  --grep=PATTERN         Alias for --filter
  --in-parallel=N        Run up to N tests at once (default 16)
  --serial               Run tests one at a time
  --hangs                When a test times out, print what it's stuck waiting on (implies --serial)
  --help, -h             Show this help message

Examples:
  node test/test.js                         # Run all tests in console
  node test/test.js --filter="404"          # Run only tests with "404" in name
  node test/test.js --grep="peer"           # Run only tests with "peer" in name
  node test/test.js --browser               # Start browser test server
  node test/test.js --browser --port=9000
  node test/test.js -b 9000                 # Short form with port
`)
    process.exit(0)
}

// Tests assert() inline instead of returning values to compare. This lives at
// module scope so that code the tests server_eval() can assert too -- eval'd
// code runs in this module's scope, and a failed server-side assert comes
// back to the test as a 500 with this error's message.
function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed')
}

// ============================================================================
// Shared Server Code
// ============================================================================

function create_test_server(options = {}) {
    var {
        port = 8889,
        run_tests = false
    } = options

    var braid_blob = require(`${__dirname}/../index.js`)
    var {free_cors} = require("braid-http")
    braid_blob.db_folder = `${__dirname}/test_db_folder`
    braid_blob.meta_folder = `${__dirname}/test_meta_folder`

    // Makes a fresh braid_blob instance in its own random temp folders, runs
    // await fn(bb), then closes and removes them. Eval'd test code calls this
    // for the common instance-lifecycle boilerplate.
    async function with_test_instance(fn) {
        var fs = require('fs').promises
        var test_id = 'test-' + Math.random().toString(36).slice(2)
        var bb = braid_blob.create_braid_blob()
        bb.db_folder = `${__dirname}/${test_id}-db`
        bb.meta_folder = `${__dirname}/${test_id}-meta`
        try {
            return await fn(bb)
        } finally {
            try { bb.meta_db?.close() } catch (e) {}
            await fs.rm(bb.db_folder, { recursive: true, force: true })
            await fs.rm(bb.meta_folder, { recursive: true, force: true })
        }
    }

    var server = http.createServer(async (req, res) => {
        claim_request(req)
        log(req)

        // Free the CORS
        free_cors(res)
        if (req.method === 'OPTIONS') return

        if (req.url.startsWith('/eval')) {
            var body = await new Promise(done => {
                var chunks = []
                req.on('data', chunk => chunks.push(chunk))
                req.on('end', () => done(Buffer.concat(chunks)))
            })
            try {
                // Await the eval'd code -- inside the requesting test's
                // context, so anything it logs files under that test -- and
                // a thrown error (like a failed server-side assert()) comes
                // back as a 500 whose message fails the test
                await test_context.run(req.test_report,
                    () => eval(body.toString('utf8')))
            } catch (error) {
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' })
                    res.end(`Error: ${error.message}`)
                }
            }
            return
        }

        if (req.url.startsWith('/test.html')) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" })
            require("fs").createReadStream(`${__dirname}/test.html`).pipe(res)
            return
        }

        // Serve tests.js file for browser
        if (req.url.startsWith('/tests.js')) {
            res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" })
            require("fs").createReadStream(`${__dirname}/tests.js`).pipe(res)
            return
        }

        // Serve the local braid-http client for browser tests, so they
        // exercise the same client version the node tests use (rather than a
        // published copy from unpkg)
        if (req.url.startsWith('/braid-http-client.js')) {
            res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" })
            require("fs").createReadStream(`${require('path').dirname(require.resolve('braid-http'))}/braid-http-client.js`).pipe(res)
            return
        }

        // Now serve the collaborative blobs!
        braid_blob.serve(req, res)
    })

    return {
        server,
        start: () => new Promise((resolve) => {
            server.listen(port, 'localhost', () => {
                if (run_tests) {
                    console.log(`Test server running on http://localhost:${port}`)
                } else {
                    console.log(`serving: http://localhost:${port}/test.html`)
                }
                resolve()
            })
        }),
        port
    }
}

// ============================================================================
// Console Test Mode (Node.js)
// ============================================================================

async function run_console_tests() {
    console.log('Starting braid-blob tests...\n')

    // Create and start the test server
    var test_server = create_test_server({
        port,
        run_tests: true
    })

    await test_server.start()

    // A braid_fetch that resolves urls against the test server
    var wrapped_braid_fetch = (url, options = {}) =>
        braid_fetch(url.startsWith('http') ? url : `http://localhost:${port}${url}`,
            options)

    // Define all tests
    define_tests(run_test, {
        braid_fetch: wrapped_braid_fetch,
        assert,
        add_section_header,
        port,
        base_url: `http://localhost:${port}`
    })

    var failed = await runner.run()

    // Clean up test directories
    console.log('\nCleaning up test directories...')
    var fs = require('fs').promises
    var path = require('path')

    try {
        // Clean up main test folders
        await fs.rm(path.join(__dirname, 'test_db_folder'), { recursive: true, force: true })
        await fs.rm(path.join(__dirname, 'test_meta_folder'), { recursive: true, force: true })

        // Clean up any leftover test-* directories
        var entries = await fs.readdir(__dirname)
        for (var entry of entries) {
            if ((entry.startsWith('test-') && entry.includes('-db')) ||
                (entry.startsWith('test-') && entry.includes('-meta'))) {
                await fs.rm(path.join(__dirname, entry), { recursive: true, force: true })
            }
        }
    } catch (e) {
        // Ignore cleanup errors
    }

    // Close the server and all its connections
    test_server.server.close(() => process.exit(failed > 0 ? 1 : 0))
    if (typeof test_server.server.closeAllConnections === 'function')
        test_server.server.closeAllConnections()

    // Fallback: force exit after a short delay even if the server hasn't
    // fully closed
    setTimeout(() => process.exit(failed > 0 ? 1 : 0), 200)
}

// ============================================================================
// Browser Test Mode (Server)
// ============================================================================

async function run_browser_mode() {
    var test_server = create_test_server({
        port,
        run_tests: false
    })

    await test_server.start()
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
    if (mode === 'browser') {
        await run_browser_mode()
    } else {
        await run_console_tests()
    }
}

// Run the appropriate mode
main().catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
})
