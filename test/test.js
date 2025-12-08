#!/usr/bin/env node

// Unified test runner - can run in console mode (Node.js) or browser mode (server)
const http = require('http')
const {fetch: braid_fetch} = require('braid-http')
const defineTests = require('./tests.js')

// Parse command line arguments
const args = process.argv.slice(2)
const mode = args.includes('--browser') || args.includes('-b') ? 'browser' : 'console'
const portArg = args.find(arg => arg.startsWith('--port='))?.split('=')[1]
    || args.find(arg => !arg.startsWith('-') && !isNaN(arg))
const port = portArg || 8889
const filterArg = args.find(arg => arg.startsWith('--filter='))?.split('=')[1]
    || args.find(arg => arg.startsWith('--grep='))?.split('=')[1]

// Show help if requested
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node test.js [options]

Options:
  --browser, -b          Start server for browser testing (default: console mode)
  --port=PORT            Specify port number (default: 8889)
  PORT                   Port number as positional argument
  --filter=PATTERN       Only run tests matching pattern (case-insensitive)
  --grep=PATTERN         Alias for --filter
  --help, -h             Show this help message

Examples:
  node test.js                         # Run all tests in console
  node test.js --filter="404"          # Run only tests with "404" in name
  node test.js --grep="peer"           # Run only tests with "peer" in name
  node test.js --browser               # Start browser test server
  node test.js --browser --port=9000
  node test.js -b 9000                # Short form with port
`)
    process.exit(0)
}

// ============================================================================
// Shared Server Code
// ============================================================================

function createTestServer(options = {}) {
    const {
        port = 8889,
        runTests = false,
        logRequests = false
    } = options

    const braid_blob = require(`${__dirname}/../index.js`)
    const {free_cors} = require("braid-http")
    braid_blob.db_folder = `${__dirname}/test_db_folder`
    braid_blob.meta_folder = `${__dirname}/test_meta_folder`

    const server = http.createServer(async (req, res) => {
        if (logRequests) {
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
                eval('' + body)
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'text/plain' })
                res.end(`Error: ${error.message}`)
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

        // Now serve the collaborative text!
        braid_blob.serve(req, res)
    })

    return {
        server,
        start: () => new Promise((resolve) => {
            server.listen(port, 'localhost', () => {
                if (runTests) {
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

async function runConsoleTests() {
    // Test tracking
    let totalTests = 0
    let passedTests = 0
    let failedTests = 0
    const testPromises = []

    // Node.js test runner implementation
    function runTest(testName, testFunction, expectedResult) {
        // Apply filter if specified
        if (filterArg && !testName.toLowerCase().includes(filterArg.toLowerCase())) {
            return // Skip this test
        }

        totalTests++
        const testPromise = (async () => {
            try {
                const result = await testFunction()
                if (result == expectedResult) {
                    passedTests++
                    console.log(`✓ ${testName}`)
                } else {
                    failedTests++
                    console.log(`✗ ${testName}`)
                    console.log(`  Expected: ${expectedResult}`)
                    console.log(`  Got: ${result}`)
                }
            } catch (error) {
                failedTests++
                console.log(`✗ ${testName}`)
                console.log(`  Error: ${error.message || error}`)
            }
        })()
        testPromises.push(testPromise)
    }

    // Create a braid_fetch wrapper that points to localhost
    function createBraidFetch(baseUrl) {
        return async (url, options = {}) => {
            const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`
            return braid_fetch(fullUrl, options)
        }
    }

    console.log('Starting braid-blob tests...\n')

    // Create and start the test server
    const testServer = createTestServer({
        port,
        runTests: true,
        logRequests: false
    })

    await testServer.start()

    // Create braid_fetch bound to test server
    const testBraidFetch = createBraidFetch(`http://localhost:${port}`)

    // Run all tests
    defineTests(runTest, testBraidFetch)

    // Wait for all tests to complete
    await Promise.all(testPromises)

    // Print summary
    console.log('\n' + '='.repeat(50))
    console.log(`Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`)
    console.log('='.repeat(50))

    // Clean up test directories
    console.log('Cleaning up test directories...')
    const fs = require('fs').promises
    const path = require('path')

    try {
        // Clean up main test folders
        await fs.rm(path.join(__dirname, 'test_db_folder'), { recursive: true, force: true })
        await fs.rm(path.join(__dirname, 'test_meta_folder'), { recursive: true, force: true })

        // Clean up any leftover test-* directories
        const entries = await fs.readdir(__dirname)
        for (const entry of entries) {
            if ((entry.startsWith('test-') && entry.includes('-db')) ||
                (entry.startsWith('test-') && entry.includes('-meta'))) {
                await fs.rm(path.join(__dirname, entry), { recursive: true, force: true })
            }
        }
    } catch (e) {
        // Ignore cleanup errors
    }

    // Force close the server and all connections
    console.log('Closing server...')
    testServer.server.close(() => {
        console.log('Server closed callback - calling process.exit()')
        process.exit(failedTests > 0 ? 1 : 0)
    })

    // Also close all active connections if the method exists (Node 18.2+)
    if (typeof testServer.server.closeAllConnections === 'function') {
        console.log('Closing all connections...')
        testServer.server.closeAllConnections()
    }

    // Fallback: force exit after a short delay even if server hasn't fully closed
    console.log('Setting 200ms timeout fallback...')
    setTimeout(() => {
        console.log('Timeout reached - calling process.exit()')
        process.exit(failedTests > 0 ? 1 : 0)
    }, 200)
}

// ============================================================================
// Browser Test Mode (Server)
// ============================================================================

async function runBrowserMode() {
    const testServer = createTestServer({
        port,
        runTests: false,
        logRequests: true
    })

    await testServer.start()
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
    if (mode === 'browser') {
        await runBrowserMode()
    } else {
        await runConsoleTests()
    }
}

// Run the appropriate mode
main().catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
})
