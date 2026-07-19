#!/usr/bin/env node

// Unified test runner - can run in console mode (Node.js) or browser mode (server)
var http = require('http')
var {fetch: braid_fetch} = require('braid-http')
var define_tests = require('./tests.js')

// Parse command line arguments
var args = process.argv.slice(2)
var mode = args.includes('--browser') || args.includes('-b') ? 'browser' : 'console'
var port = parseInt(process.env.PORT
    || args.find(arg => arg.startsWith('--port='))?.split('=')[1]
    || args.find(arg => !arg.startsWith('-') && !isNaN(arg))
    || 8889)
var filter_arg = args.find(arg => arg.startsWith('--filter='))?.split('=')[1]
    || args.find(arg => arg.startsWith('--grep='))?.split('=')[1]
var show_hangs = args.includes('--hangs') && require('./show-hangs.js')

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
  --hangs                When a test times out, print what it's stuck waiting on
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

process.on("unhandledRejection", (x) =>
    console.log(`unhandledRejection: ${x?.stack || x}`)
)
process.on("uncaughtException", (x) =>
    console.log(`uncaughtException: ${x.stack}`)
)

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
        run_tests = false,
        log_requests = false
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
        if (log_requests) {
            console.log(`${req.method} ${req.url}`)
        }

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
                // Await the eval'd code, so that a thrown error -- like a
                // failed server-side assert() -- comes back as a 500 whose
                // message fails the test
                await eval(body.toString('utf8'))
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
    // Test tracking
    var total_tests = 0
    var passed_tests = 0
    var failed_tests = 0
    var skipped_tests = 0
    var hung_test = false
    var failed_test_names = []
    var tests_to_run = []

    function add_section_header(header_text) {
        add_section_header.current_section = header_text
    }

    // Collects the tests, to run sequentially below (sequentially so that
    // --hangs can attribute pending promises to the test that created them)
    function run_test(test_name, test_function, expected_result, params) {
        // Apply filter if specified
        if (filter_arg && !test_name.toLowerCase().includes(filter_arg.toLowerCase())) {
            skipped_tests++
            return
        }

        total_tests++
        var section = add_section_header.current_section
        tests_to_run.push({test_name, test_function, expected_result, section, ...params})
    }

    async function run_one_test({test_name, test_function, expected_result,
                                 timeout = 2000}) {
        var timer = null
        try {
            var timed_out = new Promise((_, reject) =>
                timer = setTimeout(() => {
                    hung_test = true
                    if (show_hangs) show_hangs.show()
                    reject(new Error(`Test timed out after ${timeout/1000}s`))
                }, timeout))

            // mark() after creating the timeout promise, so it doesn't
            // itself appear in the report of the test's hung promises
            if (show_hangs) show_hangs.mark()

            var result = await Promise.race([test_function(), timed_out])
            if (expected_result === undefined || result == expected_result) {
                // With no expected_result, this is an assertion-style test:
                // success simply means it returned without throwing. An
                // assert() failure throws and is handled by the catch below.
                passed_tests++
                console.log(`✓ ${test_name}`)
            } else {
                failed_tests++
                failed_test_names.push(test_name)
                console.log(`✗ ${test_name}`)
                console.log(`  Expected: ${expected_result}`)
                console.log(`  Got: ${result}`)
            }
        } catch (error) {
            failed_tests++
            failed_test_names.push(test_name)
            console.log(`✗ ${test_name}`)
            console.log(`  Error: ${error.message || error}`)
        } finally {
            // otherwise a passing test's timer fires later, and with
            // --hangs would print a bogus report during a later test
            clearTimeout(timer)
        }
    }

    console.log('Starting braid-blob tests...\n')

    // Create and start the test server
    var test_server = create_test_server({
        port,
        run_tests: true,
        log_requests: false
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

    // Run tests sequentially
    var current_section = null
    for (var t of tests_to_run) {
        if (t.section && t.section !== current_section) {
            current_section = t.section
            console.log(`\n--- ${current_section} ---`)
        }
        await run_one_test(t)
    }

    // Print summary
    console.log('\n' + '='.repeat(50))
    console.log(`Total: ${total_tests} | ✓: ${passed_tests} | ✗: ${failed_tests}`
        + (skipped_tests ? ` | Skipped: ${skipped_tests}` : ''))
    console.log('='.repeat(50))

    if (failed_test_names.length) {
        console.log('\nFailed tests:')
        for (var name of failed_test_names)
            console.log(`  ✗ ${name}`)

        // Guide the reader to the two debugging tools: narrowing the run
        // to one test, and (for hangs) the pending-promise report
        var suggest_filter = !filter_arg
        var suggest_hangs = hung_test && !show_hangs
        if (suggest_filter || suggest_hangs) {
            console.log(`\nTo debug, rerun a failing test by itself:`)
            console.log(`  node test/test.js`
                + (hung_test ? ' --hangs' : '')
                + ` --filter='${filter_arg || failed_test_names[0]}'`)
            if (suggest_hangs)
                console.log(`  (--hangs prints what a hung test is stuck waiting on)`)
        }
    }

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
    test_server.server.close(() => process.exit(failed_tests > 0 ? 1 : 0))
    if (typeof test_server.server.closeAllConnections === 'function')
        test_server.server.closeAllConnections()

    // Fallback: force exit after a short delay even if the server hasn't
    // fully closed
    setTimeout(() => process.exit(failed_tests > 0 ? 1 : 0), 200)
}

// ============================================================================
// Browser Test Mode (Server)
// ============================================================================

async function run_browser_mode() {
    var test_server = create_test_server({
        port,
        run_tests: false,
        log_requests: true
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
