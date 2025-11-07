
var port = process.argv[2] || 8889

var braid_blob = require(`${__dirname}/../index.js`)
var {free_cors} = require("braid-http")
braid_blob.db_folder = `${__dirname}/test_db_folder`

var server = require("http").createServer(async (req, res) => {
    console.log(`${req.method} ${req.url}`)

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

    // Now serve the collaborative text!
    braid_blob.serve(req, res)
})

// only listen on 'localhost' for security
server.listen(port, 'localhost', () => {
    console.log(`serving: http://localhost:${port}/test.html`)
})
